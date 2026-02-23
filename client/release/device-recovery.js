/**
 * device-recovery.js — Owner Device Recovery
 *
 * When the wallet owner loses their device but is alive, they can recover
 * AdminFactor(s) from the encrypted backups stored on Arweave.
 *
 * Recovery flow:
 *   1. Owner enters their mnemonic + passphrase on a new device
 *   2. The REV is derived from the mnemonic (standard ACE-GF unseal)
 *   3. For each recipient path, a backup key is derived from REV + context
 *   4. The Recovery NFT is fetched from Arweave and decrypted
 *   5. The AdminFactor is recovered, and the path is re-established
 *
 * Note: resetHeartbeat() has been removed. Release triggers are now
 * initiated by authorities via legal-event API, so there is no heartbeat
 * deadline to reset on device recovery.
 *
 * Dependencies: WASM core, arweave-nft.js
 */

import {
  custody_derive_backup_key,
  custody_decrypt_backup,
  custody_admin_factor_fingerprint,
} from '../../wasm-core/pkg/yault_custody_wasm';

import {
  fetchRecoveryNFTs,
} from './arweave-nft.js';

// ─── Constants ───

const ARWEAVE_GATEWAY = 'https://arweave.net';

// ─── Internal Helpers ───

/**
 * Check WASM string result for error prefix.
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
 * Fetch the data body of an Arweave transaction.
 *
 * @param {string} txId
 * @returns {Promise<object>}
 */
async function _fetchTxData(txId) {
  // Validate txId format (Arweave tx IDs are 43-character base64url strings)
  if (!txId || typeof txId !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(txId)) {
    throw new Error(`Invalid Arweave transaction ID: ${txId}`);
  }
  const resp = await fetch(`${ARWEAVE_GATEWAY}/${txId}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Arweave tx ${txId}: ${resp.status}`);
  }
  return resp.json();
}

// ─── Exported Functions ───

/**
 * Recover the AdminFactor for a single recipient path.
 *
 * Derives the backup encryption key from the REV and recipient index,
 * fetches the Recovery NFT from Arweave, and decrypts the AdminFactor.
 *
 * @param {string} revHex - The owner's REV as hex string.
 * @param {number} recipientIndex - 1-based recipient index.
 * @param {string} walletId - The owner's wallet identifier (for Arweave query).
 * @returns {Promise<{
 *   adminFactorHex: string,
 *   fingerprint: string,
 *   recoveryNftTxId: string,
 * }>}
 * @throws {Error} If no Recovery NFT is found or decryption fails.
 */
export async function recoverAdminFactor(revHex, recipientIndex, walletId) {
  if (!revHex) throw new Error('revHex is required');
  if (!Number.isInteger(recipientIndex) || recipientIndex < 1) {
    throw new Error('recipientIndex must be a positive integer');
  }
  if (!walletId) throw new Error('walletId is required');

  // Step 1: Derive backup key from REV + recipient context
  const backupKeyHex = custody_derive_backup_key(revHex, recipientIndex);
  _checkWasmResult(backupKeyHex);

  // Step 2: Fetch Recovery NFTs from Arweave for this wallet
  const recoveryNFTs = await fetchRecoveryNFTs(walletId);

  // Filter to this recipient index
  const matchingNFTs = recoveryNFTs.filter(
    (nft) => nft.tags['Recipient-Index'] === String(recipientIndex)
  );

  if (matchingNFTs.length === 0) {
    throw new Error(
      `No Recovery NFT found for wallet ${walletId}, recipient ${recipientIndex}`
    );
  }

  // Try each matching NFT (latest first, already sorted by block height DESC)
  let lastError = null;
  for (const nft of matchingNFTs) {
    try {
      // Step 3: Fetch the encrypted data from Arweave
      const data = await _fetchTxData(nft.txId);

      if (!data.encryptedAdminFactor) {
        continue; // Skip malformed NFTs
      }

      // Step 4: Decrypt the AdminFactor
      const adminFactorHex = custody_decrypt_backup(
        data.encryptedAdminFactor,
        backupKeyHex,
      );
      _checkWasmResult(adminFactorHex);

      // Step 5: Verify the fingerprint
      const fingerprint = custody_admin_factor_fingerprint(adminFactorHex);
      _checkWasmResult(fingerprint);

      // If the NFT has a stored fingerprint, verify it matches
      if (data.adminFactorFingerprint && data.adminFactorFingerprint !== fingerprint) {
        lastError = new Error('AdminFactor fingerprint mismatch after decryption');
        continue;
      }

      return {
        adminFactorHex,
        fingerprint,
        recoveryNftTxId: nft.txId,
      };
    } catch (err) {
      lastError = err;
      // Try the next NFT
    }
  }

  throw lastError || new Error('Failed to decrypt any Recovery NFT');
}

/**
 * Re-establish all recipient paths after device recovery.
 *
 * For each path, recovers the AdminFactor from Arweave and verifies
 * that the authority bindings are still valid.
 *
 * @param {string} revHex - The owner's REV as hex string.
 * @param {Array<{ recipientIndex: number, walletId: string, authorityIds: string[] }>} paths
 * @returns {Promise<{
 *   recovered: Array<{ recipientIndex: number, adminFactorHex: string, fingerprint: string }>,
 *   failed: Array<{ recipientIndex: number, error: string }>,
 * }>}
 */
export async function reestablishAllPaths(revHex, paths) {
  if (!revHex) throw new Error('revHex is required');
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths array is required and must not be empty');
  }

  const recovered = [];
  const failed = [];

  for (const pathInfo of paths) {
    try {
      const result = await recoverAdminFactor(
        revHex,
        pathInfo.recipientIndex,
        pathInfo.walletId,
      );

      // Verify authority bindings are still active
      let bindingsValid = true;
      if (pathInfo.authorityIds && pathInfo.authorityIds.length > 0) {
        try {
          const params = new URLSearchParams({
            wallet_id: pathInfo.walletId,
          });

          const resp = await fetch(`/api/binding/my?${params}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          });

          if (resp.ok) {
            const bindings = await resp.json();
            const activeBindingIds = new Set(
              (Array.isArray(bindings) ? bindings : [])
                .filter((b) => b.status === 'active')
                .map((b) => b.authority_id)
            );

            bindingsValid = pathInfo.authorityIds.every((id) => activeBindingIds.has(id));
          }
        } catch {
          // Binding verification failure is non-fatal during recovery
          bindingsValid = true; // Assume valid, user can verify later
        }
      }

      recovered.push({
        recipientIndex: pathInfo.recipientIndex,
        adminFactorHex: result.adminFactorHex,
        fingerprint: result.fingerprint,
        bindingsValid,
      });
    } catch (err) {
      failed.push({
        recipientIndex: pathInfo.recipientIndex,
        error: err.message,
      });
    }
  }

  return { recovered, failed };
}
