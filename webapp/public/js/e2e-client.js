/**
 * e2e-client.js — E2E Encrypted API Client for Authority Dashboard
 *
 * Uses Yallet extension's custom RPC methods to obtain E2E identity:
 *   - yallet_getXidentity  → X25519 pub (xidentity) + Solana addr (Ed25519 pub)
 *   - yallet_signXidentity → Ed25519 signature via WASM (requires passkey approval)
 *
 * Mirrors the signing scheme in /public/api-client.js (encryptedFetch):
 *   Headers: X-Yallet-Identity, X-Yallet-Signing-Key, X-Yallet-Address,
 *            X-Yallet-Signature, X-Yallet-Nonce
 *
 * The proxy-api validates the Ed25519 signature and encrypts responses via X25519 DH.
 * Since the authority dashboard doesn't have access to the wallet's mnemonic/passphrase
 * in JS, response decryption is NOT supported here (proxy should skip encryption for
 * yault routes, or we add a decrypt RPC method later).
 */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const _e2e = {
  provider: null,       // window.yallet / window.ethereum
  xidentity: null,      // X25519 public key (base64)
  solanaAddress: null,   // Solana address (base58 = Ed25519 public key)
  evmAddress: null,      // EVM address for reference
  enabled: false,
};

// ─── Base64 / Base58 helpers ─────────────────────────────────────────────────

function _uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function _base58Decode(str) {
  const result = [];
  for (const char of str) {
    let carry = _B58.indexOf(char);
    if (carry < 0) throw new Error('Invalid base58 character: ' + char);
    for (let j = 0; j < result.length; j++) {
      carry += result[j] * 58;
      result[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      result.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char === '1') result.push(0);
    else break;
  }
  return new Uint8Array(result.reverse());
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the E2E client by fetching xidentity from the Yallet extension.
 * Call this after the wallet is connected.
 *
 * @param {object} provider — window.yallet or window.ethereum
 * @returns {Promise<boolean>} true if E2E identity is available
 */
async function initE2EClient(provider) {
  _e2e.provider = provider;

  try {
    const identity = await provider.request({ method: 'yallet_getXidentity' });
    if (identity && identity.xidentity && identity.solanaAddress) {
      _e2e.xidentity = identity.xidentity;
      _e2e.solanaAddress = identity.solanaAddress;
      _e2e.evmAddress = identity.evmAddress;
      _e2e.enabled = true;
      if (window.YAULT_ENV && window.YAULT_ENV.logging && window.YAULT_ENV.logging.enableConsoleLog) {
        console.log('[E2E] Identity loaded');
      }
      return true;
    }
  } catch (err) {
    console.warn('[E2E] Failed to get xidentity:', err.message);
  }

  _e2e.enabled = false;
  return false;
}

function isE2EEnabled() {
  return _e2e.enabled;
}

// ─── Signed Fetch ────────────────────────────────────────────────────────────

/**
 * Make an E2E signed API request.
 * Signs the request with Ed25519 (via yallet_signXidentity) and includes
 * X-Yallet-* headers for proxy-api validation.
 *
 * @param {string} url — Full URL to fetch
 * @param {object} options — Standard fetch options
 * @returns {Promise<Response>}
 */
async function e2eFetch(url, options = {}) {
  if (!_e2e.enabled || !_e2e.provider) {
    throw new Error('E2E not initialized. Call initE2EClient() first.');
  }

  const method = (options.method || 'GET').toUpperCase();
  const bodyStr = options.body || '';

  // Derive Ed25519 public key (base64) from Solana address (base58)
  const ed25519PubBytes = _base58Decode(_e2e.solanaAddress);
  const ed25519PubBase64 = _uint8ToBase64(ed25519PubBytes);

  // Generate nonce: timestamp.UUID
  const nonce = `${Date.now()}.${crypto.randomUUID()}`;

  // Construct message for signing: METHOD:PATH:NONCE:BODY
  // Support relative URLs (e.g. /api/...) by resolving against current origin
  const urlObj = url.startsWith('http') ? new URL(url) : new URL(url, window.location.origin);
  const message = `${method}:${urlObj.pathname}:${nonce}:${bodyStr}`;

  // Sign with Ed25519 via Yallet extension (triggers passkey approval)
  let signature;
  try {
    signature = await _e2e.provider.request({
      method: 'yallet_signXidentity',
      params: [message],
    });
  } catch (err) {
    throw new Error('E2E signing failed: ' + err.message);
  }

  // Build request with E2E headers
  const resp = await fetch(url, {
    ...options,
    method,
    headers: {
      ...options.headers,
      'X-Yallet-Identity': _e2e.xidentity,         // X25519 pub (base64)
      'X-Yallet-Signing-Key': ed25519PubBase64,     // Ed25519 pub (base64)
      'X-Yallet-Address': _e2e.solanaAddress,        // Solana address (base58)
      'X-Yallet-EVM-Address': _e2e.evmAddress || '',  // EVM address (for authority_id derivation)
      'X-Yallet-Signature': signature,                // Ed25519 sig (base64)
      'X-Yallet-Nonce': nonce,
    },
    body: bodyStr || undefined,
  });

  // Note: Response decryption is not supported in this client.
  // The proxy-api should NOT encrypt responses for yault routes,
  // or we need to add a yallet_decryptResponse RPC method later.
  return resp;
}

// ─── Exports (global) ────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.E2EClient = { initE2EClient, isE2EEnabled, e2eFetch };
}
