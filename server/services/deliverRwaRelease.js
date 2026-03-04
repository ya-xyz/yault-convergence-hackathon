/**
 * Deliver stored RWA credential NFT to recipient after attestation release.
 *
 * - New path: payloads are on Arweave only. Binding has manifest_arweave_tx_id; we fetch
 *   manifest, resolve payload tx by deterministic key H(wallet_id, authority_id, recipient_index),
 *   fetch payload from Arweave, POST to upload-and-mint.
 * - Legacy path: binding has encrypted_packages with rwa_upload_body in DB; we POST that body.
 *
 * All delivery attempts are persisted in rwaDeliveryLog for retry and audit.
 */

'use strict';

const config = require('../config');
const db = require('../db');
const { manifestKey, fetchFromArweave, getManifestTxIdFromRegistry } = require('./arweaveReleaseStorage');

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Deterministic delivery log ID for a (wallet, authority, recipient) tuple.
 */
function deliveryLogId(walletId, authorityId, recipientIndex) {
  return `${String(walletId).trim().toLowerCase()}_${String(authorityId).trim()}_${recipientIndex}`;
}

/**
 * Record a delivery attempt in the DB.
 */
async function recordDelivery(walletId, authorityId, recipientIndex, result) {
  const id = deliveryLogId(walletId, authorityId, recipientIndex);
  const now = Date.now();
  const existing = await db.rwaDeliveryLog.findById(id);
  const attempts = (existing?.attempts || 0) + 1;
  const nonRetryable = !!(result && result.nonRetryable);
  const record = {
    wallet_id: walletId,
    authority_id: authorityId,
    recipient_index: recipientIndex,
    status: result.delivered
      ? 'delivered'
      : ((nonRetryable || attempts >= MAX_RETRY_ATTEMPTS) ? 'failed' : 'pending'),
    txId: result.txId || existing?.txId || null,
    error: result.error || null,
    attempts,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await db.rwaDeliveryLog.create(id, record);
  return record;
}

/**
 * Deliver the RWA package for one recipient after release.
 *
 * @param {object} binding - Full binding record from DB (may have manifest_arweave_tx_id or encrypted_packages).
 * @param {number} recipientIndex - Path/recipient index that was released.
 * @param {{ forceRedeliver?: boolean }} [opts] - If forceRedeliver is true, attempt delivery even when log says delivered (redelivery).
 * @returns {Promise<{ delivered: boolean, txId?: string, error?: string }>}
 */
async function deliverRwaPackageForRecipient(binding, recipientIndex, opts = {}) {
  const apiUrl = config.rwa?.uploadAndMintApiUrl;
  if (!apiUrl || !apiUrl.trim()) {
    const result = { delivered: false, error: 'RWA upload-and-mint API URL not configured' };
    await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
    return result;
  }

  // Skip if already delivered (unless force redeliver)
  const logId = deliveryLogId(binding.wallet_id, binding.authority_id, recipientIndex);
  const existingLog = await db.rwaDeliveryLog.findById(logId).catch(() => null);
  if (existingLog?.status === 'delivered' && !opts.forceRedeliver) {
    return { delivered: true, txId: existingLog.txId };
  }

  let rwaUploadBody = null;
  let payloadArweaveTxId = null; // Track the Arweave tx ID of the payload (for fallback receipt)
  let manifestTxId = binding.manifest_arweave_tx_id;

  if (!manifestTxId) {
    // Recovery: resolve manifest tx id from global registry (e.g. when DB lost or binding missing manifest_arweave_tx_id).
    manifestTxId = await getManifestTxIdFromRegistry(binding.wallet_id, binding.authority_id);
  }

  if (manifestTxId) {
    // Fetch from Arweave (deterministic key → payload tx → body).
    const manifestText = await fetchFromArweave(manifestTxId);
    if (!manifestText) {
      const result = { delivered: false, error: 'Failed to fetch manifest from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (_) {
      const result = { delivered: false, error: 'Invalid manifest from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    const key = manifestKey(binding.wallet_id, binding.authority_id, recipientIndex);
    payloadArweaveTxId = manifest[key];
    if (!payloadArweaveTxId) {
      const result = { delivered: false, error: 'No payload tx for this recipient in manifest' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    const payloadText = await fetchFromArweave(payloadArweaveTxId);
    if (!payloadText) {
      const result = { delivered: false, error: 'Failed to fetch payload from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    try {
      rwaUploadBody = JSON.parse(payloadText);
    } catch (_) {
      const result = { delivered: false, error: 'Invalid payload from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
  } else {
    // Legacy path: payload stored in binding.encrypted_packages (in DB).
    const packages = binding.encrypted_packages;
    if (!Array.isArray(packages)) {
      const result = { delivered: false, error: 'No encrypted_packages on binding' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    const pkg = packages.find((p) => Number(p.index) === Number(recipientIndex));
    if (!pkg) {
      const result = { delivered: false, error: 'No package for this recipient index' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    if (!pkg.rwa_upload_body || typeof pkg.rwa_upload_body !== 'object') {
      const result = { delivered: false, error: 'Package has no rwa_upload_body (legacy authority package)' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
      return result;
    }
    rwaUploadBody = pkg.rwa_upload_body;
  }

  let result;
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify(rwaUploadBody),
    });

    const body = (await response.json().catch(() => ({}))) || {};
    const signature = body?.mint?.signature;

    if (!response.ok) {
      const errorMsg = body?.error || response.statusText || 'Upload-and-mint failed';
      const nonRetryableMintCapacity =
        /InsufficientMintCapacity|not enough unapproved mints left|Error Number:\s*6017/i.test(String(errorMsg || ''));
      // If the cNFT mint service is unavailable (no Merkle tree) but the data is already on Arweave,
      // treat delivery as successful — the recipient's credential is permanently stored on Arweave.
      const isMintServiceUnavailable = response.status === 503 && /[Mm]erkle tree|not initialized/i.test(errorMsg);
      if (isMintServiceUnavailable && payloadArweaveTxId) {
        console.warn('[deliverRwaRelease] cNFT mint unavailable (%s), marking delivered with Arweave tx %s', errorMsg, payloadArweaveTxId);
        result = { delivered: true, txId: `arweave:${payloadArweaveTxId}` };
      } else {
        result = {
          delivered: false,
          error: errorMsg,
          nonRetryable: nonRetryableMintCapacity,
        };
      }
    } else {
      result = { delivered: true, txId: signature };
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    result = { delivered: false, error: message };
  }

  await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result).catch(() => {});
  return result;
}

/**
 * Deliver using only the global registry (no binding from DB). Use when DB is lost but RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID is set.
 * Pass opts.forceRedeliver to re-send even when log says delivered (redelivery).
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {number} recipientIndex
 * @param {{ forceRedeliver?: boolean }} [opts]
 * @returns {Promise<{ delivered: boolean, txId?: string, error?: string }>}
 */
async function deliverByRegistry(walletId, authorityId, recipientIndex, opts = {}) {
  const manifestTxId = await getManifestTxIdFromRegistry(walletId, authorityId);
  if (!manifestTxId) {
    return { delivered: false, error: 'No manifest in registry for this wallet and authority' };
  }
  return deliverRwaPackageForRecipient(
    { wallet_id: walletId, authority_id: authorityId, manifest_arweave_tx_id: manifestTxId },
    recipientIndex,
    opts
  );
}

/**
 * Retry all pending (failed but retryable) deliveries. Call from a scheduler/cron.
 *
 * @returns {Promise<{ retried: number, succeeded: number, failed: number }>}
 */
async function retryPendingDeliveries() {
  const pending = await db.rwaDeliveryLog.findPending().catch(() => []);
  let retried = 0, succeeded = 0, failed = 0;
  for (const entry of pending) {
    if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
      // Mark as permanently failed
      await db.rwaDeliveryLog.create(
        deliveryLogId(entry.wallet_id, entry.authority_id, entry.recipient_index),
        { ...entry, status: 'failed', updated_at: Date.now() }
      ).catch(() => {});
      failed++;
      continue;
    }
    // Find binding and retry
    const bindings = await db.bindings.findByWallet(entry.wallet_id).catch(() => []);
    const binding = bindings.find(
      (b) => b.authority_id === entry.authority_id && b.status === 'active'
    );
    if (!binding) {
      failed++;
      continue;
    }
    retried++;
    const result = await deliverRwaPackageForRecipient(binding, entry.recipient_index);
    if (result.delivered) succeeded++;
    else failed++;
  }
  return { retried, succeeded, failed };
}

/**
 * Record a delivery failure (e.g. when deliverRwaPackageForRecipient throws).
 * Writes to rwaDeliveryLog so the scheduler can retry; does not throw.
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {number} recipientIndex
 * @param {string} errorMessage
 */
async function recordDeliveryFailure(walletId, authorityId, recipientIndex, errorMessage) {
  try {
    await recordDelivery(walletId, authorityId, recipientIndex, {
      delivered: false,
      error: errorMessage || 'Delivery threw (unexpected exception)',
    });
  } catch (err) {
    console.error('[deliverRwaRelease] recordDeliveryFailure failed:', err?.message);
  }
}

module.exports = {
  deliverRwaPackageForRecipient,
  deliverByRegistry,
  retryPendingDeliveries,
  recordDeliveryFailure,
};
