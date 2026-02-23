/**
 * server/api/activities.js — Global Activity Log
 *
 * Records and retrieves all important user activities:
 *   - login, deposit, redeem, harvest, approve
 *   - escrow_deposit, escrow_register, claim
 *   - plan_created, plan_distributed, trigger_initiated
 *
 * GET  /api/activities/:address  — list activities for a wallet (auth required)
 * POST /api/activities           — client reports a completed activity (auth required)
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../middleware/auth');
const db = require('../db');

const router = Router();

// ─── Helpers ───

function isValidAddress(addr) {
  return typeof addr === 'string' && /^[0-9a-fA-F]{40,64}$/.test(addr.replace(/^0x/i, ''));
}

function normalizeAddr(addr) {
  return addr.replace(/^0x/i, '').toLowerCase();
}

/**
 * Record an activity. Can be called from any server module.
 * @param {string} walletAddress - user wallet address
 * @param {string} type - activity type (login, deposit, redeem, harvest, etc.)
 * @param {object} data - { amount?, shares?, asset?, chain_id?, tx_hash?, status?, detail? }
 */
async function recordActivity(walletAddress, type, data = {}) {
  const id = crypto.randomUUID();
  const record = {
    id,
    wallet: normalizeAddr(walletAddress),
    type,
    amount: data.amount || null,
    shares: data.shares || null,
    asset: data.asset || null,
    chain_id: data.chain_id || null,
    tx_hash: data.tx_hash || null,
    status: data.status || 'confirmed',
    detail: data.detail || null,
    created_at: Date.now(),
  };
  await db.activities.create(id, record);
  return record;
}

// ─── GET /:address ───

router.get('/:address', dualAuthMiddleware, async (req, res) => {
  const { address } = req.params;
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Valid address is required' });
  }
  const normalized = normalizeAddr(address);
  if (req.auth.pubkey !== normalized) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const all = await db.activities.findByField('wallet', normalized);
    all.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    res.json({ activities: all.slice(0, 200) });
  } catch (err) {
    console.error('[activities] list error:', err.message);
    res.json({ activities: [] });
  }
});

// ─── POST / ─── (client reports tx hash after sending)

router.post('/', dualAuthMiddleware, async (req, res) => {
  const { address, type, amount, shares, tx_hash, status, asset, chain_id, detail } = req.body || {};
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Valid address is required' });
  }
  const normalized = normalizeAddr(address);
  if (req.auth.pubkey !== normalized) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  try {
    const record = await recordActivity(normalized, type, {
      amount, shares, tx_hash, asset, chain_id, detail,
      status: status || 'confirmed',
    });
    res.json({ ok: true, activity: record });
  } catch (err) {
    console.error('[activities] record error:', err.message);
    res.status(500).json({ error: 'Failed to record activity' });
  }
});

module.exports = router;
module.exports.recordActivity = recordActivity;
