/**
 * GET /api/revenue/user/:walletId
 *
 * User vault revenue breakdown.
 * Shows gross yield, net yield after fees, and itemized fee splits.
 *
 * Params: :walletId - user wallet ID
 * Returns: { wallet_id, vault_balance, gross_yield, net_yield, platform_fee, authority_fee, records[] }
 */

'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middleware/auth');
const config = require('../../config');
const db = require('../../db');

const router = Router();

/**
 * @route GET /:walletId
 * @description Get vault revenue breakdown for a user.
 */
router.get('/:walletId', authMiddleware, async (req, res) => {
  try {
    const { walletId } = req.params;

    // Verify the authenticated authority has a binding with this wallet
    const bindings = await db.bindings.findByAuthority(req.auth.authority_id);
    const hasAccess = bindings.some(
      (b) => b.wallet_id === walletId && b.status === 'active'
    );
    if (!hasAccess) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You do not have an active binding with this wallet',
      });
    }

    // Fetch all revenue records for this wallet
    const records = await db.revenue.findByWallet(walletId);

    if (records.length === 0) {
      return res.json({
        wallet_id: walletId,
        vault_balance: 0,
        gross_yield: 0,
        net_yield: 0,
        platform_fee: 0,
        authority_fee: 0,
        records: [],
      });
    }

    let grossYield = 0;
    let netYield = 0;
    let platformFee = 0;
    let authorityFee = 0;

    const summaryRecords = records.map((rec) => {
      grossYield += rec.gross_yield || 0;
      netYield += rec.user_share || 0;
      platformFee += rec.platform_share || 0;
      authorityFee += rec.authority_share || 0;

      return {
        record_id: rec.record_id,
        gross_yield: rec.gross_yield,
        user_share: rec.user_share,
        platform_share: rec.platform_share,
        authority_share: rec.authority_share,
        authority_id: rec.authority_id,
        period_start: rec.period_start,
        period_end: rec.period_end,
        status: rec.status,
        created_at: rec.created_at,
      };
    });

    // Sort by period_end descending
    summaryRecords.sort((a, b) => (b.period_end || 0) - (a.period_end || 0));

    return res.json({
      wallet_id: walletId,
      vault_balance: Math.round(netYield * 1e8) / 1e8,
      gross_yield: Math.round(grossYield * 1e8) / 1e8,
      net_yield: Math.round(netYield * 1e8) / 1e8,
      platform_fee: Math.round(platformFee * 1e8) / 1e8,
      authority_fee: Math.round(authorityFee * 1e8) / 1e8,
      split_config: {
        user_bps: config.revenue.userShareBps,
        platform_bps: config.revenue.platformShareBps,
        authority_bps: config.revenue.authorityShareBps,
      },
      records: summaryRecords,
    });
  } catch (err) {
    console.error('[revenue/user] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
