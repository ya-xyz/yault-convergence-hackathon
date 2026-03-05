/**
 * index.js — Release Module Entry Point
 *
 * Re-exports all release submodules for clean imports.
 *
 * Usage:
 *   import { createRecipientPath, checkTriggerAlerts, ... } from './release';
 *
 * Note: Heartbeat/activity-detection module has been removed.
 * Release triggers are now initiated by authorities via legal-event API.
 */

// Timelock encryption (drand) — still used for Trigger NFT envelope encryption
export {
  getDrandConfig,
  getCurrentRound,
  computeFutureRound,
  buildReleaseRequest,
  encryptReleaseRequest,
  decryptReleaseRequest,
} from './tlock.js';

// Arweave NFT operations
export {
  uploadTriggerNFT,
  uploadRecoveryNFT,
  uploadReleaseRecord,
  fetchTriggerNFTs,
  fetchRecoveryNFTs,
  fetchReleaseRecords,
  markNFTSuperseded,
  getLatestTriggerNFT,
} from './arweave-nft.js';

// Authority crypto (E2E encryption)
export {
  encryptForAuthority,
  distributeToAuthorities,
  verifyShareReceipt,
} from './authority-crypto.js';

// Path lifecycle management
export {
  createRecipientPath,
  listRecipientPaths,
  getRecipientPathStatus,
  revokeRecipientPath,
  replaceAuthority,
  exportCredentials,
} from './path-manager.js';

// Recipient activation (claim flow)
export {
  checkReleaseStatus,
  activatePath,
  reconstructFromShares,
  getBalances,
  initiateTransfer,
} from './recipient-activation.js';

// Device recovery
export {
  recoverAdminFactor,
  reestablishAllPaths,
} from './device-recovery.js';

// Notifications (status-based, not inactivity-based)
export {
  getAlertLevel,
  checkTriggerAlerts,
  showInWalletNotification,
  triggerEmailNotification,
  dismissAlert,
  clearDismissedAlerts,
} from './notifications.js';
