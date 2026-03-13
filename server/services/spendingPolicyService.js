/**
 * spendingPolicyService.js — Agent Spending Policy Enforcement
 *
 * Core logic for checking agent API key operations against spending policies.
 * Adapted from AESP PolicyEngine / BudgetTracker concepts, simplified for
 * server-side sql.js context.
 *
 * - checkPolicy(): Verify a request is within policy limits
 * - recordSpend(): Log a successful spend to the budget ledger
 * - getBudgetUsage(): Compute rolling-window budget usage for a policy
 */

'use strict';

const db = require('../db');

// ---------------------------------------------------------------------------
// Per-policy in-memory mutex — serializes check+record to prevent TOCTOU races
// where parallel requests all pass budget checks against the same pre-state.
// Works because the server is single-process Node.js.
// ---------------------------------------------------------------------------
const _policyLocks = new Map();

function _acquirePolicyLock(policyId) {
  const prev = _policyLocks.get(policyId) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  _policyLocks.set(policyId, prev.then(() => next));
  return prev.then(() => release);
}

/** Rolling window durations in milliseconds. */
const PERIOD_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Check if a request from an agent API key is permitted by its spending policy.
 *
 * @param {object} params
 * @param {string} params.key_id         - Agent API key ID
 * @param {string} params.operation      - 'deposit' | 'redeem' | 'transfer' | 'create_allowance'
 * @param {string} params.amount         - Amount string (USDC)
 * @param {string} [params.destination]  - Destination address (for transfer/allowance)
 * @returns {Promise<{ allowed: boolean, error?: string, detail?: object }>}
 */
