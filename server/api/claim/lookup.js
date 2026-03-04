/**
 * GET /api/claim/lookup/:wallet_id
 *
 * Recipient looks up released admin_factors for a wallet.
 * Returns all released factors + recipient path info.
 * The client matches the correct factor by trying each with their passphrase.
 *
 * Params: :wallet_id — the asset owner's wallet address
 * Returns: { wallet_id, released, factors[], vault_value }
 */

'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const db = require('../../db');
const config = require('../../config');
const escrowContract = require('../../services/escrowContract');
const { evaluateReleaseAttestationGate } = require('../../services/attestationGate');
const { encryptAdminFactorForXidentity, normalizeAdminFactorHex } = require('../../services/xidentityAdminFactor');
const { fetchFromArweave, manifestKey } = require('../../services/arweaveReleaseStorage');

// ---------------------------------------------------------------------------
// Decryption helper for admin_factor_hex at rest (shared module)
// ---------------------------------------------------------------------------
const { decryptAdminFactor } = require('../../services/adminFactorCrypto');

function getEncryptedAdminPayload(record) {
  if (!record || typeof record !== 'object') return null;
  const direct = record.encrypted_admin_factor || record.admin_factor_encrypted || record.admin_factor_cipher || record.encrypted_payload;
  if (!direct) return null;
  if (typeof direct === 'object') return direct;
  if (typeof direct === 'string') {
    try {
      const parsed = JSON.parse(direct);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  return null;
}

function normalizeEncryptedPayloadShape(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.encrypted && typeof payload.encrypted === 'object') return payload.encrypted;
  const hasRawFields = (
    typeof payload.ephemeral_pub === 'string' &&
    typeof payload.encrypted_aes_key === 'string' &&
    typeof payload.iv === 'string' &&
    typeof payload.encrypted_data === 'string'
  );
  return hasRawFields ? payload : null;
}

const _manifestCache = new Map(); // key: `${manifestTxId}` => manifest json object|null
const _payloadCache = new Map();  // key: `${payloadTxId}` => encrypted object|null

async function loadManifestJson(manifestTxId) {
  const key = String(manifestTxId || '').trim();
  if (!key) return null;
  if (_manifestCache.has(key)) return _manifestCache.get(key);
  try {
    const text = await fetchFromArweave(key);
    if (!text) {
      _manifestCache.set(key, null);
      return null;
    }
    const parsed = JSON.parse(text);
    const out = parsed && typeof parsed === 'object' ? parsed : null;
    _manifestCache.set(key, out);
    return out;
  } catch (_) {
    _manifestCache.set(key, null);
    return null;
  }
}

async function loadEncryptedPayloadFromTx(payloadTxId) {
  const key = String(payloadTxId || '').trim();
  if (!key) return null;
  if (_payloadCache.has(key)) return _payloadCache.get(key);
  try {
    const text = await fetchFromArweave(key);
    if (!text) {
      _payloadCache.set(key, null);
      return null;
    }
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object') {
      _payloadCache.set(key, null);
      return null;
    }
    // RWA payload shape: { data: base64(jsonString), ... }
    if (typeof body.data === 'string' && body.data.trim()) {
      const decoded = Buffer.from(body.data, 'base64').toString('utf8');
      const inner = JSON.parse(decoded);
      const encrypted = normalizeEncryptedPayloadShape(inner);
      _payloadCache.set(key, encrypted);
      return encrypted;
    }
    const encrypted = normalizeEncryptedPayloadShape(body);
    _payloadCache.set(key, encrypted);
    return encrypted;
  } catch (_) {
    _payloadCache.set(key, null);
    return null;
  }
}

