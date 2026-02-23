/**
 * Sub-Accounts / Members API
 *
 * Unified endpoint for managing sub-accounts — works for both personal
 * (family) and institutional (corporate / DAO) use cases.
 *
 * POST   /              - Add a member (sub-account)
 * GET    /              - List members for the authenticated wallet
 * PUT    /:id           - Update member permissions / status
 * DELETE /:id           - Remove a member (soft delete)
 * GET    /parent        - Check if the authenticated wallet is a sub-account
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../../middleware/auth');
const { SubAccount } = require('../../models/schemas');
const db = require('../../db');

const router = Router();

/**
 * @route POST /
 * @description Add a sub-account member.
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;

    const payload = {
      ...req.body,
      parent_wallet_id: callerAddress,
    };

    const validation = SubAccount.validate(payload);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
      });
    }

    const memberData = validation.data;

    // Prevent adding self
    if (memberData.member_wallet_id === callerAddress) {
      return res.status(400).json({
        error: 'Cannot add your own wallet as a sub-account',
      });
    }

    // Check for duplicate (same parent + same member wallet)
    if (memberData.member_wallet_id) {
      const existing = await db.subAccounts.findByParent(callerAddress);
      const dup = existing.find(
        (m) => m.member_wallet_id === memberData.member_wallet_id
      );
      if (dup) {
        return res.status(409).json({
          error: 'Duplicate member',
          detail: 'This wallet is already linked as a sub-account',
        });
      }
    }

    const memberId = crypto.randomBytes(16).toString('hex');
    const record = {
      ...memberData,
      member_id: memberId,
    };

    await db.subAccounts.create(memberId, record);

    // Audit log
    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'sub_account_added',
      parent_wallet_id: callerAddress,
      member_id: memberId,
      role: memberData.role,
      account_type: memberData.account_type,
      timestamp: Date.now(),
    });

    return res.status(201).json({
      member_id: memberId,
      status: 'active',
      label: memberData.label,
      role: memberData.role,
    });
  } catch (err) {
    console.error('[accounts/members] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /
 * @description List sub-account members for the authenticated wallet (as parent).
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;
    const members = await db.subAccounts.findByParent(callerAddress);

    // Enrich with allowance totals
    const enriched = await Promise.all(members.map(async (m) => {
      if (!m.member_wallet_id) return { ...m, total_allowances: '0' };
      const allocs = await db.allowances.findByTo(m.member_wallet_id);
      const parentAllocs = allocs.filter(a => a.from_wallet_id === callerAddress);
      const total = parentAllocs.reduce((sum, a) => sum + Number(a.amount || 0), 0);
      return { ...m, total_allowances: total.toString() };
    }));

    return res.json({ members: enriched, total: enriched.length });
  } catch (err) {
    console.error('[accounts/members] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route PUT /:id
 * @description Update a sub-account member's permissions, status, or label.
 */
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;
    const { id } = req.params;

    const member = await db.subAccounts.findById(id);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (member.parent_wallet_id !== callerAddress) {
      return res.status(403).json({ error: 'Only the parent account can modify this member' });
    }

    const updates = {};

    // Allow updating label
    if (req.body.label && typeof req.body.label === 'string') {
      updates.label = req.body.label.trim();
    }

    // Allow updating status
    if (req.body.status && SubAccount.VALID_STATUSES.includes(req.body.status)) {
      updates.status = req.body.status;
    }

    // Allow updating role
    if (req.body.role && SubAccount.VALID_ROLES.includes(req.body.role)) {
      updates.role = req.body.role;
    }

    // Allow updating permissions
    if (req.body.permissions && typeof req.body.permissions === 'object') {
      const perms = { ...member.permissions };
      const p = req.body.permissions;
      if (typeof p.can_view_balance === 'boolean') perms.can_view_balance = p.can_view_balance;
      if (typeof p.can_withdraw === 'boolean') perms.can_withdraw = p.can_withdraw;
      if (typeof p.can_deposit === 'boolean') perms.can_deposit = p.can_deposit;
      if (typeof p.can_bind_authority === 'boolean') perms.can_bind_authority = p.can_bind_authority;
      if (p.withdrawal_limit !== undefined) {
        if (p.withdrawal_limit === null || (typeof p.withdrawal_limit === 'number' && p.withdrawal_limit >= 0)) {
          perms.withdrawal_limit = p.withdrawal_limit;
        }
      }
      if (p.withdrawal_period && SubAccount.VALID_PERIODS.includes(p.withdrawal_period)) {
        perms.withdrawal_period = p.withdrawal_period;
      }
      updates.permissions = perms;
    }

    // Allow linking a member wallet post-creation
    if (req.body.member_wallet_id && typeof req.body.member_wallet_id === 'string') {
      if (!member.member_wallet_id) {
        updates.member_wallet_id = req.body.member_wallet_id.trim();
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updated = { ...member, ...updates, updated_at: Date.now() };
    await db.subAccounts.update(id, updated);

    return res.json({ member_id: id, ...updates, updated_at: updated.updated_at });
  } catch (err) {
    console.error('[accounts/members] PUT error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route DELETE /:id
 * @description Soft-delete a sub-account member (set status to "removed").
 */
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;
    const { id } = req.params;

    const member = await db.subAccounts.findById(id);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (member.parent_wallet_id !== callerAddress) {
      return res.status(403).json({ error: 'Only the parent account can remove this member' });
    }

    const updated = { ...member, status: 'removed', updated_at: Date.now() };
    await db.subAccounts.update(id, updated);

    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'sub_account_removed',
      parent_wallet_id: callerAddress,
      member_id: id,
      timestamp: Date.now(),
    });

    return res.json({ member_id: id, status: 'removed' });
  } catch (err) {
    console.error('[accounts/members] DELETE error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /parent
 * @description Check if the authenticated wallet is a sub-account of another wallet.
 *              Returns parent info if found.
 */
router.get('/parent', authMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;
    const memberships = await db.subAccounts.findByMember(callerAddress);

    if (memberships.length === 0) {
      return res.json({ is_sub_account: false, parents: [] });
    }

    return res.json({
      is_sub_account: true,
      parents: memberships.map((m) => ({
        member_id: m.member_id,
        parent_wallet_id: m.parent_wallet_id,
        role: m.role,
        label: m.label,
        permissions: m.permissions,
        account_type: m.account_type,
      })),
    });
  } catch (err) {
    console.error('[accounts/members] GET /parent error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
