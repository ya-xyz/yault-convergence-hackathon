/**
 * Trigger release policy: global pause, high-value wallet (dual attestation).
 */

'use strict';

const config = require('../config');

function normalizeWalletId(walletId) {
  if (!walletId || typeof walletId !== 'string') return '';
  return walletId.replace(/^0x/i, '').toLowerCase();
}

/**
 * Whether trigger release finalization is globally paused (env TRIGGER_RELEASE_PAUSED=true).
 */
function isReleasePaused() {
  return !!(config.trigger && config.trigger.releasePaused);
}

/**
 * Whether this wallet is high-value/sensitive and requires dual attestation
 * (oracle + legal confirmation) before release. Configured via HIGH_VALUE_WALLET_IDS (comma-separated).
 */
function isHighValueWallet(walletId) {
  const list = config.trigger && config.trigger.highValueWalletIds;
  if (!Array.isArray(list) || list.length === 0) return false;
  const normalized = normalizeWalletId(walletId);
  return list.some((id) => normalizeWalletId(id) === normalized);
}

/**
 * For high-value wallets, release is allowed only if trigger has legal confirmation.
 * @param {object} trigger - trigger record
 * @returns {boolean}
 */
function hasLegalConfirmation(trigger) {
  return !!(trigger && trigger.legal_confirmation_received_at);
}

module.exports = {
  isReleasePaused,
  isHighValueWallet,
  hasLegalConfirmation,
  normalizeWalletId,
};