async function getEncryptedPayloadFromBindingManifest(walletId, authorityId, recipientIndex) {
  const w = String(walletId || '').trim();
  const wNorm = normalizeAddr(w);
  const a = String(authorityId || '').trim();
  const idx = Number(recipientIndex);
  if (!w || !Number.isFinite(idx) || idx < 1) return null;
  const walletCandidates = [...new Set([
    w,
    wNorm,
    wNorm ? ('0x' + wNorm) : '',
  ].filter(Boolean))];
  const bindingSets = await Promise.all(walletCandidates.map((wk) => db.bindings.findByWallet(wk)));
  const bindingMap = new Map();
  for (const set of bindingSets) {
    for (const b of set || []) {
      const id = String(b.binding_id || '').trim() || JSON.stringify([b.wallet_id, b.authority_id, b.created_at]);
      if (!bindingMap.has(id)) bindingMap.set(id, b);
    }
  }
  const bindings = [...bindingMap.values()];
  const activeWithManifest = bindings.filter((b) => b && b.manifest_arweave_tx_id && (b.status || '') === 'active');
  const withManifest = bindings.filter((b) => b && b.manifest_arweave_tx_id);
  let target = null;
  if (a) {
    target = activeWithManifest.find((b) => String(b.authority_id || '').trim() === a)
      || withManifest.find((b) => String(b.authority_id || '').trim() === a);
  }
  if (!target) {
    // Plan flow may not carry authority_id; choose the most recent active binding with manifest.
    const sorted = activeWithManifest.length > 0 ? activeWithManifest : withManifest;
    target = sorted.sort((x, y) => Number(y.created_at || 0) - Number(x.created_at || 0))[0] || null;
  }
  if (!target || !target.manifest_arweave_tx_id) return null;

  const manifest = await loadManifestJson(target.manifest_arweave_tx_id);
  if (!manifest) return null;
  const key = manifestKey(String(target.wallet_id || w), String(target.authority_id || '').trim(), idx);
  const payloadTxId = manifest[key];
  if (!payloadTxId) return null;
  return loadEncryptedPayloadFromTx(payloadTxId);
}

async function findRecipientPathIndex(planWalletId, recipientEvmAddress) {
  const walletRaw = String(planWalletId || '').trim();
  const walletNorm = normalizeAddr(planWalletId);
  const recipientNorm = normalizeAddr(recipientEvmAddress);
  if ((!walletRaw && !walletNorm) || !recipientNorm) return null;
  const walletCandidates = [...new Set([
    walletRaw,
    walletNorm,
    walletNorm ? ('0x' + walletNorm) : '',
  ].filter(Boolean))];
  for (const walletKey of walletCandidates) {
    const configs = await db.recipientPaths.findByWallet(walletKey);
    for (const cfg of configs) {
      const paths = Array.isArray(cfg.paths) ? cfg.paths : [];
      const match = paths.find((p) => p && p.recipient_evm_address && normalizeAddr(p.recipient_evm_address) === recipientNorm);
      if (match && Number.isFinite(Number(match.index))) return Number(match.index);
    }
  }
  return null;
}

async function resolveAdminFactorHexForPlanRow(record) {
  if (!record || typeof record !== 'object') return null;
  const legacyRaw = record.admin_factor ? String(record.admin_factor).trim() : '';
  if (legacyRaw) {
    try {
      return normalizeAdminFactorHex(legacyRaw);
    } catch (_) {}
  }

  const planWalletId = record.plan_wallet_id || '';
  const recipientEvm = record.evm_address || '';
  const recipientIndex = await findRecipientPathIndex(planWalletId, recipientEvm);
  if (!Number.isFinite(recipientIndex) || recipientIndex < 1) return null;

  const factors = await db.walletAdminFactors.findByWallet(normalizeAddr(planWalletId));
  const row = factors.find((f) => Number(f.recipient_index) === Number(recipientIndex));
  if (!row || !row.admin_factor_hex) return null;
  try {
    return decryptAdminFactor(row.admin_factor_hex);
  } catch (_) {
    return null;
  }
}

async function refreshPlanRowEncryptionForCurrentXidentity(record, recipientXidentity) {
  const plainHex = await resolveAdminFactorHexForPlanRow(record);
  if (!plainHex || !recipientXidentity) return null;
  const encrypted = await encryptAdminFactorForXidentity(plainHex, recipientXidentity);
  const id = String(record.mnemonic_hash || '').trim().toLowerCase();
  if (isValidMnemonicHash(id)) {
    await db.recipientMnemonicAdmin.update(id, {
      ...record,
      admin_factor: null,
      encrypted_admin_factor: encrypted,
      encrypted_for_xidentity: String(recipientXidentity).trim(),
      updated_at: new Date().toISOString(),
    }).catch((err) => {
      console.warn('[claim/lookup] Failed to persist refreshed plan encrypted_admin_factor:', err.message);
    });
  }
  return encrypted;
}

async function getXidentityByEvm(evmAddress) {
  const norm = normalizeAddr(evmAddress);
  if (!norm) return '';
  const rec = await db.walletAddresses.findById(norm);
  if (!rec || !rec.xidentity) return '';
  return String(rec.xidentity).trim();
}

