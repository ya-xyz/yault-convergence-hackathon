/**
 * path-manager.js — Recipient Path Lifecycle Manager
 *
 * ⚠️ DEPRECATED / ALTERNATE IMPLEMENTATION
 *
 * This module implements an ALTERNATE credential flow that is NOT compatible
 * with the active client-portal.js flow used in the web application.
 *
 * KEY DIFFERENCES from client-portal.js (the active flow):
 *   - Uses custody_generate_path() with word-list passphrase (vs random password in client-portal)
 *   - E2E encrypts AdminFactor for each authority
 *   - Uses tlock (drand) for time-locked encryption
 *   - Generates UserCred from 256-word list (vs generateRandomPassphrase(12) in client-portal)
 *   - Does NOT use Yallet extension's yallet_changePassphraseWithAdmin()
 *
 * The ACTIVE flow in client-portal.js:
 *   1. AdminFactor = custody_generate_admin_factor() (WASM, 256-bit random)
 *   2. UserCred = generateRandomPassphrase(12) (random 12-char password)
 *   3. Mnemonic = yallet_changePassphraseWithAdmin(UserCred, AdminFactor) (Yallet extension)
 *   4. NFT = prepareCredentialNftPayload(mnemonic, passphrase) → Arweave
 *   5. AdminFactor stored separately on platform
 *
 * This module is retained for potential future use cases (e.g., non-Yallet
 * deployments, batch operations, or SDK-only integrations) but should NOT
 * be mixed with the client-portal flow.
 *
 * Orchestrates the full lifecycle of a recipient release path:
 *   create -> distribute -> renew -> revoke -> replace
 *
 * Local storage key: "yault_release_paths"
 *
 * Dependencies: WASM core, authority-crypto.js, arweave-nft.js, tlock.js
 */

import {
  custody_generate_admin_factor,
  custody_generate_path,
  custody_derive_backup_key,
  custody_encrypt_backup,
  custody_admin_factor_fingerprint,
  custody_build_composite,
} from '../../wasm-core/pkg/yault_custody_wasm';

import { distributeToAuthorities } from './authority-crypto.js';
import {
  uploadTriggerNFT,
  uploadRecoveryNFT,
  getLatestTriggerNFT,
  markNFTSuperseded,
} from './arweave-nft.js';
import {
  computeFutureRound,
  encryptReleaseRequest,
  buildReleaseRequest,
} from './tlock.js';

// ─── Constants ───

const STORAGE_KEY = 'yault_release_paths';
// Trigger NFT uses a far-future tlock round (100 years) so it never auto-expires.
// Release is triggered solely by authority legal-event initiation.
const DEFAULT_TRIGGER_MONTHS = 1200; // 100 years — effectively "never"

// ─── Path Status Enum ───

const PathStatus = {
  ACTIVE: 'active',
  TRIGGERED: 'triggered',
  RELEASED: 'released',
  ACTIVATED: 'activated',
  REVOKED: 'revoked',
};

// ─── #7 FIX: Web Crypto API encryption helpers (PBKDF2 + AES-GCM) ───

let _storageKey = null; // CryptoKey derived from wallet signature

/**
 * Derive an AES-GCM key from a wallet signature using PBKDF2.
 * Call this once after wallet connection (e.g., on first sign-in).
 *
 * @param {string} walletSignature - Hex-encoded signature used as key material.
 */
export async function initStorageKey(walletSignature) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(walletSignature),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  // Use a per-user random salt instead of a hardcoded one.
  // Generate or retrieve salt from localStorage.
  let saltHex = localStorage.getItem(STORAGE_KEY + ':salt');
  if (!saltHex) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(STORAGE_KEY + ':salt', saltHex);
  }
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  _storageKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a string using AES-GCM with the derived storage key.
 * @param {string} plaintext
 * @returns {Promise<string>} Base64-encoded iv:ciphertext
 */
