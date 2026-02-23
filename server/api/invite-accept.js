/**
 * Public invite flow: validate token (no auth) and accept (auth).
 *
 * GET  /api/invite/validate?token=<uuid> — returns { email, label, valid } or 404 (public).
 * POST /api/invite/accept — body { token }, requires auth. Links current user as inviter's sub-account.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../middleware/auth');
const { SubAccount } = require('../models/schemas');
const db = require('../db');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** GET /api/invite/validate?token= — public; returns invite email/label if pending */
router.get('/validate', (req, res, next) => {
  const token = (req.query.token || '').trim();
  if (!token || !UUID_REGEX.test(token)) {
    return res.status(400).json({ error: 'Invalid or missing token' });
  }
  req.inviteToken = token;
  next();
}, async (req, res) => {
  try {
    const invite = await db.accountInvites.findById(req.inviteToken);
    if (!invite || (invite.status || '') !== 'pending') {
      return res.status(404).json({ error: 'Invite not found or already used' });
    }
    return res.json({
      email: invite.email,
      label: invite.label || invite.email?.split('@')[0] || '',
      valid: true,
    });
  } catch (err) {
    console.error('[invite-accept] GET validate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /api/invite/accept — requires auth; current user becomes inviter's sub-account */
router.post('/accept', dualAuthMiddleware, async (req, res) => {
  try {
    const inviteeWallet = normalizeAddr(req.auth.pubkey);
    if (!inviteeWallet) return res.status(401).json({ error: 'Authentication required' });

    const token = (req.body?.token || '').trim();
    if (!token || !UUID_REGEX.test(token)) {
      return res.status(400).json({ error: 'Invalid or missing token' });
    }

    const invite = await db.accountInvites.findById(token);
    if (!invite || (invite.status || '') !== 'pending') {
      return res.status(400).json({ error: 'Invite not found or already used' });
    }

    const inviterWallet = normalizeAddr(invite.owner_wallet_id);
    if (!inviterWallet) {
      return res.status(500).json({ error: 'Invalid invite data' });
    }
    if (inviterWallet === inviteeWallet) {
      return res.status(400).json({ error: 'You cannot accept your own invite' });
    }

    const now = new Date().toISOString();
    const updatedInvite = {
      ...invite,
      status: 'accepted',
      linked_wallet_address: req.auth.pubkey?.startsWith('0x') ? req.auth.pubkey : '0x' + inviteeWallet,
      updated_at: now,
    };
    await db.accountInvites.update(token, updatedInvite);

    // Always track referral relationship (regardless of sub-account flag)
    try {
      const referralId = crypto.randomBytes(16).toString('hex');
      await db.referrals.create(referralId, {
        referrer_wallet_id: inviterWallet,
        invitee_wallet_id: inviteeWallet,
        invite_id: token,
        created_at: now,
      });
    } catch (refErr) {
      console.warn('[invite-accept] Failed to create referral record:', refErr.message);
    }

    // Update invitee user record with referrer
    try {
      const existingUser = await db.users.findById(inviteeWallet);
      if (existingUser && !existingUser.referrer_wallet_id) {
        await db.users.update(inviteeWallet, {
          ...existingUser,
          referrer_wallet_id: inviterWallet,
          updated_at: now,
        });
      }
    } catch (_) { /* best-effort */ }

    // Only create sub-account if the invite was flagged as sub-account by the inviter
    if (invite.is_sub_account) {
      const existingMembers = await db.subAccounts.findByParent(inviterWallet);
      const alreadyMember = existingMembers.some((m) => normalizeAddr(m.member_wallet_id) === inviteeWallet);
      if (!alreadyMember) {
        const label = invite.label || invite.email || 'Accepted invite';
        const subPayload = {
          parent_wallet_id: inviterWallet,
          member_wallet_id: inviteeWallet,
          label,
          account_type: 'family',
          role: 'sub_account',
        };
        const validation = SubAccount.validate(subPayload);
        if (!validation.valid) {
          return res.status(400).json({ error: 'Validation failed', details: validation.errors });
        }
        const memberId = crypto.randomBytes(16).toString('hex');
        const memberRecord = { ...validation.data, member_id: memberId };
        await db.subAccounts.create(memberId, memberRecord);
      }
    }

    return res.json({
      ok: true,
      message: invite.is_sub_account
        ? 'Invite accepted. You are now linked as a sub-account.'
        : 'Invite accepted. Welcome to Yault!',
    });
  } catch (err) {
    console.error('[invite-accept] POST accept error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