async function ensureEncryptedAdminPayload(record, recipientXidentity, persistUpdater) {
  // For plan rows, always prefer refreshing encryption with current recipient xidentity
  // from walletAdminFactors. This prevents stale ciphertext after xidentity rotation.
  if (record && record.plan_wallet_id && record.evm_address) {
    const refreshed = await refreshPlanRowEncryptionForCurrentXidentity(record, recipientXidentity);
    if (refreshed) return refreshed;
  }

  const existing = getEncryptedAdminPayload(record);
  if (existing) return existing;

  const legacyRaw = record && record.admin_factor ? String(record.admin_factor).trim() : '';
  if (!legacyRaw) return null;
  if (!recipientXidentity) throw new Error('Recipient xidentity not found');

  const encrypted = await encryptAdminFactorForXidentity(normalizeAdminFactorHex(legacyRaw), recipientXidentity);
  if (typeof persistUpdater === 'function') {
    await persistUpdater(encrypted).catch((err) => {
      console.warn('[claim/lookup] Admin factor encrypt-on-read migration persist failed:', err.message);
    });
  }
  return encrypted;
}

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/** Mnemonic hash must be 64-char hex (e.g. SHA-256 of normalized mnemonic). */
function isValidMnemonicHash(h) {
  const s = String(h || '').replace(/^0x/i, '').trim();
  return s.length === 64 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Verify caller is authorized to view factors for this wallet_id.
 * Allowed: (1) wallet owner, or (2) a configured recipient (recipient_evm_address).
 */
function isAuthorized(callerPubkey, walletId, paths) {
  const callerNorm = normalizeAddr(callerPubkey);
  const walletNorm = normalizeAddr(walletId);
  if (callerNorm === walletNorm) return true;
  if (!paths || !Array.isArray(paths)) return false;
  return paths.some(p => {
    const recip = p.recipient_evm_address;
    return recip && normalizeAddr(recip) === callerNorm;
  });
}

/**
 * POST /api/claim/register-mnemonic-hash
 *
 * Recipient registers their mnemonic hash for a path so that release can be tied to "this blob is for this wallet (mnemonic-hash)".
 * Body: { wallet_id, path_index, mnemonic_hash } — mnemonic_hash = 64-char hex (e.g. SHA-256 of normalized mnemonic).
 * Caller must be the recipient_evm_address for that path. Authority can use this hash to know which blob goes to which recipient.
 */
router.post('/register-mnemonic-hash', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { wallet_id, path_index, mnemonic_hash } = req.body || {};
    if (!wallet_id || path_index == null) {
      return res.status(400).json({ error: 'wallet_id and path_index are required' });
    }
    if (!isValidMnemonicHash(mnemonic_hash)) {
      return res.status(400).json({ error: 'mnemonic_hash must be a 64-char hex string (e.g. SHA-256 of mnemonic)' });
    }
    const hashNorm = String(mnemonic_hash).replace(/^0x/i, '').trim().toLowerCase();

    const pathConfigs = await db.recipientPaths.findByWallet(wallet_id);
    if (pathConfigs.length === 0) {
      return res.status(404).json({ error: 'Wallet path config not found' });
    }
    const rec = pathConfigs[0];
    const paths = rec.paths || [];
    const pathIndex = Number(path_index);
    const pathEntry = paths.find(p => p.index === pathIndex);
    if (!pathEntry) {
      return res.status(404).json({ error: 'Path not found' });
    }
    const recipientAddr = pathEntry.recipient_evm_address;
    if (!recipientAddr || normalizeAddr(recipientAddr) !== normalizeAddr(req.auth.pubkey)) {
      return res.status(403).json({ error: 'Only the designated recipient for this path can register mnemonic hash' });
    }

    // Use full SHA-256 hash as record ID (not truncated) to prevent collision risk
    const id = crypto.createHash('sha256').update(wallet_id).digest('hex');
    const updatedPaths = paths.map(p => {
      if (p.index !== pathIndex) return p;
      return { ...p, recipient_mnemonic_hash: hashNorm };
    });
    await db.recipientPaths.update(id, { ...rec, paths: updatedPaths });

    // Update mnemonic hash reverse index for efficient /by-mnemonic-hash lookups
    const walletIdNorm = normalizeAddr(wallet_id);
    const recipAddrNorm = normalizeAddr(recipientAddr);
    await db.mnemonicHashIndex.create(`${hashNorm}_${walletIdNorm}`, {
      mnemonic_hash: hashNorm,
      wallet_id: walletIdNorm,
      recipient_address: recipAddrNorm,
      path_index: pathIndex,
    });

    return res.json({ registered: true, wallet_id, path_index: pathIndex });
  } catch (err) {
    console.error('[claim/register-mnemonic-hash] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/plan-releases
 *
 * Dev/test: query recipientMnemonicAdmin by current user's evm_address, return records where encrypted AdminFactor is available.
 * Returns: { items: [ { evm_address, mnemonic_hash, encrypted_admin_factor, label, plan_wallet_id } ] }
 */
router.get('/plan-releases', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const callerXidentity = await getXidentityByEvm(callerNorm);
    if (!callerXidentity) {
      return res.status(409).json({ error: 'xidentity not found for caller wallet' });
    }
    const rows = await db.recipientMnemonicAdmin.findByEvmAddressWithAdminFactor(callerNorm);
    const items = [];
    for (const r of rows) {
      const encrypted = await ensureEncryptedAdminPayload(
        r,
        callerXidentity,
        async (payload) => {
          const id = String(r.mnemonic_hash || '').trim().toLowerCase();
          if (!isValidMnemonicHash(id)) return;
          await db.recipientMnemonicAdmin.update(id, {
            ...r,
            admin_factor: null,
            encrypted_admin_factor: payload,
            encrypted_for_xidentity: callerXidentity,
            updated_at: new Date().toISOString(),
          });
        }
      );
      if (!encrypted) continue;
      items.push({
        evm_address: r.evm_address,
        mnemonic_hash: r.mnemonic_hash,
        encrypted_admin_factor: encrypted,
        label: r.label || 'Release',
        plan_wallet_id: r.plan_wallet_id || null,
      });
    }
    return res.json({ items });
  } catch (err) {
    console.error('[claim/plan-releases] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/claim/update-wallet-json
 *
 * Dev/test: locate recipientMnemonicAdmin record by evm_address + mnemonic_hash, and write wallet_json to that record.
 * Body: { evm_address, mnemonic_hash, wallet_json }
 */
router.post('/update-wallet-json', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { evm_address, mnemonic_hash, wallet_json } = req.body || {};
    const hashNorm = String(mnemonic_hash || '').replace(/^0x/i, '').trim().toLowerCase();
    if (hashNorm.length !== 64 || !/^[0-9a-f]+$/.test(hashNorm)) {
      return res.status(400).json({ error: 'mnemonic_hash must be 64-char hex' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const evmNorm = normalizeAddr(evm_address || req.auth.pubkey);
    if (callerNorm !== evmNorm) {
      return res.status(403).json({ error: 'evm_address must match logged-in wallet' });
    }
    const record = await db.recipientMnemonicAdmin.findById(hashNorm);
    if (!record || normalizeAddr(record.evm_address) !== callerNorm) {
      return res.status(404).json({ error: 'No matching record for this mnemonic hash and wallet' });
    }
    const updated = { ...record, wallet_json: wallet_json || null };
    await db.recipientMnemonicAdmin.update(hashNorm, updated);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[claim/update-wallet-json] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/claim/get-admin-factor
 *
 * Dev/test: look up by evm_address + mnemonic_hash, return encrypted admin factor if matched (does not delete the server record).
 * Body: { evm_address, mnemonic_hash }
 */
router.post('/get-admin-factor', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { evm_address, mnemonic_hash } = req.body || {};
    const hashNorm = String(mnemonic_hash || '').replace(/^0x/i, '').trim().toLowerCase();
    if (hashNorm.length !== 64 || !/^[0-9a-f]+$/.test(hashNorm)) {
      return res.status(400).json({ error: 'mnemonic_hash must be 64-char hex' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const evmNorm = normalizeAddr(evm_address || req.auth.pubkey);
    if (callerNorm !== evmNorm) {
      return res.status(403).json({ error: 'evm_address must match logged-in wallet' });
    }
    const record = await db.recipientMnemonicAdmin.findById(hashNorm);
    if (!record || normalizeAddr(record.evm_address) !== callerNorm) {
      return res.status(404).json({ error: 'No matching record for this mnemonic hash and wallet' });
    }
    const callerXidentity = await getXidentityByEvm(callerNorm);
    if (!callerXidentity) {
      return res.status(409).json({ error: 'xidentity not found for caller wallet' });
    }
    const encrypted = await ensureEncryptedAdminPayload(
      record,
      callerXidentity,
      async (payload) => {
        await db.recipientMnemonicAdmin.update(hashNorm, {
          ...record,
          admin_factor: null,
          encrypted_admin_factor: payload,
          encrypted_for_xidentity: callerXidentity,
          updated_at: new Date().toISOString(),
        });
      }
    );
    if (!encrypted) {
      return res.status(404).json({ error: 'AdminFactor not yet linked for this recipient' });
    }
    return res.json({ encrypted_admin_factor: encrypted });
  } catch (err) {
    console.error('[claim/get-admin-factor] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/me
 *
 * Recipient-only: returns all released blobs/factors for the logged-in recipient.
 * Caller is identified by req.auth.pubkey (recipient_evm_address). No Wallet ID or Path index needed from user.
 *
 * Data from two sources:
 * 1) Trigger flow: recipientPaths + triggers + releasedFactors (authority submitted release-factors).
 * 2) Plan flow: recipientMnemonicAdmin (authority linked AdminFactor via release link).
 *
 * Returns: { items: [ { wallet_id, path_index, label, encrypted_admin_factor, blob_hex?, recipient_mnemonic_hash?, source?: 'plan' } ] }
 */
router.get('/me', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const callerXidentity = await getXidentityByEvm(callerNorm);
    if (!callerXidentity) {
      return res.status(409).json({ error: 'xidentity not found for caller wallet' });
    }
    const myEntries = [];

    // 1) Trigger flow: use recipientPathIndex for O(K) lookup instead of O(N) findAll
    const indexEntries = await db.recipientPathIndex.findByRecipientAddress(callerNorm);
    const myWalletIds = [...new Set(indexEntries.map(e => e.wallet_id))];

    for (const walletIdNorm of myWalletIds) {
      const pathConfigs = await db.recipientPaths.findByWallet(walletIdNorm);
      if (pathConfigs.length === 0) continue;
      const rec = pathConfigs[0];
      const walletId = rec.wallet_id;
      const paths = rec.paths || [];
      const myPaths = paths.filter(p => {
        const r = p.recipient_evm_address;
        return r && normalizeAddr(r) === callerNorm;
      });
      if (myPaths.length === 0) continue;

      const triggers = await db.triggers.findByWallet(walletId);
      const releasedTrigger = triggers.find(t => t.status === 'released');
      if (!releasedTrigger) continue;

      const releasedRecords = await db.releasedFactors.findByWallet(walletId);
      if (releasedRecords.length === 0) continue;

      const latestRelease = releasedRecords[releasedRecords.length - 1];
      for (const mp of myPaths) {
        const factor = latestRelease.factors.find(f => f.index === mp.index);
        if (!factor) continue;
        let encrypted = await getEncryptedPayloadFromBindingManifest(
          walletId,
          releasedTrigger.authority_id || '',
          mp.index
        );
        try {
          if (!encrypted) {
            const plainHex = decryptAdminFactor(factor.admin_factor_hex);
            encrypted = await encryptAdminFactorForXidentity(plainHex, callerXidentity);
          }
        } catch (_) {
          continue;
        }
        myEntries.push({
          wallet_id: walletId,
          path_index: mp.index,
          label: mp.label || `Recipient #${mp.index}`,
          encrypted_admin_factor: encrypted,
          blob_hex: factor.blob_hex || null,
          recipient_mnemonic_hash: mp.recipient_mnemonic_hash || null,
          created_at: latestRelease.created_at || releasedTrigger.decided_at || null,
        });
      }
    }

    // 2) Plan flow: recipientMnemonicAdmin (AdminFactor linked via release link)
    //    Deduplicate: keep only the latest record per (plan_wallet_id, label).
    const planRows = await db.recipientMnemonicAdmin.findByEvmAddressWithAdminFactor(callerNorm);
    const planLatest = new Map(); // key = "walletId|label" → latest row
    for (const r of planRows) {
      const dedupeKey = (r.plan_wallet_id || '') + '|' + (r.label || 'Release');
      const existing = planLatest.get(dedupeKey);
      if (!existing || (r.created_at && (!existing.created_at || r.created_at > existing.created_at))) {
        planLatest.set(dedupeKey, r);
      }
    }
    for (const r of planLatest.values()) {
      // Look up recipient index using wallet id variants (raw / normalized / 0x-prefixed).
      const pathIndex = await findRecipientPathIndex(r.plan_wallet_id || '', r.evm_address || '');
      let encrypted = null;
      if (r.plan_wallet_id && Number.isFinite(Number(pathIndex)) && Number(pathIndex) > 0) {
        // Prefer the exact encrypted credential payload that was stored for this recipient path.
        encrypted = await getEncryptedPayloadFromBindingManifest(
          r.plan_wallet_id,
          '',
          Number(pathIndex)
        );
      }
      if (!encrypted) {
        encrypted = await ensureEncryptedAdminPayload(
        r,
        callerXidentity,
        async (payload) => {
          const id = String(r.mnemonic_hash || '').trim().toLowerCase();
          if (!isValidMnemonicHash(id)) return;
          await db.recipientMnemonicAdmin.update(id, {
            ...r,
            admin_factor: null,
            encrypted_admin_factor: payload,
            encrypted_for_xidentity: callerXidentity,
            updated_at: new Date().toISOString(),
          });
        }
        );
      }
      if (!encrypted) continue;
      myEntries.push({
        wallet_id: r.plan_wallet_id || null,
        path_index: pathIndex,
        label: r.label || 'Release',
        encrypted_admin_factor: encrypted,
        blob_hex: null,
        recipient_mnemonic_hash: r.mnemonic_hash || null,
        evm_address: r.evm_address || null,
        source: 'plan',
        created_at: r.created_at || null,
      });
    }

    return res.json({ items: myEntries });
  } catch (err) {
    console.error('[claim/me] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/escrow-config
 *
 * Return VaultShareEscrow + Vault addresses and chain info for frontend tx building.
 */
router.get('/escrow-config', (req, res) => {
  const escrowAddr = (config.escrow?.address || '').trim();
  const vaultAddr = (process.env.VAULT_ADDRESS || '').trim();
  const chainId = config.escrow?.chainId || '11155111';
  const rpcUrl = config.escrow?.rpcUrl || 'https://ethereum-sepolia-rpc.publicnode.com';
  const enabled = !!(escrowAddr && vaultAddr);
  return res.json({
    escrowAddress: escrowAddr,
    vaultAddress: vaultAddr,
    chainId,
    rpcUrl,
    enabled,
  });
});

/**
 * GET /api/claim/escrow-balance?walletId=...&recipientIndex=...
 *
 * Query VaultShareEscrow for a recipient's claimable balance.
 * Returns allocated shares, remaining shares, and underlying asset values.
 * Security: caller must be plan owner or an authorized recipient for this wallet.
 */
router.get('/escrow-balance', async (req, res) => {
  try {
    if (!req.auth?.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    let walletId = (req.query.walletId || req.query.wallet_id || '').trim();
    const recipientIndex = parseInt(req.query.recipientIndex || req.query.recipient_index, 10);
    if (!walletId) {
      return res.status(400).json({ error: 'walletId is required' });
    }
    if (isNaN(recipientIndex) || recipientIndex < 0) {
      return res.status(400).json({ error: 'recipientIndex must be a non-negative integer' });
    }
    // Resolve path config for auth (raw / no-0x / 0x forms), since DB key is hash(wallet_id string).
    const walletNorm = normalizeAddr(walletId);
    const walletCandidates = [...new Set([
      walletId,
      walletNorm,
      walletNorm ? `0x${walletNorm}` : '',
    ].filter(Boolean))];
    let pathConfigs = [];
    for (const walletKey of walletCandidates) {
      pathConfigs = await db.recipientPaths.findByWallet(walletKey);
      if (pathConfigs.length > 0) break;
    }
    if (pathConfigs.length > 0 && pathConfigs[0]?.wallet_id) {
      walletId = String(pathConfigs[0].wallet_id).trim();
    }
    const paths = pathConfigs.length > 0 ? pathConfigs[0].paths || [] : [];
    if (!isAuthorized(req.auth.pubkey, walletId, paths)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view escrow balance for your own plan or as an authorized recipient',
      });
    }
    // Ensure 0x prefix for EVM addresses — plan_wallet_id may be stored without it,
    // but the escrow contract hashes the 0x-prefixed address.
    if (/^[0-9a-fA-F]{40}$/.test(walletId)) {
      walletId = '0x' + walletId;
    }
    const wHash = escrowContract.walletIdHash(walletId);
    const balance = await escrowContract.getRecipientBalance(config, wHash, recipientIndex);
    if (!balance) {
      return res.json({
        walletIdHash: wHash,
        recipientIndex,
        configured: false,
        error: 'VaultShareEscrow not configured or query failed',
      });
    }
    return res.json({
      walletIdHash: wHash,
      recipientIndex,
      configured: true,
      ...balance,
    });
  } catch (err) {
    console.error('[claim/escrow-balance] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/by-mnemonic-hash?hash=...
 *
 * Look up released blobs by recipient mnemonic hash (no login). So mnemonic-hash and blob are tied:
 * recipient registers hash; at release, blob is stored with that hash; recipient can fetch blob by sending hash(mnemonic).
 * Returns: { items: [ { wallet_id, path_index, label, encrypted_admin_factor, blob_hex? } ] }
 */
router.get('/by-mnemonic-hash', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const callerXidentity = await getXidentityByEvm(callerNorm);
    if (!callerXidentity) {
      return res.status(409).json({ error: 'xidentity not found for caller wallet' });
    }

    const hashParam = (req.query.hash || req.query.mnemonic_hash || '').trim().replace(/^0x/i, '');
    if (!isValidMnemonicHash(hashParam)) {
      return res.status(400).json({ error: 'hash must be a 64-char hex string (mnemonic hash)' });
    }
    const hashNorm = hashParam.toLowerCase();

    // Use mnemonicHashIndex for O(K) lookup instead of O(N) findAll
    const hashIndexEntries = await db.mnemonicHashIndex.findByHash(hashNorm);
    const matchedWalletIds = [...new Set(hashIndexEntries.map(e => e.wallet_id))];

    const myEntries = [];
    for (const walletIdNorm of matchedWalletIds) {
      const pathConfigs = await db.recipientPaths.findByWallet(walletIdNorm);
      if (pathConfigs.length === 0) continue;
      const rec = pathConfigs[0];
      const walletId = rec.wallet_id;
      const paths = rec.paths || [];
      // Security: hash lookup must still be bound to the logged-in recipient.
      // Prevent other authenticated users from querying by hash only.
      const matchingPaths = paths.filter((p) => {
        if (!p.recipient_mnemonic_hash || p.recipient_mnemonic_hash !== hashNorm) return false;
        const recipientAddr = p.recipient_evm_address;
        return !!recipientAddr && normalizeAddr(recipientAddr) === callerNorm;
      });
      if (matchingPaths.length === 0) continue;

      const triggers = await db.triggers.findByWallet(walletId);
      const releasedTrigger = triggers.find(t => t.status === 'released');
      if (!releasedTrigger) continue;

      const releasedRecords = await db.releasedFactors.findByWallet(walletId);
      if (releasedRecords.length === 0) continue;

      const latestRelease = releasedRecords[releasedRecords.length - 1];
      for (const mp of matchingPaths) {
        const factor = latestRelease.factors.find(f => f.index === mp.index);
        if (!factor) continue;
        let encrypted;
        try {
          const plainHex = decryptAdminFactor(factor.admin_factor_hex);
          encrypted = await encryptAdminFactorForXidentity(plainHex, callerXidentity);
        } catch (_) {
          continue;
        }
        myEntries.push({
          wallet_id: walletId,
          path_index: mp.index,
          label: mp.label || `Recipient #${mp.index}`,
          encrypted_admin_factor: encrypted,
          blob_hex: factor.blob_hex || null,
        });
      }
    }

    return res.json({ items: myEntries });
  } catch (err) {
    console.error('[claim/by-mnemonic-hash] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:wallet_id', async (req, res) => {
  try {
    const { wallet_id } = req.params;
    if (!wallet_id) {
      return res.status(400).json({ error: 'wallet_id is required' });
    }

    // Security: verify caller is wallet owner or an authorized recipient
    const pathConfigs = await db.recipientPaths.findByWallet(wallet_id);
    const paths = pathConfigs.length > 0 ? pathConfigs[0].paths : [];
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!isAuthorized(req.auth.pubkey, wallet_id, paths)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view released factors for your own wallet or as an authorized recipient',
      });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const ownerNorm = normalizeAddr(wallet_id);
    const isOwnerCaller = callerNorm === ownerNorm;
    const callerXidentity = await getXidentityByEvm(callerNorm);
    if (!callerXidentity) {
      return res.status(409).json({ error: 'xidentity not found for caller wallet' });
    }

    // Check if there are released triggers for this wallet
    const triggers = await db.triggers.findByWallet(wallet_id);
    const releasedTrigger = triggers.find(t => t.status === 'released');

    if (!releasedTrigger) {
      return res.json({
        wallet_id,
        released: false,
        message: 'No released triggers found for this wallet. Contact the managing authority.',
        factors: [],
      });
    }

    // Verify on-chain attestation before revealing admin factors (if oracle is configured).
    // This ensures the claim flow can't bypass the attestation gate.
    if (config.oracle && config.oracle.enabled) {
      const recipientIndices = paths.map(p => p.index);
      const recipientPath = paths.find(p => p.recipient_evm_address && normalizeAddr(p.recipient_evm_address) === callerNorm);
      const checkIndex = recipientPath ? recipientPath.index : (recipientIndices[0] || 0);
      try {
        const gate = await evaluateReleaseAttestationGate({
          walletId: wallet_id,
          recipientIndex: checkIndex,
          allowFallback: true, // allow fallback for claim (emergency recovery)
        });
        if (!gate.valid && gate.code !== 'ATTESTATION_MISSING') {
          return res.json({
            wallet_id,
            released: true,
            attestation_blocked: true,
            attestation_code: gate.code,
            message: gate.detail || 'Release blocked by attestation policy',
            factors: [],
          });
        }
      } catch (attestErr) {
        console.warn('[claim/lookup] Attestation gate check failed (non-blocking):', attestErr.message);
        // Non-blocking: if attestation check fails (e.g. RPC down), allow claim to proceed
        // The on-chain escrow contract enforces attestation anyway
      }
    }

    // Get released factors
    const releasedRecords = await db.releasedFactors.findByWallet(wallet_id);
    if (releasedRecords.length === 0) {
      return res.json({
        wallet_id,
        released: true,
        message: 'Trigger is released but admin factors have not been submitted yet. Contact the managing authority.',
        factors: [],
      });
    }

    // Reuse path config from auth check for labels/weights
    const totalWeight = pathConfigs.length > 0 ? pathConfigs[0].total_weight : 0;

    // Merge released factors with path config (include blob_hex when stored)
    const latestRelease = releasedRecords[releasedRecords.length - 1];
    const factorsRaw = latestRelease.factors.map(f => {
      const pathInfo = paths.find(p => p.index === f.index);
      // Security: recipient callers can only see their own path factor.
      if (!isOwnerCaller) {
        if (!pathInfo || !pathInfo.recipient_evm_address) return null;
        if (normalizeAddr(pathInfo.recipient_evm_address) !== callerNorm) return null;
      }
      const out = {
        index: f.index,
        encrypted_admin_factor: null,
        fingerprint: f.fingerprint,
        label: pathInfo ? pathInfo.label : `Recipient #${f.index}`,
        weight: pathInfo ? pathInfo.weight : 0,
        percentage: pathInfo ? pathInfo.percentage : '0.00',
        recipient_evm_address: pathInfo ? (pathInfo.recipient_evm_address || null) : null,
      };
      const plainHex = decryptAdminFactor(f.admin_factor_hex);
      out.encrypted_admin_factor = null;
      return encryptAdminFactorForXidentity(plainHex, callerXidentity)
        .then((encrypted) => {
          out.encrypted_admin_factor = encrypted;
          if (f.blob_hex) out.blob_hex = f.blob_hex;
          if (f.recipient_mnemonic_hash) out.recipient_mnemonic_hash = f.recipient_mnemonic_hash;
          return out;
        })
        .catch(() => null);
    });
    const factors = (await Promise.all(factorsRaw)).filter(Boolean);

    // Try to get vault value from config (optional, best-effort)
    let vaultValue = null;
    try {
      const config = require('../../config');
      const vaultAddr = config.contracts?.vaultAddress;
      if (vaultAddr) {
        const vaultContract = require('../../services/vaultContract');
        const bal = await vaultContract.getVaultBalance(config, wallet_id.startsWith('0x') ? wallet_id : '0x' + wallet_id);
        if (bal && parseFloat(bal.assets) > 0) vaultValue = bal.assets;
      }
      if (vaultValue == null) vaultValue = '0.00';
    } catch {
      vaultValue = '0.00';
    }

    return res.json({
      wallet_id,
      released: true,
      trigger_id: releasedTrigger.trigger_id,
      factors,
      total_weight: totalWeight,
      vault_value: vaultValue,
    });
  } catch (err) {
    console.error('[claim/lookup] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
