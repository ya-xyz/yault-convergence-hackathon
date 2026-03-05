/**
 * authority-crypto.js — Client-side Authority Crypto Operations
 *
 * Wrapper around WASM E2E encryption for distributing AdminFactor
 * to authorities. Each authority receives the full AdminFactor encrypted
 * with their public key (no secret sharing).
 *
 * Flow:
 *   1. encryptForAuthority() - E2E encrypt the AdminFactor with the authority's public key
 *   2. distributeToAuthorities() - Orchestrate encrypt + send via server API
 *   3. verifyShareReceipt() - Confirm authority received and can hold the factor
 *
 * Dependencies: WASM core (custody module), server API
 */

import {
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
 * Encrypt the AdminFactor for a specific authority using X25519 ECDH + ChaCha20-Poly1305.
 *
 * The authority's public key is used for an ephemeral Diffie-Hellman key exchange.
 * The resulting shared secret encrypts the AdminFactor. Only the authority's
 * private key can decrypt it.
 *
 * @param {string} adminFactorHex - The AdminFactor as a hex string.
 * @param {string} authorityPubkeyHex - The authority's X25519 public key (hex, 64 chars).
 * @returns {{ package_hex: string, ephemeral_pubkey_hex: string }}
 * @throws {Error} If encryption fails.
 */
export function encryptForAuthority(adminFactorHex, authorityPubkeyHex) {
  if (!adminFactorHex) {
    throw new Error('adminFactorHex is required');
  }
  if (!authorityPubkeyHex || authorityPubkeyHex.length !== 64) {
    throw new Error('authorityPubkeyHex must be a 64-character hex string');
  }

  const result = custody_encrypt_for_authority(adminFactorHex, authorityPubkeyHex);
  return _checkWasmObject(result);
}

/**
 * Distribute AdminFactor to multiple authorities via E2E encryption.
 *
 * This is the high-level orchestration function that:
 *   1. Encrypts the AdminFactor with each authority's public key
 *   2. Sends each encrypted package to the server API for delivery
 *   3. Records the AdminFactor fingerprint for later verification
 *
 * @param {string} adminFactorHex - The AdminFactor hex string (64 chars).
 * @param {Array<{ id: string, publicKeyHex: string }>} authorities
 *   Array of authority objects, each with an ID and X25519 public key.
 * @param {number} _threshold - Unused (kept for API compatibility).
 * @param {string} walletId - Owner's wallet ID for the binding record.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @returns {Promise<{
 *   shares: Array<{ authorityId: string, packageHex: string, delivered: boolean }>,
 *   fingerprint: string,
 *   totalAuthorities: number,
 * }>}
 * @throws {Error} If encryption or delivery fails.
 */
export async function distributeToAuthorities(adminFactorHex, authorities, _threshold, walletId, recipientIndex) {
  if (!Array.isArray(authorities) || authorities.length < 1) {
    throw new Error('At least 1 authority is required for distribution');
  }

  // Compute fingerprint for verification
  const fingerprint = custody_admin_factor_fingerprint(adminFactorHex);
  _checkWasmResult(fingerprint);

  // Encrypt and deliver to each authority
  const deliveryResults = [];

  for (let i = 0; i < authorities.length; i++) {
    const authority = authorities[i];

    // Encrypt the full AdminFactor for this authority
    const encrypted = encryptForAuthority(adminFactorHex, authority.publicKeyHex);

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
          encrypted_admin_factor: {
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
    }

    deliveryResults.push({
      authorityId: authority.id,
      packageHex: encrypted.package_hex,
      delivered,
    });
  }

  return {
    shares: deliveryResults,
    fingerprint,
    totalAuthorities: authorities.length,
  };
}

/**
 * Verify that an authority has received and can hold the AdminFactor.
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
