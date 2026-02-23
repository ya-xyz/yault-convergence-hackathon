/**
 * GET  /api/me/profile — Current logged-in user profile (Client)
 * PATCH /api/me/profile — Update current user profile, body: { name?, email?, phone?, physical_address? }
 */

'use strict';

const { Router } = require('express');
const { dualAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

const PROFILE_FIELDS = ['name', 'email', 'phone', 'physical_address'];

/** GET / — Get current user profile */
router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const user = await db.users.findById(walletId);
    if (!user) {
      return res.json({ address: walletId, name: '', email: '', phone: '', physical_address: '' });
    }
    const out = { address: user.wallet_id || walletId };
    for (const k of PROFILE_FIELDS) {
      out[k] = user[k] != null ? user[k] : '';
    }
    return res.json(out);
  } catch (err) {
    console.error('[me/profile] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PATCH / — Update current user profile */
router.patch('/', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const body = req.body || {};
    let user = await db.users.findById(walletId);
    const now = new Date().toISOString();
    if (!user) {
      user = { wallet_id: walletId, created_at: now, updated_at: now };
      for (const k of PROFILE_FIELDS) user[k] = body[k] !== undefined ? (body[k] || '') : '';
      await db.users.create(walletId, user);
    } else {
      const updated = { ...user, updated_at: now };
      for (const k of PROFILE_FIELDS) {
        if (body[k] !== undefined) updated[k] = body[k] == null ? '' : String(body[k]).trim();
      }
      await db.users.update(walletId, updated);
      user = updated;
    }
    const out = { address: user.wallet_id || walletId };
    for (const k of PROFILE_FIELDS) out[k] = user[k] != null ? user[k] : '';
    return res.json(out);
  } catch (err) {
    console.error('[me/profile] PATCH error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