async function _encrypt(plaintext) {
  if (!_storageKey) throw new Error('Storage key not initialized. Call initStorageKey() first.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    _storageKey,
    enc.encode(plaintext),
  );
  // Combine iv + ciphertext as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded iv:ciphertext string.
 * @param {string} encoded
 * @returns {Promise<string>} Decrypted plaintext
 */
async function _decrypt(encoded) {
  if (!_storageKey) throw new Error('Storage key not initialized. Call initStorageKey() first.');
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const dec = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    _storageKey,
    ciphertext,
  );
  return dec.decode(plaintext);
}

// ─── Internal Helpers ───

/**
 * Check a WASM string result for the "error:" prefix.
 *
 * @param {string} result
 * @returns {string}
 */
function _checkWasmResult(result) {
  if (typeof result === 'string' && result.startsWith('error:')) {
    throw new Error(result.substring(6));
  }
  return result;
}

/**
 * Check a WASM JsValue result for the error flag.
 *
 * @param {object} result
 * @returns {object}
 */
function _checkWasmObject(result) {
  if (result && result.error === true) {
    throw new Error(result.message || 'WASM operation failed');
  }
  return result;
}

/**
 * #7 FIX: Load all paths from local storage with encryption support.
 * Tries to decrypt first; falls back to plaintext JSON for migration.
 *
 * @returns {Promise<Array<object>>}
 */
async function _loadPaths() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    // If storage key is available, try decryption first
    if (_storageKey) {
      try {
        const decrypted = await _decrypt(raw);
        return JSON.parse(decrypted);
      } catch {
        // Decryption failed — attempt one-time migration from plaintext
        try {
          const paths = JSON.parse(raw);
          if (Array.isArray(paths)) {
            // Re-save encrypted (migration)
            await _savePaths(paths);
            return paths;
          }
        } catch {
          // Not valid JSON either — corrupted data
        }
      }
    }

    // No storage key — cannot decrypt; return empty to avoid exposing plaintext
    console.warn('[path-manager] Cannot load paths: storage key not initialized');
    return [];
  } catch {
    return [];
  }
}

/**
 * #7 FIX: Save all paths to local storage with encryption if key is available.
 *
 * @param {Array<object>} paths
 */
async function _savePaths(paths) {
  const json = JSON.stringify(paths);
  if (_storageKey) {
    const encrypted = await _encrypt(json);
    localStorage.setItem(STORAGE_KEY, encrypted);
  } else {
    console.warn('[path-manager] Cannot save paths: storage key not initialized');
    // Do NOT store plaintext - skip save
  }
}

/**
 * Find a path by its recipient index.
 *
 * @param {number} index
 * @returns {{ path: object|null, pathIndex: number }}
 */
async function _findPathByIndex(index) {
  const paths = await _loadPaths();
  const pathIndex = paths.findIndex((p) => p.recipientIndex === index);
  return {
    path: pathIndex >= 0 ? paths[pathIndex] : null,
    pathIndex,
  };
}

/**
 * Generate the next available recipient index.
 *
 * @returns {Promise<number>}
 */
async function _nextIndex() {
  const paths = await _loadPaths();
  if (paths.length === 0) return 1;
  return Math.max(...paths.map((p) => p.recipientIndex)) + 1;
}

// ─── Exported Functions ───

