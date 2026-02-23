/**
 * authority-crypto.js — Client-side Authority Crypto Operations
 *
 * Wrapper around WASM Shamir secret sharing + E2E encryption for
 * distributing AdminFactor shares to authorities.
 *
 * Flow:
 *   1. splitAdminFactor() - Shamir split the AdminFactor into N shares
 *   2. encryptShareForAuthority() - E2E encrypt each share with the authority's public key
 *   3. distributeToAuthorities() - Orchestrate split + encrypt + send via server API
 *   4. verifyShareReceipt() - Confirm authority received and can hold the share
 *
 * Dependencies: WASM core (custody module), server API
 */

import {
  custody_shamir_split,
  custody_shamir_reconstruct,
  custody_encrypt_for_authority,
  custody_admin_factor_fingerprint,
} from '../../wasm-core/pkg/yault_custody_wasm';

// ─── Constants ───

const API_BASE = '/api';

// ─── Internal Helpers ───

/**
 * Check a WASM string result for the "error:" prefix pattern.
 *
 * @param {string} result
 * @returns {string} The result if no error.
 * @throws {Error} If the result starts with "error:".
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
 * @returns {object} The result if no error.
 * @throws {Error} If the result has error: true.
 */
function _checkWasmObject(result) {
  if (result && result.error === true) {
    throw new Error(result.message || 'WASM operation failed');
  }
  return result;
}

// ─── Exported Functions ───

/**
 * Split an AdminFactor into Shamir secret shares.
 *
 * Uses GF(2^8) Shamir secret sharing via WASM. The AdminFactor can be
 * reconstructed from any `threshold` of the `totalShares` shares.
 *
 * @param {string} adminFactorHex - The AdminFactor as a hex string (64 chars = 32 bytes).
 * @param {number} totalShares - Total number of shares to generate (e.g. 3).
 * @param {number} threshold - Minimum shares needed for reconstruction (e.g. 2).
 * @returns {Array<{ index: number, data_hex: string }>} Array of share objects.
 * @throws {Error} If WASM operation fails or parameters are invalid.
 */
export function splitAdminFactor(adminFactorHex, totalShares, threshold) {
  if (!adminFactorHex || adminFactorHex.length !== 64) {
    throw new Error('adminFactorHex must be a 64-character hex string (32 bytes)');
  }
  if (!Number.isInteger(totalShares) || totalShares < 2 || totalShares > 255) {
    throw new Error('totalShares must be an integer between 2 and 255');
  }
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > totalShares) {
    throw new Error('threshold must be an integer between 2 and totalShares');
  }

  const result = custody_shamir_split(adminFactorHex, totalShares, threshold);
  return _checkWasmObject(result);
}

/**
 * Reconstruct the AdminFactor from Shamir shares.
 *
 * Requires at least `threshold` shares (as specified during splitting).
 * Shares can come from different authorities and be in any order.
 *
 * @param {Array<{ index: number, data_hex: string }>} shares
 *   Array of share objects, each with a 1-based index and hex-encoded data.
 * @returns {string} The reconstructed AdminFactor as a hex string.
 * @throws {Error} If reconstruction fails (e.g. insufficient or corrupted shares).
 */
export function reconstructAdminFactor(shares) {
  if (!Array.isArray(shares) || shares.length < 2) {
    throw new Error('At least 2 shares are required for reconstruction');
  }

  for (const share of shares) {
    if (!Number.isInteger(share.index) || !share.data_hex) {
      throw new Error('Each share must have integer index and data_hex string');
    }
  }

  const sharesJson = JSON.stringify(shares);
  const result = custody_shamir_reconstruct(sharesJson);
  return _checkWasmResult(result);
}

/**
 * Encrypt a Shamir share for a specific authority using X25519 ECDH + AES-GCM.
 *
 * The authority's public key is used for an ephemeral Diffie-Hellman key exchange.
 * The resulting shared secret encrypts the share data. Only the authority's
 * private key can decrypt it.
 *
 * @param {string} shareDataHex - The Shamir share data as a hex string.
 * @param {string} authorityPubkeyHex - The authority's X25519 public key (hex, 64 chars).
 * @returns {{ package_hex: string, ephemeral_pubkey_hex: string }}
 *   The encrypted package and the ephemeral public key for the authority to use.
 * @throws {Error} If encryption fails.
 */
export function encryptShareForAuthority(shareDataHex, authorityPubkeyHex) {
  if (!shareDataHex) {
    throw new Error('shareDataHex is required');
  }
  if (!authorityPubkeyHex || authorityPubkeyHex.length !== 64) {
    throw new Error('authorityPubkeyHex must be a 64-character hex string');
  }

  const result = custody_encrypt_for_authority(shareDataHex, authorityPubkeyHex);
  return _checkWasmObject(result);
}

