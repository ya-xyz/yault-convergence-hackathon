/**
 * tlock.js — drand Timelock Encryption Wrapper
 *
 * Wraps tlock-js + drand-client for the release platform.
 * Uses the drand mainnet (unchained) beacon for timelock encryption.
 *
 * Dependencies: tlock-js, drand-client
 */

import { timelockEncrypt, timelockDecrypt } from 'tlock-js';
import { HttpCachingChain, HttpChainClient, roundAt, roundTime } from 'drand-client';

// ─── drand Mainnet (unchained) Constants ───

const DRAND_GENESIS = 1595431050;
const DRAND_PERIOD = 30; // seconds
const DRAND_CHAIN_HASH = 'dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493';
const DRAND_URLS = [
  'https://api.drand.sh',
  'https://drand.cloudflare.com',
];

/** @type {HttpChainClient|null} */
let _cachedClient = null;
/** @type {HttpCachingChain|null} */
let _cachedChain = null;

// ─── Internal Helpers ───

/**
 * Build or return cached drand chain + client.
 * @returns {{ chain: HttpCachingChain, client: HttpChainClient }}
 */
function _getChainAndClient() {
  if (_cachedChain && _cachedClient) {
    return { chain: _cachedChain, client: _cachedClient };
  }

  _cachedChain = new HttpCachingChain(DRAND_URLS[0], {
    chainHash: DRAND_CHAIN_HASH,
  });

  // H-06 FIX: Pin drand mainnet (unchained) public key to prevent MITM
  _cachedClient = new HttpChainClient(_cachedChain, {
    noCache: false,
    chainVerificationParams: {
      chainHash: DRAND_CHAIN_HASH,
      publicKey: '868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31',
    },
  });

  return { chain: _cachedChain, client: _cachedClient };
}

/**
 * Encode a UTF-8 string to Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
function _encode(str) {
  return new TextEncoder().encode(str);
}

/**
 * Decode a Uint8Array to UTF-8 string.
 * @param {Uint8Array} buf
 * @returns {string}
 */
function _decode(buf) {
  return new TextDecoder().decode(buf);
}

// ─── Exported Functions ───

/**
 * Return drand configuration details used by this module.
 *
 * @returns {{ genesis: number, period: number, chainHash: string, urls: string[] }}
 */
export function getDrandConfig() {
  return {
    genesis: DRAND_GENESIS,
    period: DRAND_PERIOD,
    chainHash: DRAND_CHAIN_HASH,
    urls: [...DRAND_URLS],
  };
}

/**
 * Get the current drand round number based on the current wall-clock time.
 *
 * @returns {number} The current drand round number.
 */
export function getCurrentRound() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor((now - DRAND_GENESIS) / DRAND_PERIOD) + 1;
}

/**
 * Compute the drand round number that will be reached N months from now.
 *
 * @param {number} monthsFromNow - Number of months into the future (e.g. 12).
 * @returns {{ round: number, estimatedTimestamp: number }}
 *   The future round number and its estimated UNIX timestamp.
 */
export function computeFutureRound(monthsFromNow) {
  if (!Number.isFinite(monthsFromNow) || monthsFromNow <= 0) {
    throw new Error('monthsFromNow must be a positive number');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Approximate months as 30.44 days each (average month length)
  const futureTimestamp = nowSec + Math.round(monthsFromNow * 30.44 * 24 * 3600);
  const futureRound = Math.floor((futureTimestamp - DRAND_GENESIS) / DRAND_PERIOD) + 1;

  return {
    round: futureRound,
    estimatedTimestamp: futureTimestamp,
  };
}

/**
 * Build a structured release request object suitable for tlock encryption.
 * This is the plaintext that the tlock mechanism will seal until the deadline round.
 *
 * @param {string} walletId - The owner's wallet identifier.
 * @param {number} recipientIndex - 1-based index of the recipient path.
 * @param {string} authorityId - Identifier of the bound authority.
 * @param {{ email?: string, phone?: string, name?: string }} contact
 *   - Contact information for the authority to reach the recipient.
 * @returns {string} JSON-encoded release request.
 */
export function buildReleaseRequest(walletId, recipientIndex, authorityId, contact) {
  if (!walletId || !authorityId) {
    throw new Error('walletId and authorityId are required');
  }
  if (!Number.isInteger(recipientIndex) || recipientIndex < 1) {
    throw new Error('recipientIndex must be a positive integer');
  }

  const request = {
    version: 1,
    type: 'RELEASE_REQUEST',
    walletId,
    recipientIndex,
    authorityId,
    contact: {
      email: contact?.email || null,
      phone: contact?.phone || null,
      name: contact?.name || null,
    },
    createdAt: new Date().toISOString(),
  };

  return JSON.stringify(request);
}

/**
 * Timelock-encrypt a release request so it can only be decrypted after a
 * specific drand round has been reached.
 *
 * The ciphertext is safe to store publicly on Arweave; nobody can decrypt
 * it until the drand network publishes the beacon for `roundNumber`.
 *
 * @param {string} releaseRequestJson - JSON string produced by `buildReleaseRequest`.
 * @param {number} roundNumber - The drand round after which decryption becomes possible.
 * @returns {Promise<string>} Base64-encoded tlock ciphertext.
 */
export async function encryptReleaseRequest(releaseRequestJson, roundNumber) {
  if (!releaseRequestJson || typeof releaseRequestJson !== 'string') {
    throw new Error('releaseRequestJson must be a non-empty string');
  }
  if (!Number.isInteger(roundNumber) || roundNumber <= 0) {
    throw new Error('roundNumber must be a positive integer');
  }

  const { chain } = _getChainAndClient();
  const payload = _encode(releaseRequestJson);

  const ciphertext = await timelockEncrypt(roundNumber, payload, chain);
  return ciphertext;
}

/**
 * Decrypt a tlock-encrypted release request.
 *
 * This will **only succeed** after the drand network has published the beacon
 * for the round used during encryption. Before that round, the decryption
 * will fail with an error.
 *
 * @param {string} ciphertext - Base64-encoded tlock ciphertext.
 * @returns {Promise<{ releaseRequest: object, raw: string }>}
 *   The parsed release request object and the raw JSON string.
 * @throws {Error} If the round has not yet been reached or decryption fails.
 */
export async function decryptReleaseRequest(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new Error('ciphertext must be a non-empty string');
  }

  const { chain, client } = _getChainAndClient();

  const plaintext = await timelockDecrypt(ciphertext, chain, client);
  const raw = _decode(plaintext);

  let releaseRequest;
  try {
    releaseRequest = JSON.parse(raw);
  } catch {
    throw new Error('Decrypted data is not valid JSON');
  }

  if (releaseRequest.type !== 'RELEASE_REQUEST') {
    throw new Error(`Unexpected release request type: ${releaseRequest.type}`);
  }

  return { releaseRequest, raw };
}

// ─── H-07 FIX: Key Zeroization Helper ───
// JavaScript doesn't have secure memory, but we can overwrite buffers.

/**
 * Overwrite a string variable with zeros (best-effort in JS).
 * Caller must reassign the returned empty string to their variable.
 * @param {Uint8Array|ArrayBuffer} buffer - Buffer to overwrite
 */
export function zeroizeBuffer(buffer) {
  if (buffer instanceof Uint8Array) {
    buffer.fill(0);
  } else if (buffer instanceof ArrayBuffer) {
    new Uint8Array(buffer).fill(0);
  }
}