/**
 * Create a new recipient release path.
 *
 * This is the main orchestration function that:
 *   1. Generates credentials via WASM (UserCred, AdminFactor, etc.)
 *   2. E2E encrypts the AdminFactor and distributes to authorities
 *   3. Creates an encrypted backup (Recovery NFT) on Arweave
 *   4. Creates a tlock-encrypted Trigger NFT on Arweave
 *   5. Persists the path metadata to local storage
 *
 * @param {string} revHex - Owner's REV (Root Entropy Value) as hex.
 * @param {string} label - Human-readable label (e.g. "Son - Jason").
 * @param {Array<{ id: string, publicKeyHex: string }>} authorities
 *   - Authorities to distribute AdminFactor shares to.
 * @param {{ email?: string, phone?: string, name?: string }} contact
 *   - Contact info for the recipient (encrypted in the Trigger NFT).
 * @param {string} walletId - Owner's wallet identifier.
 * @param {object} arweaveWallet - Arweave JWK wallet for uploads.
 * @param {{ threshold?: number, triggerMonths?: number }} [options]
 * @returns {Promise<{
 *   recipientIndex: number,
 *   label: string,
 *   userCred: string,
 *   adminFactorFingerprint: string,
 *   triggerNftTxId: string,
 *   recoveryNftTxId: string,
 *   authorityConfig: { total: number },
 *   tlockRound: number,
 *   status: string,
 * }>}
 */
