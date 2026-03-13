/**
 * Spending Policies — Agent API key spending limits
 *
 * POST   /          - Create a new spending policy
 * GET    /          - List all policies for the wallet
 * GET    /:id       - Get a single policy with budget usage
 * PUT    /:id       - Update a policy
 * DELETE /:id       - Delete a policy (only if no keys bound)
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../middleware/auth');
const db = require('../db');
const policyService = require('../services/spendingPolicyService');

const router = Router();

// Note: create_allowance is not currently enforced (allowances route uses authMiddleware,
// which does not accept agent API keys). Kept for forward-compatibility.
const VALID_OPERATIONS = ['deposit', 'redeem', 'transfer', 'send', 'create_allowance'];
const MAX_POLICIES_PER_WALLET = 20;

/** Validate an amount string: must be a positive number or null. */
function validateAmountOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) return null;
  return String(num);
}

/** Validate and normalize conditions. */
function validateConditions(raw) {
  const cond = {};
  if (raw.max_per_transaction !== undefined) cond.max_per_transaction = validateAmountOrNull(raw.max_per_transaction);
  if (raw.daily_limit !== undefined) cond.daily_limit = validateAmountOrNull(raw.daily_limit);
  if (raw.weekly_limit !== undefined) cond.weekly_limit = validateAmountOrNull(raw.weekly_limit);
  if (raw.monthly_limit !== undefined) cond.monthly_limit = validateAmountOrNull(raw.monthly_limit);
  if (raw.allowed_addresses !== undefined) {
    cond.allowed_addresses = Array.isArray(raw.allowed_addresses)
      ? raw.allowed_addresses.filter((a) => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
      : [];
  }
  if (raw.allowed_operations !== undefined) {
    cond.allowed_operations = Array.isArray(raw.allowed_operations)
      ? raw.allowed_operations.filter((op) => VALID_OPERATIONS.includes(op))
      : VALID_OPERATIONS;
  }
  return cond;
}

/** Block agent API keys from managing policies — only wallet-signed requests allowed. */
function requireWalletAuth(req, res, next) {
  if (req.auth?.walletType === 'agent') {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'Agent API keys cannot manage spending policies. Use a wallet-signed request.',
    });
  }
  next();
}

/**
 * @route POST /
 * @description Create a new spending policy.
 */
router.post('/', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const { label, conditions } = req.body || {};

    // Check policy count
    const existing = await db.spendingPolicies.findByWallet(walletId);
    if (existing.length >= MAX_POLICIES_PER_WALLET) {
      return res.status(400).json({
        error: 'Policy limit reached',
        detail: `Maximum ${MAX_POLICIES_PER_WALLET} spending policies per wallet`,
      });
    }

    const cleanLabel = (label || '').trim().slice(0, 100) || 'Default Policy';

    const cond = {
      max_per_transaction: validateAmountOrNull(conditions?.max_per_transaction),
      daily_limit: validateAmountOrNull(conditions?.daily_limit),
      weekly_limit: validateAmountOrNull(conditions?.weekly_limit),
      monthly_limit: validateAmountOrNull(conditions?.monthly_limit),
      allowed_addresses: Array.isArray(conditions?.allowed_addresses)
        ? conditions.allowed_addresses.filter((a) => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
        : [],
      allowed_operations: Array.isArray(conditions?.allowed_operations)
        ? conditions.allowed_operations.filter((op) => VALID_OPERATIONS.includes(op))
        : VALID_OPERATIONS,
    };

    // Require at least one spending limit
    if (!cond.max_per_transaction && !cond.daily_limit && !cond.weekly_limit && !cond.monthly_limit) {
      return res.status(400).json({ error: 'At least one spending limit must be set' });
    }

    const policyId = 'sp_' + crypto.randomBytes(16).toString('hex');
    const record = {
      policy_id: policyId,
      wallet_id: walletId,
      label: cleanLabel,
      conditions: cond,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await db.spendingPolicies.create(policyId, record);

    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'spending_policy_created',
      wallet_id: walletId,
      policy_id: policyId,
      label: cleanLabel,
      timestamp: Date.now(),
    });

    return res.status(201).json(record);
  } catch (err) {
    console.error('[spending-policies] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /
 * @description List all spending policies for the authenticated wallet.
 */
router.get('/', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const policies = await db.spendingPolicies.findByWallet(walletId);
    const keys = await db.agentApiKeys.findByWallet(walletId);

    const policiesWithUsage = policies.map((p) => ({
      ...p,
      bound_keys_count: keys.filter((k) => k.policy_id === p.policy_id).length,
    }));

    return res.json({
      policies: policiesWithUsage.sort((a, b) => b.created_at - a.created_at),
    });
  } catch (err) {
    console.error('[spending-policies] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /:id
 * @description Get a single policy with current budget usage.
 */
router.get('/:id', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const policy = await db.spendingPolicies.findById(req.params.id);
    if (!policy || policy.wallet_id !== walletId) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const usage = await policyService.getBudgetUsage(policy.policy_id);
    const keys = await db.agentApiKeys.findByWallet(walletId);
    const boundKeys = keys.filter((k) => k.policy_id === policy.policy_id);

    return res.json({
      ...policy,
      usage,
      bound_keys_count: boundKeys.length,
      bound_keys: boundKeys.map((k) => ({ key_id: k.key_id, prefix: k.prefix, label: k.label })),
    });
  } catch (err) {
    console.error('[spending-policies] GET /:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route PUT /:id
 * @description Update a spending policy (partial update).
 */
router.put('/:id', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const existing = await db.spendingPolicies.findById(req.params.id);
    if (!existing || existing.wallet_id !== walletId) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const { label, conditions } = req.body || {};
    const updated = { ...existing };
    if (label !== undefined) updated.label = (label || '').trim().slice(0, 100);
    if (conditions) {
      updated.conditions = { ...existing.conditions, ...validateConditions(conditions) };
    }

    // Re-validate: at least one limit must exist
    const c = updated.conditions;
    if (!c.max_per_transaction && !c.daily_limit && !c.weekly_limit && !c.monthly_limit) {
      return res.status(400).json({ error: 'At least one spending limit must be set' });
    }

    updated.updated_at = Date.now();
    await db.spendingPolicies.update(req.params.id, updated);

    return res.json(updated);
  } catch (err) {
    console.error('[spending-policies] PUT error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route DELETE /:id
 * @description Delete a spending policy (only if no keys are bound).
 */
router.delete('/:id', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const existing = await db.spendingPolicies.findById(req.params.id);
    if (!existing || existing.wallet_id !== walletId) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const keys = await db.agentApiKeys.findByWallet(walletId);
    const boundKeys = keys.filter((k) => k.policy_id === req.params.id);
    if (boundKeys.length > 0) {
      return res.status(400).json({
        error: 'Policy is in use',
        detail: `${boundKeys.length} API key(s) reference this policy. Unbind them first.`,
      });
    }

    await db.spendingPolicies.delete(req.params.id);

    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'spending_policy_deleted',
      wallet_id: walletId,
      policy_id: req.params.id,
      timestamp: Date.now(),
    });

    return res.json({ policy_id: req.params.id, status: 'deleted' });
  } catch (err) {
    console.error('[spending-policies] DELETE error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