/**
 * Distribute AdminFactor shares to multiple authorities.
 *
 * This is the high-level orchestration function that:
 *   1. Splits the AdminFactor into Shamir shares (one per authority)
 *   2. Encrypts each share with the respective authority's public key
 *   3. Sends each encrypted share to the server API for delivery
 *   4. Records the AdminFactor fingerprint for later verification
 *
 * @param {string} adminFactorHex - The AdminFactor hex string (64 chars).
 * @param {Array<{ id: string, publicKeyHex: string }>} authorities
 *   Array of authority objects, each with an ID and X25519 public key.
 * @param {number} threshold - Minimum shares for reconstruction (default: ceil(N * 2/3)).
 * @param {string} walletId - Owner's wallet ID for the binding record.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @returns {Promise<{
 *   shares: Array<{ authorityId: string, shareIndex: number, packageHex: string, delivered: boolean }>,
 *   fingerprint: string,
 *   threshold: number,
 *   totalShares: number,
 * }>}
 * @throws {Error} If splitting, encryption, or delivery fails.
 */
export async function distributeToAuthorities(adminFactorHex, authorities, threshold, walletId, recipientIndex) {
  if (!Array.isArray(authorities) || authorities.length < 2) {
    throw new Error('At least 2 authorities are required for Shamir distribution');
  }

  const totalShares = authorities.length;
  const effectiveThreshold = threshold || Math.ceil(totalShares * 2 / 3);

  if (effectiveThreshold < 2 || effectiveThreshold > totalShares) {
    throw new Error(`Invalid threshold ${effectiveThreshold} for ${totalShares} shares`);
  }

  // Step 1: Split AdminFactor
  const rawShares = splitAdminFactor(adminFactorHex, totalShares, effectiveThreshold);

  // Step 2: Compute fingerprint for verification
  const fingerprint = custody_admin_factor_fingerprint(adminFactorHex);
  _checkWasmResult(fingerprint);

  // Step 3: Encrypt each share and deliver
  const deliveryResults = [];

  for (let i = 0; i < authorities.length; i++) {
    const authority = authorities[i];
    const share = rawShares[i];

    // Encrypt the share for this authority
    const encrypted = encryptShareForAuthority(share.data_hex, authority.publicKeyHex);

    // Deliver via server API
    let delivered = false;
    try {
      const response = await fetch(`${API_BASE}/binding/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_id: walletId,
          authority_id: authority.id,
          recipient_indices: [recipientIndex],
          shamir_config: {
            share_index: share.index,
            total_shares: totalShares,
            threshold: effectiveThreshold,
          },
          encrypted_share: {
            package_hex: encrypted.package_hex,
            ephemeral_pubkey_hex: encrypted.ephemeral_pubkey_hex,
          },
          admin_factor_fingerprint: fingerprint,
        }),
      });

      if (response.ok) {
        delivered = true;
      }
    } catch {
      // Delivery failure is recorded but does not abort the entire operation.
      // The user can retry delivery for failed shares.
    }

    deliveryResults.push({
      authorityId: authority.id,
      shareIndex: share.index,
      packageHex: encrypted.package_hex,
      delivered,
    });
  }

  return {
    shares: deliveryResults,
    fingerprint,
    threshold: effectiveThreshold,
    totalShares,
  };
}

/**
 * Verify that an authority has received and can hold a share.
 *
 * Queries the server API to check the binding status for a specific
 * authority + wallet + recipient combination.
 *
 * @param {string} authorityId - Authority identifier.
 * @param {string} walletId - Owner's wallet ID.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @returns {Promise<{ verified: boolean, status: string, lastVerified: string|null }>}
 */
export async function verifyShareReceipt(authorityId, walletId, recipientIndex) {
  if (!authorityId || !walletId) {
    throw new Error('authorityId and walletId are required');
  }

  try {
    const params = new URLSearchParams({
      wallet_id: walletId,
      authority_id: authorityId,
      recipient_index: String(recipientIndex),
    });

    const response = await fetch(`${API_BASE}/binding/my?${params}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return { verified: false, status: 'api_error', lastVerified: null };
    }

    const data = await response.json();

    if (!data || !Array.isArray(data) || data.length === 0) {
      return { verified: false, status: 'not_found', lastVerified: null };
    }

    const binding = data[0];
    return {
      verified: binding.status === 'active',
      status: binding.status || 'unknown',
      lastVerified: binding.updated_at || binding.created_at || null,
    };
  } catch {
    return { verified: false, status: 'network_error', lastVerified: null };
  }
}
