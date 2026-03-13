/**
 * agentPolicy.js — Agent Spending Policy Enforcement Middleware
 *
 * Express middleware that gates state-changing vault/allowance operations
 * for agent API key callers. Passes through silently for normal wallet users.
 */

'use strict';

const policyService = require('../services/spendingPolicyService');
const db = require('../db');

/**
 * Create middleware that enforces agent spending policies.
 *
 * @param {object} opts
 * @param {string} opts.operation               - 'deposit' | 'redeem' | 'transfer' | 'create_allowance'
 * @param {(req: object) => string} opts.getAmount       - Extract amount from request
 * @param {(req: object) => string} [opts.getDestination] - Extract destination address
 * @returns {Function} Express middleware
 */
function enforceAgentPolicy(opts) {
  const { operation, getAmount, getDestination } = opts;

  return async (req, res, next) => {
    try {
      // Only enforce for agent API key callers
      if (req.auth?.walletType !== 'agent') {
        return next();
      }

      const keyId = req.auth.agent_key_id;
      if (!keyId) {
        return res.status(403).json({
          error: 'Agent policy enforcement error',
          detail: 'Could not identify API key for policy lookup',
        });
      }

      const amount = getAmount(req);
      // If amount is null/undefined (e.g. shares='max'), skip middleware check —
      // the handler must do an inline check after computing the actual amount.
      if (!amount) {
        return next();
      }

      const destination = getDestination ? getDestination(req) : null;

      // Atomic check-and-reserve: acquires per-policy lock, checks budget,
      // and immediately records the spend reservation before releasing the lock.
      // This prevents parallel requests from racing past budget limits.
      const result = await policyService.checkAndReserve({
        key_id: keyId,
        wallet_id: req.auth.pubkey,
        operation,
        amount,
        destination,
      });

      if (!result.allowed) {
        return res.status(403).json({
          error: 'Policy violation',
          detail: result.error,
          policy_detail: result.detail || null,
        });
      }

      // Stash reservation info so the route handler can rollback on failure
      req._agentPolicy = {
        key_id: keyId,
        wallet_id: req.auth.pubkey,
        operation,
        amount,
        destination,
        reservation_entry_id: result.reservation?.entry_id || null,
      };

      // Auto-rollback safety net: if the handler returns any non-2xx response
      // (e.g. 400 chain mismatch, 403 ownership check, 400 insufficient balance),
      // automatically rollback the pre-reserved budget entry. This prevents budget
      // exhaustion from failed-but-charged operations across ALL downstream return paths.
      if (req._agentPolicy.reservation_entry_id) {
        res.on('finish', () => {
          if (res.statusCode >= 400 && req._agentPolicy?.reservation_entry_id) {
            policyService.rollbackReservation(req._agentPolicy.reservation_entry_id).catch(() => {});
            req._agentPolicy.reservation_entry_id = null; // prevent double rollback
          }
        });
      }

      next();
    } catch (err) {
      console.error('[agentPolicy] enforceAgentPolicy error:', err.message);
      return res.status(500).json({
        error: 'Agent policy check failed',
        detail: 'Internal error during policy enforcement. Please try again.',
      });
    }
  };
}

/**
 * After a successful operation, confirm the spend (no-op since checkAndReserve
 * already recorded the spend in the ledger atomically).
 * Kept for backward-compatibility with route handlers.
 *
 * @param {object} req - Express request with _agentPolicy stashed by enforceAgentPolicy
 */
async function recordAgentSpend(req) {
  // Spend was already recorded during checkAndReserve. Nothing to do.
}

/**
 * Rollback a pre-recorded spend reservation when the downstream operation
 * fails (e.g. chain tx reverted). Removes the ledger entry so the budget
 * is restored.
 *
 * @param {object} req - Express request with _agentPolicy stashed by enforceAgentPolicy
 */
async function rollbackAgentSpend(req) {
  if (req._agentPolicy?.reservation_entry_id) {
    await policyService.rollbackReservation(req._agentPolicy.reservation_entry_id);
  }
}

module.exports = {
  enforceAgentPolicy,
  recordAgentSpend,
  rollbackAgentSpend,
};
