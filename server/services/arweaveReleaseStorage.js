/**
 * Store RWA release payloads on Arweave only (not in platform DB).
 *
 * - Deterministic: key = H(wallet_id, authority_id, recipient_index) so the same binding
 *   always resolves to the same payload tx (recoverable without platform).
 * - Untraceable: manifest and payload tags do not contain wallet/authority/recipient;
 *   only the hash key is stored, so one cannot link a tx to an identity without the inputs.
 * - Irreversible: key is one-way hash; payload is encrypted for recipient xidentity.
 *
 * Flow: upload each rwa_upload_body → get tx_id; build manifest { [key]: tx_id }; upload
 * manifest → manifest_tx_id. Platform stores only manifest_tx_id in the binding. At release,
 * fetch manifest from Arweave, compute key, fetch payload, POST to upload-and-mint.
 *
 * Mapping survivability: a global registry on Arweave maps H(wallet_id, authority_id) → manifest_tx_id.
 * The current registry Arweave tx id is stored in DB (and can be set via RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID).
 * If the platform DB is lost, set that env to the last known registry tx id and delivery can recover from Arweave.
 */

'use strict';

const crypto = require('crypto');
const config = require('../config');

const MANIFEST_TAG = 'Yault-Type';
const MANIFEST_VALUE = 'rwa-release-manifest';
const PAYLOAD_TAG_VALUE = 'rwa-release-payload';
const REGISTRY_VALUE = 'rwa-release-registry';

// Cached Arweave client and wallet (avoid re-init on every upload)
let _cachedWallet = undefined; // undefined = not yet loaded, null = load failed
let _cachedArweaveClient = null;

async function loadArweaveWallet() {
  if (_cachedWallet !== undefined) return _cachedWallet;
  const raw = process.env.ARWEAVE_WALLET_JWK;
  if (!raw || typeof raw !== 'string' || !raw.trim()) { _cachedWallet = null; return null; }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      _cachedWallet = JSON.parse(trimmed);
      return _cachedWallet;
    } catch (parseErr) {
      _cachedWallet = null;
      return null;
    }
  }
  try {
    const { readFile } = require('fs').promises;
    _cachedWallet = JSON.parse(await readFile(trimmed, 'utf-8'));
    return _cachedWallet;
  } catch (_) {
    _cachedWallet = null;
    return null;
  }
}

function getArweaveClient() {
  if (_cachedArweaveClient) return _cachedArweaveClient;
  const Arweave = require('arweave');
  _cachedArweaveClient = Arweave.init({
    host: (config.arweave?.gateway || 'https://arweave.net').replace('https://', ''),
    port: 443,
    protocol: 'https',
  });
  return _cachedArweaveClient;
}

/**
 * Deterministic key for manifest: same (wallet_id, authority_id, recipient_index) → same key.
 * No PII in the key value itself (hash only); manifest on Arweave does not reveal identity.
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {number|string} recipientIndex
 * @returns {string} 64-char hex
 */
