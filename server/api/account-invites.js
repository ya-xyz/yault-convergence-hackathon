/**
 * Account Invites API — persist client-portal invitations and related accounts.
 *
 * GET    /           - List all invites for the authenticated wallet (pending + accepted)
 * POST   /           - Create invite (body: { email, label? })
 * PUT    /:id/accept - Accept invite (body: { label? }), sets status to 'accepted'
 * DELETE /:id       - Remove invite/link
 *
 * Table: accountInvites. Each row: id (uuid), data: { owner_wallet_id, email, label?, status, linked_wallet_address?, created_at, updated_at }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const config = require('../config');
const { dualAuthMiddleware } = require('../middleware/auth');
const db = require('../db');
const { sendInviteEmail } = require('../services/email');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/** GET / — list invites for authenticated wallet */
router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const owner = normalizeAddr(req.auth.pubkey);
    if (!owner) return res.status(401).json({ error: 'Authentication required' });
    const list = await db.accountInvites.findByOwner(owner);
    return res.json({ invites: list });
  } catch (err) {
    console.error('[account-invites] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST / — create invite */
router.post('/', dualAuthMiddleware, async (req, res) => {
  try {
    const owner = normalizeAddr(req.auth.pubkey);
    if (!owner) return res.status(401).json({ error: 'Authentication required' });
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    const label = (req.body?.label || email.split('@')[0] || email).trim();
    const isSubAccount = req.body?.is_sub_account === true;

    const existing = await db.accountInvites.findByOwner(owner);
    if (existing.some((i) => i.email === email)) {
      return res.status(409).json({ error: 'This email is already invited or linked' });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      owner_wallet_id: owner,
      email,
      label,
      is_sub_account: isSubAccount,
      status: 'pending',
      linked_wallet_address: null,
      created_at: now,
      updated_at: now,
    };
    await db.accountInvites.create(id, record);

    const baseUrl = (config.publicBaseUrl || '').replace(/\/$/, '');
    const inviteLink = baseUrl ? `${baseUrl}/accept-invite.html?token=${id}` : null;
    if (inviteLink) {
      console.log('[account-invites] Invite created (' + (isSubAccount ? 'sub-account' : 'referral') + '). Link:');
      console.log('  ' + inviteLink);
    }
    // Send invite email (non-blocking)
    sendInviteEmail(email, label, inviteLink).catch((err) => {
      console.error('[account-invites] Failed to send invite email:', err.message);
    });
    return res.status(201).json(record);
  } catch (err) {
    console.error('[account-invites] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT /:id/accept — accept invite (demo: set status to accepted) */
router.put('/:id/accept', dualAuthMiddleware, async (req, res) => {
  try {
    const owner = normalizeAddr(req.auth.pubkey);
    if (!owner) return res.status(401).json({ error: 'Authentication required' });
    const { id } = req.params;
    const label = (req.body?.label || '').trim();

    const existing = await db.accountInvites.findById(id);
    if (!existing) return res.status(404).json({ error: 'Invite not found' });
    if (normalizeAddr(existing.owner_wallet_id) !== owner) {
      return res.status(403).json({ error: 'You can only accept invites for your own list' });
    }

    const updated = {
      ...existing,
      status: 'accepted',
      updated_at: new Date().toISOString(),
    };
    if (label) updated.label = label;
    await db.accountInvites.update(id, updated);
    return res.json(updated);
  } catch (err) {
    console.error('[account-invites] PUT accept error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** DELETE /:id — remove invite/link */
router.delete('/:id', dualAuthMiddleware, async (req, res) => {
  try {
    const owner = normalizeAddr(req.auth.pubkey);
    if (!owner) return res.status(401).json({ error: 'Authentication required' });
    const { id } = req.params;

    const existing = await db.accountInvites.findById(id);
    if (!existing) return res.status(404).json({ error: 'Invite not found' });
    if (normalizeAddr(existing.owner_wallet_id) !== owner) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.accountInvites.delete(id);
    return res.status(204).send();
  } catch (err) {
    console.error('[account-invites] DELETE error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
