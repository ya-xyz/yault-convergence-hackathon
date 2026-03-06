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
const { manifestKey, manifestKeyLegacy, fetchFromArweave, getManifestTxIdFromRegistry } = require('./arweaveReleaseStorage');

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };
const MAX_RETRY_ATTEMPTS = 5;

/**
 * In-flight delivery lock: prevents concurrent delivery for the same (wallet, authority, recipient, plan).
 * Key = deliveryLogId, Value = Promise that resolves when the delivery completes.
 */
const _inFlightDeliveries = new Map();

/**
 * Deterministic delivery log ID for a (wallet, authority, recipient, plan) tuple.
 * When planId is present, appends it to avoid collision across plans.
 */
function deliveryLogId(walletId, authorityId, recipientIndex, planId) {
  const base = `${String(walletId).trim().toLowerCase()}_${String(authorityId).trim()}_${recipientIndex}`;
  return planId ? `${base}_${planId}` : base;
}

/**
 * Record a delivery attempt in the DB.
 */
async function recordDelivery(walletId, authorityId, recipientIndex, result, planId) {
  const id = deliveryLogId(walletId, authorityId, recipientIndex, planId);
  const now = Date.now();
  const existing = await db.rwaDeliveryLog.findById(id);
  const attempts = (existing?.attempts || 0) + 1;
  const nonRetryable = !!(result && result.nonRetryable);
  const record = {
    wallet_id: walletId,
    authority_id: authorityId,
    recipient_index: recipientIndex,
    plan_id: planId || null,
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
  const planId = binding.plan_id || null;
  if (!apiUrl || !apiUrl.trim()) {
    const result = { delivered: false, error: 'RWA upload-and-mint API URL not configured' };
    await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
    return result;
  }

  // ── In-flight lock: prevent concurrent delivery for the same recipient ──
  const logId = deliveryLogId(binding.wallet_id, binding.authority_id, recipientIndex, planId);
  if (_inFlightDeliveries.has(logId) && !opts.forceRedeliver) {
    // Another delivery is already in progress — wait for it and return its result
    console.log('[deliverRwaRelease] Skipping duplicate delivery (in-flight): %s', logId);
    try {
      return await _inFlightDeliveries.get(logId);
    } catch (_) {
      // The in-flight delivery failed; re-check DB below
    }
  }

  // Wrap actual delivery in a promise so concurrent callers can wait on it
  const deliveryPromise = _doDeliverRwaPackageForRecipient(binding, recipientIndex, opts, logId);
  if (!opts.forceRedeliver) {
    _inFlightDeliveries.set(logId, deliveryPromise);
  }
  try {
    return await deliveryPromise;
  } finally {
    // Only delete if it's still OUR promise (not replaced by a newer one)
    if (_inFlightDeliveries.get(logId) === deliveryPromise) {
      _inFlightDeliveries.delete(logId);
    }
  }
}

/** @private Actual delivery implementation (called via in-flight lock wrapper). */
async function _doDeliverRwaPackageForRecipient(binding, recipientIndex, opts, logId) {
  const apiUrl = config.rwa?.uploadAndMintApiUrl;
  const planId = binding.plan_id || null;

  // Skip if already delivered (unless force redeliver or log was superseded by credential regeneration)
  const existingLog = await db.rwaDeliveryLog.findById(logId).catch(() => null);
  if (existingLog?.status === 'delivered' && !opts.forceRedeliver) {
    return { delivered: true, txId: existingLog.txId };
  }
  // 'superseded' means credentials were regenerated — treat as fresh delivery needed
  if (existingLog?.status === 'superseded') {
    console.log('[deliverRwaRelease] Delivery log superseded for wallet=%s recipient=%s plan=%s (credentials regenerated), proceeding with fresh delivery', binding.wallet_id, recipientIndex, planId);
  }

  let rwaUploadBody = null;
  let payloadArweaveTxId = null; // Track the Arweave tx ID of the payload (for fallback receipt)
  let manifestTxId = binding.manifest_arweave_tx_id;

  if (!manifestTxId) {
    // Recovery: resolve manifest tx id from global registry (e.g. when DB lost or binding missing manifest_arweave_tx_id).
    manifestTxId = await getManifestTxIdFromRegistry(binding.wallet_id, binding.authority_id, planId);
  }

  if (manifestTxId) {
    // Fetch from Arweave (deterministic key → payload tx → body).
    const manifestText = await fetchFromArweave(manifestTxId);
    if (!manifestText) {
      const result = { delivered: false, error: 'Failed to fetch manifest from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (_) {
      const result = { delivered: false, error: 'Invalid manifest from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    const key = manifestKey(binding.wallet_id, binding.authority_id, recipientIndex, planId);
    payloadArweaveTxId = manifest[key];
    // Backward compat: try legacy key formats if the plan-scoped key wasn't found.
    // Pre-plan_id manifests used a 3-element key (no planId element).
    if (!payloadArweaveTxId && planId) {
      const legacyKey = manifestKeyLegacy(binding.wallet_id, binding.authority_id, recipientIndex);
      payloadArweaveTxId = manifest[legacyKey];
      if (!payloadArweaveTxId) {
        // Also try 4-element key with empty planId (in case manifest was created after
        // the code change but before plan_id was set on the binding)
        const emptyPlanKey = manifestKey(binding.wallet_id, binding.authority_id, recipientIndex, null);
        payloadArweaveTxId = manifest[emptyPlanKey];
      }
      if (payloadArweaveTxId) {
        console.log('[deliverRwaRelease] Used legacy manifest key for wallet=%s recipient=%s (pre-plan_id manifest)', binding.wallet_id, recipientIndex);
      }
    }
    if (!payloadArweaveTxId) {
      const result = { delivered: false, error: 'No payload tx for this recipient in manifest' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    const payloadText = await fetchFromArweave(payloadArweaveTxId);
    if (!payloadText) {
      const result = { delivered: false, error: 'Failed to fetch payload from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    try {
      rwaUploadBody = JSON.parse(payloadText);
    } catch (_) {
      const result = { delivered: false, error: 'Invalid payload from Arweave' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
  } else {
    // Legacy path: payload stored in binding.encrypted_packages (in DB).
    const packages = binding.encrypted_packages;
    if (!Array.isArray(packages)) {
      const result = { delivered: false, error: 'No encrypted_packages on binding' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    const pkg = packages.find((p) => Number(p.index) === Number(recipientIndex));
    if (!pkg) {
      const result = { delivered: false, error: 'No package for this recipient index' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    if (!pkg.rwa_upload_body || typeof pkg.rwa_upload_body !== 'object') {
      const result = { delivered: false, error: 'Package has no rwa_upload_body (legacy authority package)' };
      await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
      return result;
    }
    rwaUploadBody = pkg.rwa_upload_body;
  }

  let result;
  try {
    const bodyJson = JSON.stringify(rwaUploadBody);
    console.log('[deliverRwaRelease] POST %s (body %d bytes, wallet=%s, recipient=%d, plan=%s, leafOwner=%s)',
      apiUrl, bodyJson.length, binding.wallet_id, recipientIndex, planId || 'none', rwaUploadBody.leafOwner || 'MISSING');

    // Add 60s timeout to prevent indefinite hangs
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: DEFAULT_HEADERS,
        body: bodyJson,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    console.log('[deliverRwaRelease] Response: %d %s', response.status, response.statusText);

    const body = (await response.json().catch(() => ({}))) || {};
    const signature = body?.mint?.signature;

    if (!response.ok) {
      const errorMsg = body?.error || response.statusText || 'Upload-and-mint failed';
      console.warn('[deliverRwaRelease] Upload-and-mint failed: %d %s', response.status, errorMsg);
      const nonRetryableMintCapacity =
        /InsufficientMintCapacity|not enough unapproved mints left|Error Number:\s*6017/i.test(String(errorMsg || ''));
      const isRateLimited = response.status === 429;
      // If the cNFT mint service is unavailable (no Merkle tree) but the data is already on Arweave,
      // treat delivery as successful — the recipient's credential is permanently stored on Arweave.
      const isMintServiceUnavailable = response.status === 503 && /[Mm]erkle tree|not initialized/i.test(errorMsg);
      if (isMintServiceUnavailable && payloadArweaveTxId) {
        console.warn('[deliverRwaRelease] cNFT mint unavailable (%s), marking delivered with Arweave tx %s', errorMsg, payloadArweaveTxId);
        result = { delivered: true, txId: `arweave:${payloadArweaveTxId}` };
      } else {
        result = {
          delivered: false,
          error: isRateLimited ? 'Too many requests — mint API rate limited, will retry later' : errorMsg,
          nonRetryable: nonRetryableMintCapacity,
          rateLimited: isRateLimited,
        };
      }
    } else {
      console.log('[deliverRwaRelease] Success: txId=%s', signature || '(no signature)');
      result = { delivered: true, txId: signature };
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[deliverRwaRelease] Fetch error: %s', message);
    result = { delivered: false, error: message };
  }

  await recordDelivery(binding.wallet_id, binding.authority_id, recipientIndex, result, planId).catch(() => {});
  return result;
}

/**
 * Deliver using only the global registry (no binding from DB). Use when DB is lost but RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID is set.
 * Pass opts.forceRedeliver to re-send even when log says delivered (redelivery).
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {number} recipientIndex
 * @param {{ forceRedeliver?: boolean, planId?: string }} [opts]
 * @returns {Promise<{ delivered: boolean, txId?: string, error?: string }>}
 */
async function deliverByRegistry(walletId, authorityId, recipientIndex, opts = {}) {
  const manifestTxId = await getManifestTxIdFromRegistry(walletId, authorityId, opts.planId || null);
  if (!manifestTxId) {
    return { delivered: false, error: 'No manifest in registry for this wallet and authority' };
  }
  return deliverRwaPackageForRecipient(
    { wallet_id: walletId, authority_id: authorityId, manifest_arweave_tx_id: manifestTxId, plan_id: opts.planId || null },
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
    const entryPlanId = entry.plan_id || null;
    if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
      // Mark as permanently failed
      await db.rwaDeliveryLog.create(
        deliveryLogId(entry.wallet_id, entry.authority_id, entry.recipient_index, entryPlanId),
        { ...entry, status: 'failed', updated_at: Date.now() }
      ).catch(() => {});
      failed++;
      continue;
    }
    // Find binding and retry — match by plan_id when present
    const bindings = await db.bindings.findByWallet(entry.wallet_id).catch(() => []);
    const binding = bindings.find(
      (b) => b.authority_id === entry.authority_id && b.status === 'active' &&
             (b.plan_id || null) === entryPlanId
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
 * @param {string} [planId] - Optional plan_id for plan-scoped delivery log
 */
async function recordDeliveryFailure(walletId, authorityId, recipientIndex, errorMessage, planId) {
  try {
    await recordDelivery(walletId, authorityId, recipientIndex, {
      delivered: false,
      error: errorMessage || 'Delivery threw (unexpected exception)',
    }, planId || null);
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