export async function createRecipientPath(revHex, label, authorities, contact, walletId, arweaveWallet, options = {}) {
  if (!revHex || !label || !walletId) {
    throw new Error('revHex, label, and walletId are required');
  }
  if (!Array.isArray(authorities) || authorities.length < 2) {
    throw new Error('At least 2 authorities are required');
  }

  const index = await _nextIndex();
  const triggerMonths = options.triggerMonths || DEFAULT_TRIGGER_MONTHS;

  // Step 1: Generate recipient path credentials via WASM
  const pathCreds = custody_generate_path(index, label);
  _checkWasmObject(pathCreds);

  // The AdminFactor is generated as part of the path
  const adminFactorHex = pathCreds.admin_factor_hex;
  const userCred = pathCreds.user_cred;

  // Step 2: Compute AdminFactor fingerprint for verification
  const fingerprint = custody_admin_factor_fingerprint(adminFactorHex);
  _checkWasmResult(fingerprint);

  // Step 3: Distribute AdminFactor to authorities via E2E encryption
  const distribution = await distributeToAuthorities(
    adminFactorHex,
    authorities,
    null,
    walletId,
    index,
  );

  // Verify at least one authority received the encrypted AdminFactor
  const deliveredCount = distribution.shares.filter(d => d.delivered).length;
  if (deliveredCount < 1) {
    throw new Error(
      `No authorities received the AdminFactor. ` +
      `Cannot safely activate path. Please retry or check authority connectivity.`
    );
  }

  // Step 4: Create encrypted backup (Recovery NFT)
  // Derive backup key from REV + recipient context
  const backupKeyHex = custody_derive_backup_key(revHex, index);
  _checkWasmResult(backupKeyHex);

  // Encrypt the AdminFactor with the backup key
  const encryptedAF = custody_encrypt_backup(adminFactorHex, backupKeyHex);
  _checkWasmResult(encryptedAF);

  // Upload Recovery NFT to Arweave
  const { txId: recoveryNftTxId } = await uploadRecoveryNFT(
    walletId,
    index,
    encryptedAF,
    fingerprint,
    arweaveWallet,
  );

  // Step 5: Create Trigger NFT with tlock encryption
  const { round: tlockRound } = computeFutureRound(triggerMonths);

  const releaseRequestJson = buildReleaseRequest(
    walletId,
    index,
    authorities[0].id, // primary authority
    contact,
  );

  const tlockCiphertext = await encryptReleaseRequest(releaseRequestJson, tlockRound);

  const { txId: triggerNftTxId } = await uploadTriggerNFT(
    walletId,
    index,
    authorities[0].id,
    tlockCiphertext,
    tlockRound,
    arweaveWallet,
  );

  // Step 6: Persist path metadata
  const pathRecord = {
    recipientIndex: index,
    label,
    walletId,
    userCred, // The recipient needs this to activate
    adminFactorFingerprint: fingerprint,
    triggerNftTxId,
    recoveryNftTxId,
    authorityConfig: {
      total: distribution.totalAuthorities,
    },
    authorityIds: authorities.map((lf) => lf.id),
    tlockRound,
    status: PathStatus.ACTIVE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const paths = await _loadPaths();
  paths.push(pathRecord);
  await _savePaths(paths);

  return {
    recipientIndex: index,
    label,
    userCred,
    adminFactorFingerprint: fingerprint,
    triggerNftTxId,
    recoveryNftTxId,
    authorityConfig: { total: distribution.totalAuthorities },
    tlockRound,
    status: PathStatus.ACTIVE,
  };
}

/**
 * List all recipient paths from local storage.
 *
 * @returns {Array<{
 *   recipientIndex: number,
 *   label: string,
 *   status: string,
 *   authorityIds: string[],
 *   authorityConfig: { total: number },
 *   tlockRound: number,
 *   createdAt: string,
 *   updatedAt: string,
 * }>}
 */
export async function listRecipientPaths() {
  return (await _loadPaths()).map((p) => ({
    recipientIndex: p.recipientIndex,
    label: p.label,
    status: p.status,
    authorityIds: p.authorityIds || [],
    authorityConfig: p.authorityConfig || p.shamirConfig,
    tlockRound: p.tlockRound,
    adminFactorFingerprint: p.adminFactorFingerprint,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

/**
 * Get detailed status for a recipient path.
 *
 * Checks on-chain state (Arweave) to determine the current lifecycle stage.
 *
 * @param {number} recipientIndex - 1-based recipient index.
 * @returns {Promise<{
 *   status: string,
 *   tlockRound: number|null,
 *   monthsRemaining: number|null,
 *   triggerNftTxId: string|null,
 *   hasReleaseRecord: boolean,
 * }>}
 */
export async function getRecipientPathStatus(recipientIndex) {
  const { path } = await _findPathByIndex(recipientIndex);

  if (!path) {
    throw new Error(`Recipient path ${recipientIndex} not found`);
  }

  // Check Arweave for latest state
  let latestTrigger = null;
  try {
    latestTrigger = await getLatestTriggerNFT(path.walletId, recipientIndex);
  } catch {
    // Arweave query failure; fall back to local state
  }

  const currentTlockRound = latestTrigger?.tags?.['Tlock-Round']
    ? parseInt(latestTrigger.tags['Tlock-Round'], 10)
    : path.tlockRound;

  // Calculate months remaining
  let monthsRemaining = null;
  if (currentTlockRound) {
    const DRAND_GENESIS = 1595431050;
    const DRAND_PERIOD = 30;
    const nowSec = Math.floor(Date.now() / 1000);
    const deadlineTimestamp = DRAND_GENESIS + (currentTlockRound - 1) * DRAND_PERIOD;
    const remainingSec = deadlineTimestamp - nowSec;
    monthsRemaining = Math.max(0, remainingSec / (30.44 * 24 * 3600));
    monthsRemaining = Math.round(monthsRemaining * 10) / 10;
  }

  return {
    status: path.status,
    tlockRound: currentTlockRound,
    monthsRemaining,
    triggerNftTxId: latestTrigger?.txId || path.triggerNftTxId || null,
    hasReleaseRecord: path.status === PathStatus.RELEASED || path.status === PathStatus.ACTIVATED,
  };
}

/**
 * Revoke and rotate a recipient path (key rotation).
 *
 * Despite the name, this function performs a **key rotation** rather than a
 * simple revocation. It generates a new AdminFactor, re-seals the path,
 * re-distributes encrypted AdminFactor to authorities, and supersedes the old Trigger
 * and Recovery NFTs on Arweave. The path remains ACTIVE with fresh
 * credentials, so the recipient's release entitlement is preserved
 * while the old key material is invalidated.
 *
 * The status is intentionally set to ACTIVE (not REVOKED) because the path
 * continues to exist with new credentials. To fully deactivate a path
 * without replacement, a separate deactivation flow should be used.
 *
 * @param {number} recipientIndex - 1-based index of the path to revoke.
 * @param {string} revHex - Owner's REV for backup key derivation.
 * @param {Array<{ id: string, publicKeyHex: string }>} authorities - Authorities for re-distribution.
 * @param {string} walletId - Owner's wallet ID.
 * @param {object} arweaveWallet - Arweave JWK wallet.
 * @returns {Promise<{ newAdminFactorFingerprint: string, newTriggerNftTxId: string }>}
 */
export async function revokeRecipientPath(recipientIndex, revHex, authorities, walletId, arweaveWallet) {
  const { path, pathIndex } = await _findPathByIndex(recipientIndex);
  if (!path) {
    throw new Error(`Recipient path ${recipientIndex} not found`);
  }

  if (path.status === PathStatus.REVOKED) {
    throw new Error(`Path ${recipientIndex} is already revoked`);
  }

  // Generate new AdminFactor
  const newAF = custody_generate_admin_factor();
  _checkWasmObject(newAF);
  const newAdminFactorHex = newAF.admin_factor_hex;

  const newFingerprint = custody_admin_factor_fingerprint(newAdminFactorHex);
  _checkWasmResult(newFingerprint);

  // Re-distribute to authorities
  await distributeToAuthorities(newAdminFactorHex, authorities, null, walletId, recipientIndex);

  // Create new Recovery NFT
  const backupKeyHex = custody_derive_backup_key(revHex, recipientIndex);
  _checkWasmResult(backupKeyHex);

  const encryptedAF = custody_encrypt_backup(newAdminFactorHex, backupKeyHex);
  _checkWasmResult(encryptedAF);

  const { txId: newRecoveryTxId } = await uploadRecoveryNFT(
    walletId,
    recipientIndex,
    encryptedAF,
    newFingerprint,
    arweaveWallet,
  );

  // Create new Trigger NFT
  const { round: newRound } = computeFutureRound(DEFAULT_TRIGGER_MONTHS);
  const releaseRequestJson = buildReleaseRequest(
    walletId,
    recipientIndex,
    authorities[0].id,
    {},
  );
  const tlockCiphertext = await encryptReleaseRequest(releaseRequestJson, newRound);

  const { txId: newTriggerTxId } = await uploadTriggerNFT(
    walletId,
    recipientIndex,
    authorities[0].id,
    tlockCiphertext,
    newRound,
    arweaveWallet,
  );

  // Supersede old NFTs
  if (path.triggerNftTxId) {
    try {
      await markNFTSuperseded(path.triggerNftTxId, newTriggerTxId, walletId, arweaveWallet);
    } catch (err) { console.warn('[path-manager] Non-fatal: failed to mark trigger NFT superseded:', err.message); }
  }
  if (path.recoveryNftTxId) {
    try {
      await markNFTSuperseded(path.recoveryNftTxId, newRecoveryTxId, walletId, arweaveWallet);
    } catch (err) { console.warn('[path-manager] Non-fatal: failed to mark recovery NFT superseded:', err.message); }
  }

  // Update local storage
  const paths = await _loadPaths();
  if (paths[pathIndex]) {
    paths[pathIndex] = {
      ...paths[pathIndex],
      adminFactorFingerprint: newFingerprint,
      triggerNftTxId: newTriggerTxId,
      recoveryNftTxId: newRecoveryTxId,
      authorityIds: authorities.map((lf) => lf.id),
      tlockRound: newRound,
      status: PathStatus.ACTIVE,
      updatedAt: new Date().toISOString(),
    };
    await _savePaths(paths);
  }

  return {
    newAdminFactorFingerprint: newFingerprint,
    newTriggerNftTxId: newTriggerTxId,
  };
}

/**
 * Replace an authority in a recipient path.
 *
 * Generates a new AdminFactor (since the old authority holds a share of
 * the old one), re-distributes to the updated set of authorities, and
 * supersedes existing NFTs.
 *
 * @param {number} recipientIndex - 1-based index.
 * @param {string} oldAuthorityId - ID of the authority being replaced.
 * @param {{ id: string, publicKeyHex: string }} newAuthority - Replacement authority.
 * @param {string} revHex - Owner's REV.
 * @param {string} walletId - Owner's wallet ID.
 * @param {Array<{ id: string, publicKeyHex: string }>} allAuthorities
 *   - Full list of authorities after replacement.
 * @param {object} arweaveWallet - Arweave JWK wallet.
 * @returns {Promise<{ newAdminFactorFingerprint: string }>}
 */
export async function replaceAuthority(recipientIndex, oldAuthorityId, newAuthority, revHex, walletId, allAuthorities, arweaveWallet) {
  const { path } = await _findPathByIndex(recipientIndex);
  if (!path) {
    throw new Error(`Recipient path ${recipientIndex} not found`);
  }

  if (!path.authorityIds.includes(oldAuthorityId)) {
    throw new Error(`Authority ${oldAuthorityId} is not bound to path ${recipientIndex}`);
  }

  // Since the old authority holds a share, we must generate a new AdminFactor
  // and re-distribute entirely (the old share is now invalid)
  return revokeRecipientPath(recipientIndex, revHex, allAuthorities, walletId, arweaveWallet);
}

/**
 * Export recipient credentials in the specified format.
 *
 * The credentials include the SA (mnemonic), UserCred, and instructions
 * for the recipient to use during the claim process.
 *
 * @param {number} recipientIndex - 1-based index.
 * @param {'text'|'qr'|'pdf'} format - Export format.
 * @returns {Promise<{ format: string, data: string|object }>}
 */
export async function exportCredentials(recipientIndex, format = 'text') {
  const { path } = await _findPathByIndex(recipientIndex);
  if (!path) {
    throw new Error(`Recipient path ${recipientIndex} not found`);
  }

  const credentials = {
    label: path.label,
    recipientIndex: path.recipientIndex,
    userCred: path.userCred,
    walletId: path.walletId,
    instructions: [
      '1. Keep this document in a secure location.',
      '2. You will also need the wallet mnemonic (SA) to claim assets.',
      '3. The AdminFactor will be released by the authority when conditions are met.',
      '4. Visit the Yault Recipient Portal to activate your release path.',
      '5. After activation, transfer assets to your own wallet immediately.',
    ],
  };

  switch (format) {
    case 'text': {
      const lines = [
        `=== Yault Release Credentials ===`,
        `Label: ${credentials.label}`,
        `Recipient Index: ${credentials.recipientIndex}`,
        `User Credential: ${credentials.userCred}`,
        `Wallet ID: ${credentials.walletId}`,
        ``,
        `--- Instructions ---`,
        ...credentials.instructions,
        ``,
        `Generated: ${new Date().toISOString()}`,
      ];
      return { format: 'text', data: lines.join('\n') };
    }

    case 'qr': {
      // Return a JSON payload suitable for QR code generation
      const qrPayload = JSON.stringify({
        v: 1,
        t: 'YALLET_RELEASE_CRED',
        bi: credentials.recipientIndex,
        uc: credentials.userCred,
        wi: credentials.walletId,
      });
      return { format: 'qr', data: qrPayload };
    }

    case 'pdf': {
      // Return structured data for PDF generation (caller uses jsPDF)
      return {
        format: 'pdf',
        data: {
          title: 'Yault Release Credentials',
          subtitle: `Recipient: ${credentials.label}`,
          fields: [
            { label: 'Recipient Index', value: String(credentials.recipientIndex) },
            { label: 'User Credential', value: credentials.userCred },
            { label: 'Wallet ID', value: credentials.walletId },
          ],
          instructions: credentials.instructions,
          generatedAt: new Date().toISOString(),
          disclaimer: 'CONFIDENTIAL: Store this document securely. Anyone with access to these credentials and the wallet mnemonic can claim the released assets.',
        },
      };
    }

    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}
