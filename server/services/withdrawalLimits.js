/**
 * withdrawalLimits.js — Shared withdrawal limit enforcement
 *
 * Provides a single source of truth for checking whether a wallet (as a
 * sub-account member) is allowed to move/receive a given amount within its
 * configured period.
 *
 * Used by:
 *   - POST /api/accounts/allowances  (parent sends to member)
 *   - POST /api/vault/redeem         (member withdraws from vault)
 *   - POST /api/vault/transfer       (internal vault share transfer)
 *   - Scheduler recurring execution  (auto-execute recurring allowances)
 */

'use strict';

const db = require('../db');

const PERIOD_MS = {
  daily: 24 * 60 * 60 * 1000,         // 86400000
  weekly: 7 * 24 * 60 * 60 * 1000,    // 604800000
  monthly: 30 * 24 * 60 * 60 * 1000,  // 2592000000
};

/**
 * Look up all sub-account memberships for a wallet and return the most
 * restrictive withdrawal limit (if any).
 *
 * @param {string} walletId  The wallet address to check.
 * @returns {Promise<{ isMember: boolean, limit: number|null, period: string, parentWalletIds: string[] }>}
 */
async function getMemberLimits(walletId) {
  const allMemberships = await db.subAccounts.findByMember(walletId);
  // Only consider active memberships — removed/suspended memberships should not
  // impose stale withdrawal limits or mark a wallet as a member.
  const memberships = allMemberships.filter((m) => m.status === 'active');
  if (memberships.length === 0) {
    return { isMember: false, limit: null, period: 'monthly', parentWalletIds: [] };
  }

  // Find the most restrictive limit across all active parent relationships
  let limit = null;
  let period = 'monthly';
  const parentWalletIds = [];

  for (const m of memberships) {
    parentWalletIds.push(m.parent_wallet_id);
    if (m.permissions && m.permissions.withdrawal_limit != null) {
      if (limit === null || m.permissions.withdrawal_limit < limit) {
        limit = m.permissions.withdrawal_limit;
        period = m.permissions.withdrawal_period || 'monthly';
      }
    }
  }

  return { isMember: true, limit, period, parentWalletIds };
}

/**
 * Calculate how much a wallet has already moved (received allowances +
 * vault redeems) within the current period.
 *
 * @param {string} walletId     The wallet to check.
 * @param {string} period       'daily' | 'weekly' | 'monthly'
 * @param {string[]} [parentIds]  Only count allowances from these parents (optional).
 * @returns {Promise<number>}   Total amount moved in the current period.
 */
async function getPeriodUsage(walletId, period, parentIds) {
  const periodMs = PERIOD_MS[period] || PERIOD_MS.monthly;
  const periodStart = Date.now() - periodMs;

  const received = await db.allowances.findByTo(walletId);
  let total = received
    .filter((a) => a.created_at >= periodStart && a.status === 'completed')
    .reduce((sum, a) => sum + Number(a.amount || 0), 0);

  // Also count vault redeems tracked in allowances with type 'vault_redeem'
  // (recorded when a sub-account redeems from vault).
  // NOTE: vault_transfer records (from /api/vault/transfer) are already counted above
  // via findByTo — they have to_wallet_id = recipient and status = 'completed'.
  const all = await db.allowances.findByFrom(walletId);
  total += all
    .filter((a) => a.type === 'vault_redeem' && a.created_at >= periodStart)
    .reduce((sum, a) => sum + Number(a.amount || 0), 0);

  return total;
}

/**
 * Check if a given amount would exceed the withdrawal limit for a wallet.
 *
 * @param {string} walletId    The wallet attempting the operation.
 * @param {number} amount      The amount being moved.
 * @param {object} [opts]      Options.
 * @param {string} [opts.parentWalletId]  Only check limits from this parent.
 * @returns {Promise<{ allowed: boolean, limit?: number, period?: string, used?: number, remaining?: number }>}
 */
async function checkLimit(walletId, amount, opts = {}) {
  const { limit, period, isMember, parentWalletIds } = await getMemberLimits(walletId);

  // Not a sub-account — no limits apply
  if (!isMember || limit === null) {
    return { allowed: true };
  }

  const used = await getPeriodUsage(walletId, period, parentWalletIds);
  const remaining = Math.max(0, limit - used);

  if (used + amount > limit) {
    return {
      allowed: false,
      limit,
      period,
      used,
      remaining,
    };
  }

  return { allowed: true, limit, period, used, remaining };
}

module.exports = {
  checkLimit,
  getMemberLimits,
  getPeriodUsage,
  PERIOD_MS,
};
