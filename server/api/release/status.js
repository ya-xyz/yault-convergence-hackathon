/**
 * GET /api/release/status/:wallet_id
 *
 * Requires auth. Caller may only query their own wallet_id (ownership check).
 * Used by the client-portal to show bound firms on the Release page.
 *
 * Returns: { configured, firms: [{ id, name, jurisdiction, release_model, recipient_count }] }
 */

'use strict';

const { Router } = require('express');
const db = require('../../db');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

router.get('/:wallet_id', async (req, res) => {
  try {
    const { wallet_id } = req.params;
    if (!wallet_id) {
      return res.status(400).json({ error: 'wallet_id is required' });
    }

    // Security: only the wallet owner can view release status for that wallet
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (normalizeAddr(req.auth.pubkey) !== normalizeAddr(wallet_id)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view release status for your own wallet',
      });
    }

    // #8 FIX: Use findByWallet instead of findAll() + filter for better performance
    const walletBindingsAll = await db.bindings.findByWallet(wallet_id);
    const walletBindings = walletBindingsAll.filter(b => b.status === 'active');

    if (walletBindings.length === 0) {
      return res.json({ configured: false, firms: [] });
    }

    // Enrich with authority info
    const firms = [];
    for (const b of walletBindings) {
      let name = b.authority_id;
      let jurisdiction = '';
      let verified = false;
      try {
        const authority = await db.authorities.findById(b.authority_id);
        if (authority) {
          name = authority.name || authority.authority_id;
          jurisdiction = authority.jurisdiction || '';
          verified = !!authority.verified;
        }
      } catch (err) { console.warn('[release/status] Non-fatal: authority lookup failed:', err.message); }

      firms.push({
        id: b.authority_id,
        name,
        jurisdiction,
        verified,
        release_model: b.release_model || 'per-path',
        recipient_indices: b.recipient_indices || [],
        recipient_count: (b.recipient_indices || []).length,
      });
    }

    return res.json({ configured: true, firms });
  } catch (err) {
    console.error('[release/status] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