async function checkPolicy(params) {
  const { key_id, operation, amount, destination } = params;

  // 1. Look up the API key
  const key = await db.agentApiKeys.findById(key_id);
  if (!key) return { allowed: false, error: 'API key not found' };

  // 2. No policy bound = block agent operations (safe default)
  if (!key.policy_id) {
    return {
      allowed: false,
      error: 'No spending policy assigned to this API key',
      detail: { remedy: 'Assign a spending policy to this key in the Developers settings.' },
    };
  }

  // 3. Load the policy
  const policy = await db.spendingPolicies.findById(key.policy_id);
  if (!policy) {
    return { allowed: false, error: 'Spending policy not found (may have been deleted)' };
  }

  const cond = policy.conditions || {};

  // 4. Check operation is allowed (empty array = no operations allowed)
  if (Array.isArray(cond.allowed_operations)) {
    if (!cond.allowed_operations.includes(operation)) {
      return {
        allowed: false,
        error: `Operation '${operation}' is not permitted by this policy`,
      };
    }
  }

  // 5. Check allowed addresses (for transfer/allowance destinations)
  if (destination && Array.isArray(cond.allowed_addresses) && cond.allowed_addresses.length > 0) {
    const normalizedDest = destination.replace(/^0x/i, '').toLowerCase();
    const allowed = cond.allowed_addresses.some(
      (a) => a.replace(/^0x/i, '').toLowerCase() === normalizedDest
    );
    if (!allowed) {
      return {
        allowed: false,
        error: 'Destination address is not on the policy allowlist',
      };
    }
  }

  // 6. Check per-transaction limit
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return { allowed: false, error: 'Invalid amount' };
  }

  if (cond.max_per_transaction) {
    const maxPerTx = parseFloat(cond.max_per_transaction);
    if (numAmount > maxPerTx) {
      return {
        allowed: false,
        error: `Amount ${amount} exceeds per-transaction limit of ${cond.max_per_transaction}`,
        detail: { limit: cond.max_per_transaction, requested: amount, rule: 'max_per_transaction' },
      };
    }
  }

  // 7. Check rolling budget limits (daily/weekly/monthly)
  const usage = await getBudgetUsage(key.policy_id);

  for (const [period, limitKey] of [['daily', 'daily_limit'], ['weekly', 'weekly_limit'], ['monthly', 'monthly_limit']]) {
    const limit = cond[limitKey] ? parseFloat(cond[limitKey]) : null;
    if (limit !== null) {
      const spent = usage[`${period}_spent`];
      if (spent + numAmount > limit) {
        return {
          allowed: false,
          error: `${period.charAt(0).toUpperCase() + period.slice(1)} spending limit exceeded`,
          detail: {
            rule: limitKey,
            limit: cond[limitKey],
            spent: spent.toFixed(4),
            remaining: Math.max(0, limit - spent).toFixed(4),
            requested: amount,
          },
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Record a spend against the budget ledger after a successful operation.
 *
 * @param {object} params
 * @param {string} params.key_id
 * @param {string} params.wallet_id
 * @param {string} params.policy_id
 * @param {string} params.operation
 * @param {string} params.amount
 * @param {string} [params.destination]
 */
async function recordSpend(params) {
  const { key_id, wallet_id, policy_id, operation, amount, destination } = params;
  const crypto = require('crypto');
  const entryId = `${key_id}_${crypto.randomBytes(8).toString('hex')}`;

  await db.agentBudgetLedger.create(entryId, {
    entry_id: entryId,
    key_id,
    wallet_id,
    policy_id,
    operation,
    amount: String(amount),
    destination: destination || null,
    timestamp: Date.now(),
  });
}

/**
 * Compute current-period budget usage for a policy by summing ledger entries
 * within rolling windows (24h, 7d, 30d).
 *
 * @param {string} policyId
 * @returns {Promise<{ daily_spent: number, weekly_spent: number, monthly_spent: number }>}
 */
async function getBudgetUsage(policyId) {
  const entries = await db.agentBudgetLedger.findByPolicy(policyId);
  const now = Date.now();

  let dailySpent = 0;
  let weeklySpent = 0;
  let monthlySpent = 0;

  for (const entry of entries) {
    const age = now - entry.timestamp;
    const amt = parseFloat(entry.amount) || 0;

    if (age <= PERIOD_MS.daily) dailySpent += amt;
    if (age <= PERIOD_MS.weekly) weeklySpent += amt;
    if (age <= PERIOD_MS.monthly) monthlySpent += amt;
  }

  return {
    daily_spent: dailySpent,
    weekly_spent: weeklySpent,
    monthly_spent: monthlySpent,
  };
}

/**
 * Atomic check-and-reserve: acquires a per-policy lock, checks the policy,
 * and immediately records the spend (reservation) in the ledger before
 * releasing the lock. This prevents parallel requests from racing past
 * budget limits.
 *
 * On success, returns { allowed: true, reservation: { entry_id } }.
 * On failure, returns { allowed: false, error, detail }.
 *
 * The caller should call `rollbackReservation(entry_id)` if the downstream
 * operation (chain tx) fails and the spend should not count.
 *
 * @param {object} params - Same as checkPolicy + wallet_id for recording
 */
async function checkAndReserve(params) {
  const { key_id } = params;
  // Look up key to find policy_id for locking
  const key = await db.agentApiKeys.findById(key_id);
  if (!key || !key.policy_id) {
    // Delegate to checkPolicy for consistent error messages (no lock needed)
    return checkPolicy(params);
  }

  const release = await _acquirePolicyLock(key.policy_id);
  try {
    const result = await checkPolicy(params);
    if (!result.allowed) return result;

    // Reserve: immediately record the spend while still holding the lock
    const crypto = require('crypto');
    const entryId = `${key_id}_${crypto.randomBytes(8).toString('hex')}`;
    await db.agentBudgetLedger.create(entryId, {
      entry_id: entryId,
      key_id,
      wallet_id: params.wallet_id || key.wallet_id,
      policy_id: key.policy_id,
      operation: params.operation,
      amount: String(params.amount),
      destination: params.destination || null,
      timestamp: Date.now(),
    });

    return { allowed: true, reservation: { entry_id: entryId } };
  } finally {
    release();
  }
}

/**
 * Rollback a previously-reserved spend (e.g. when a chain tx fails).
 *
 * @param {string} entryId
 */
async function rollbackReservation(entryId) {
  try {
    await db.agentBudgetLedger.delete(entryId);
  } catch (err) {
    console.error('[spendingPolicy] rollbackReservation failed:', entryId, err.message);
  }
}

module.exports = {
  checkPolicy,
  checkAndReserve,
  recordSpend,
  rollbackReservation,
  getBudgetUsage,
};
