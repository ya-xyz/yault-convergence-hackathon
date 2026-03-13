/**
 * Allowances API — Fund transfers between parent and sub-accounts
 *
 * POST   /              - Create an allowance (one-time or recurring)
 * GET    /              - List allowances (sent & received) for the authenticated wallet
 * PUT    /:id/cancel    - Cancel a recurring allowance
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../../middleware/auth');
const { Allowance } = require('../../models/schemas');
const db = require('../../db');
const { checkLimit } = require('../../services/withdrawalLimits');

const router = Router();

/**
 * @route POST /
 * @description Create an allowance / fund transfer to a sub-account.
 *              Only the parent wallet can send allowances to its members.
 */
router.post('/', dualAuthMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;

    const payload = {
      ...req.body,
      from_wallet_id: callerAddress,
    };

    const validation = Allowance.validate(payload);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
      });
    }

    const allowanceData = validation.data;

    // Verify the recipient is actually a sub-account member of the caller
    const members = await db.subAccounts.findByParent(callerAddress);
    const member = members.find(
      (m) => m.member_wallet_id === allowanceData.to_wallet_id && m.status === 'active'
    );

    if (!member) {
      return res.status(403).json({
        error: 'Recipient is not an active member of your account',
        detail: 'You can only send allowances to wallets linked as sub-accounts',
      });
    }

    // Enforce withdrawal limit via shared utility
    const limitCheck = await checkLimit(allowanceData.to_wallet_id, Number(allowanceData.amount));
    if (!limitCheck.allowed) {
      return res.status(400).json({
        error: 'Withdrawal limit exceeded',
        detail: `This transfer would exceed the ${limitCheck.period} limit of ${limitCheck.limit} for this member`,
        current_period_total: limitCheck.used.toString(),
        remaining: limitCheck.remaining,
        limit: limitCheck.limit,
        period: limitCheck.period,
      });
    }

    const allowanceId = crypto.randomBytes(16).toString('hex');
    const record = {
      ...allowanceData,
      allowance_id: allowanceId,
    };

    // For one-time allowances, execute vault transfer immediately
    let vaultTransferOk = false;
    if (allowanceData.type === 'one_time') {
      try {
        const vault = require('../vault');
        const fromPos = await vault._getPosition(callerAddress);
        const amt = Number(allowanceData.amount);

        if ((fromPos.deposited || 0) >= amt) {
          const shareRatio = (fromPos.shares || 0) > 0 ? amt / fromPos.deposited : 0;
          const sharesToMove = (fromPos.shares || 0) * shareRatio;

          fromPos.shares = (fromPos.shares || 0) - sharesToMove;
          fromPos.deposited = (fromPos.deposited || 0) - amt;
          await vault._setPosition(callerAddress, fromPos);

          const toPos = await vault._getPosition(allowanceData.to_wallet_id);
          toPos.shares = (toPos.shares || 0) + sharesToMove;
          toPos.deposited = (toPos.deposited || 0) + amt;
          await vault._setPosition(allowanceData.to_wallet_id, toPos);

          vaultTransferOk = true;
        }
      } catch { /* vault transfer is best-effort in stub */ }

      record.status = vaultTransferOk ? 'completed' : 'pending';
      record.vault_transfer = vaultTransferOk;
    }

    await db.allowances.create(allowanceId, record);

    // Audit log
    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'allowance_created',
      from_wallet_id: callerAddress,
      to_wallet_id: allowanceData.to_wallet_id,
      amount: allowanceData.amount,
      currency: allowanceData.currency,
      allowance_type: allowanceData.type,
      vault_transfer: vaultTransferOk,
      timestamp: Date.now(),
    });

    return res.status(201).json({
      allowance_id: allowanceId,
      amount: allowanceData.amount,
      currency: allowanceData.currency,
      type: allowanceData.type,
      status: record.status,
      vault_transfer: vaultTransferOk,
    });
  } catch (err) {
    console.error('[accounts/allowances] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route PUT /:id/cancel
 * @description Cancel a recurring allowance. Only the sender (parent) can cancel.
 */
router.put('/:id/cancel', dualAuthMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;
    const { id } = req.params;

    const allowance = await db.allowances.findById(id);
    if (!allowance) {
      return res.status(404).json({ error: 'Allowance not found' });
    }
    if (allowance.from_wallet_id !== callerAddress) {
      return res.status(403).json({ error: 'Only the sender can cancel this allowance' });
    }
    if (allowance.type !== 'recurring') {
      return res.status(400).json({ error: 'Only recurring allowances can be cancelled' });
    }
    if (allowance.status === 'cancelled') {
      return res.status(400).json({ error: 'Allowance is already cancelled' });
    }

    const updated = { ...allowance, status: 'cancelled', cancelled_at: Date.now() };
    await db.allowances.update(id, updated);

    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'recurring_allowance_cancelled',
      allowance_id: id,
      from_wallet_id: callerAddress,
      to_wallet_id: allowance.to_wallet_id,
      timestamp: Date.now(),
    });

    return res.json({
      allowance_id: id,
      status: 'cancelled',
    });
  } catch (err) {
    console.error('[accounts/allowances] PUT cancel error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /
 * @description List allowances for the authenticated wallet.
 *              Returns both sent (as parent) and received (as member) allowances.
 */
router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    const callerAddress = req.auth.pubkey;

    const [sent, received] = await Promise.all([
      db.allowances.findByFrom(callerAddress),
      db.allowances.findByTo(callerAddress),
    ]);

    return res.json({
      sent: sent.sort((a, b) => b.created_at - a.created_at),
      received: received.sort((a, b) => b.created_at - a.created_at),
      total_sent: sent.length,
      total_received: received.length,
    });
  } catch (err) {
    console.error('[accounts/allowances] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