function manifestKey(walletId, authorityId, recipientIndex) {
  const payload = JSON.stringify([
    String(walletId || '').trim().toLowerCase(),
    String(authorityId || '').trim(),
    String(recipientIndex),
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Deterministic key for global registry: (wallet_id, authority_id) → manifest_tx_id (one manifest per binding). */
function registryKey(walletId, authorityId) {
  const payload = JSON.stringify([
    String(walletId || '').trim().toLowerCase(),
    String(authorityId || '').trim(),
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Upload a string to Arweave. Minimal tags (no wallet/authority/recipient).
 *
 * @param {string} dataStr - Raw string (e.g. JSON string of rwa_upload_body or manifest).
 * @param {{ type: 'payload' | 'manifest' }} options
 * @returns {Promise<string|null>} Arweave tx ID or null on failure
 */
async function uploadToArweave(dataStr, options = {}) {
  const { type = 'payload' } = options;
  try {
    const wallet = await loadArweaveWallet();
    if (!wallet) return null;

    const arweave = getArweaveClient();

    const tx = await arweave.createTransaction({ data: dataStr }, wallet);
    tx.addTag('Content-Type', 'application/json');
    tx.addTag('App-Name', config.arweave?.appName || 'Yault');
    const typeTag = type === 'manifest' ? MANIFEST_VALUE : type === 'registry' ? REGISTRY_VALUE : PAYLOAD_TAG_VALUE;
    tx.addTag(MANIFEST_TAG, typeTag);

    await arweave.transactions.sign(tx, wallet);
    const response = await arweave.transactions.post(tx);

    if (response.status === 200 || response.status === 202) {
      return tx.id;
    }
    return null;
  } catch (err) {
    console.error('[arweaveReleaseStorage] upload failed:', err.message);
    return null;
  }
}

/**
 * Fetch data from Arweave by tx ID.
 *
 * @param {string} txId - Arweave transaction ID
 * @returns {Promise<string|null>} Response body text or null
 */
const ARWEAVE_FETCH_TIMEOUT_MS = 30000; // 30s timeout for Arweave gateway fetches

async function fetchFromArweave(txId) {
  if (!txId || typeof txId !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(txId)) {
    return null;
  }
  try {
    const base = (config.arweave?.gateway || 'https://arweave.net').replace(/\/$/, '');
    const url = `${base}/${txId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARWEAVE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('[arweaveReleaseStorage] fetch failed:', err.message);
    return null;
  }
}

/**
 * Upload RWA payloads and manifest to Arweave. Payloads are not stored on the platform.
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {Array<{ index: number, rwa_upload_body: object }>} packages - Each has index and rwa_upload_body
 * @returns {Promise<{ manifest_arweave_tx_id: string | null, payload_tx_ids: string[], error?: string }>}
 */
async function uploadPayloadsAndManifest(walletId, authorityId, packages) {
  const manifest = {};
  for (const pkg of packages) {
    if (!pkg.rwa_upload_body || typeof pkg.rwa_upload_body !== 'object') continue;
    const key = manifestKey(walletId, authorityId, pkg.index);
    const dataStr = JSON.stringify(pkg.rwa_upload_body);
    const txId = await uploadToArweave(dataStr, { type: 'payload' });
    if (!txId) {
      return {
        manifest_arweave_tx_id: null,
        payload_tx_ids: Object.values(manifest),
        error: `Arweave upload failed for recipient index ${pkg.index}`,
      };
    }
    manifest[key] = txId;
  }

  const manifestStr = JSON.stringify(manifest);
  const manifestTxId = await uploadToArweave(manifestStr, { type: 'manifest' });
  if (!manifestTxId) {
    return {
      manifest_arweave_tx_id: null,
      payload_tx_ids: Object.values(manifest),
      error: 'Arweave manifest upload failed',
    };
  }

  return { manifest_arweave_tx_id: manifestTxId, payload_tx_ids: Object.values(manifest) };
}

/**
 * Replace a single path's payload (e.g. after fixing wrong xidentity encryption).
 * Fetches current manifest, uploads new payload for the given recipient_index, updates manifest, re-uploads manifest.
 * Caller must update registry and binding with the returned new manifest_arweave_tx_id.
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {number} recipientIndex
 * @param {object} rwaUploadBody - Same shape as in distribute (data, leafOwner, ...)
 * @param {string} currentManifestTxId - Current manifest Arweave tx id (from binding or registry)
 * @returns {Promise<{ manifest_arweave_tx_id: string | null, error?: string }>}
 */
async function replacePathPayload(walletId, authorityId, recipientIndex, rwaUploadBody, currentManifestTxId) {
  if (!currentManifestTxId || typeof rwaUploadBody !== 'object' || !rwaUploadBody.data || !rwaUploadBody.leafOwner) {
    return { manifest_arweave_tx_id: null, error: 'currentManifestTxId and rwa_upload_body (data, leafOwner) are required' };
  }
  const text = await fetchFromArweave(currentManifestTxId);
  if (!text) {
    return { manifest_arweave_tx_id: null, error: 'Could not fetch current manifest from Arweave' };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (_) {
    return { manifest_arweave_tx_id: null, error: 'Invalid current manifest JSON' };
  }
  const key = manifestKey(walletId, authorityId, recipientIndex);
  const dataStr = JSON.stringify(rwaUploadBody);
  const newPayloadTxId = await uploadToArweave(dataStr, { type: 'payload' });
  if (!newPayloadTxId) {
    return { manifest_arweave_tx_id: null, error: 'Arweave payload upload failed for recipient index ' + recipientIndex };
  }
  manifest[key] = newPayloadTxId;
  const manifestStr = JSON.stringify(manifest);
  const newManifestTxId = await uploadToArweave(manifestStr, { type: 'manifest' });
  if (!newManifestTxId) {
    return { manifest_arweave_tx_id: null, error: 'Arweave manifest upload failed' };
  }
  return { manifest_arweave_tx_id: newManifestTxId };
}

// ---------------------------------------------------------------------------
// Global registry: H(wallet_id, authority_id) → manifest_tx_id (so mapping survives DB loss)
// ---------------------------------------------------------------------------

// Mutex to prevent concurrent registry read-modify-write races.
let _registryLock = Promise.resolve();
function withRegistryLock(fn) {
  const prev = _registryLock;
  let release;
  _registryLock = new Promise((resolve) => { release = resolve; });
  return prev.then(() => fn().finally(release));
}

/** Get current registry Arweave tx id: prefer DB (updated on each distribute), fall back to env when DB has none (recovery after DB loss). */
async function getRegistryTxId() {
  const db = require('../db');
  await db.ensureReady();
  const row = await db.rwaReleaseRegistry.findById('default');
  if (row && row.arweave_tx_id && String(row.arweave_tx_id).trim()) return String(row.arweave_tx_id).trim();
  const fromEnv = process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
  if (fromEnv && typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return null;
}

/** Persist current registry Arweave tx id to DB (so next boot can use it if env not set). */
async function setRegistryTxId(txId) {
  if (!txId || typeof txId !== 'string') return;
  const db = require('../db');
  await db.ensureReady();
  await db.rwaReleaseRegistry.create('default', { arweave_tx_id: txId });
}

/**
 * Update the global registry on Arweave with (wallet_id, authority_id) → manifest_tx_id, then save new registry tx id.
 * Call after uploading a new manifest in distribute.
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @param {string} manifestTxId - Arweave tx id of the manifest just uploaded
 * @returns {Promise<string|null>} New registry Arweave tx id, or null on failure
 */
async function updateRegistryAndSave(walletId, authorityId, manifestTxId) {
  return withRegistryLock(async () => {
    const key = registryKey(walletId, authorityId);
    let registry = {};
    const currentTxId = await getRegistryTxId();
    if (currentTxId) {
      const text = await fetchFromArweave(currentTxId);
      if (text) {
        try {
          registry = JSON.parse(text);
        } catch (_) {}
      }
    }
    registry[key] = manifestTxId;
    const registryStr = JSON.stringify(registry);
    const newTxId = await uploadToArweave(registryStr, { type: 'registry' });
    if (newTxId) await setRegistryTxId(newTxId);
    return newTxId;
  });
}

/**
 * Resolve manifest Arweave tx id from the global registry (for recovery when binding has no manifest_arweave_tx_id or DB is lost).
 *
 * @param {string} walletId
 * @param {string} authorityId
 * @returns {Promise<string|null>}
 */
async function getManifestTxIdFromRegistry(walletId, authorityId) {
  const registryTxId = await getRegistryTxId();
  if (!registryTxId) return null;
  const text = await fetchFromArweave(registryTxId);
  if (!text) return null;
  try {
    const registry = JSON.parse(text);
    const key = registryKey(walletId, authorityId);
    return registry[key] || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  manifestKey,
  registryKey,
  uploadToArweave,
  fetchFromArweave,
  uploadPayloadsAndManifest,
  replacePathPayload,
  getRegistryTxId,
  setRegistryTxId,
  updateRegistryAndSave,
  getManifestTxIdFromRegistry,
  loadArweaveWallet,
};
