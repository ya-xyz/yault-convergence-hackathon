/**
 * GET /api/revenue/authority/:id
 *
 * Revenue summary for an authority.
 * Shows accumulated, pending, and withdrawn amounts broken down by client.
 *
 * Params: :id - authority_id
 * Returns: { total, pending, withdrawn, by_client[] }
 */

'use strict';

const { Router } = require('express');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

/**
 * @route GET /:id
 * @description Get revenue summary for an authority.
 */
router.get('/:id', authorityAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure the authenticated authority can only view their own revenue
    if (req.auth.authority_id !== id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view your own revenue',
      });
    }

    // Verify the authority exists
    const authority = await db.authorities.findById(id);
    if (!authority) {
      return res.status(404).json({
        error: 'Not found',
        detail: `Authority with id ${id} not found`,
      });
    }

    // Fetch all revenue records for this authority
    const records = await db.revenue.findByAuthority(id);

    // Aggregate totals
    let total = 0;
    let pending = 0;
    let withdrawn = 0;

    /** @type {Map<string, { wallet_id: string, total: number, pending: number, withdrawn: number, records: number }>} */
    const byClientMap = new Map();

    for (const rec of records) {
      const share = rec.authority_share || 0;
      total += share;

      if (rec.status === 'withdrawn') {
        withdrawn += share;
      } else {
        pending += share;
      }

      // Group by client wallet
      const existing = byClientMap.get(rec.wallet_id) || {
        wallet_id: rec.wallet_id,
        total: 0,
        pending: 0,
        withdrawn: 0,
        records: 0,
      };
      existing.total += share;
      if (rec.status === 'withdrawn') {
        existing.withdrawn += share;
      } else {
        existing.pending += share;
      }
      existing.records += 1;
      byClientMap.set(rec.wallet_id, existing);
    }

    const byClient = Array.from(byClientMap.values());

    return res.json({
      authority_id: id,
      total: Math.round(total * 1e8) / 1e8, // avoid floating point drift
      pending: Math.round(pending * 1e8) / 1e8,
      withdrawn: Math.round(withdrawn * 1e8) / 1e8,
      by_client: byClient,
    });
  } catch (err) {
    console.error('[revenue/authority] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
