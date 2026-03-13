/**
 * auth.js — Authentication Middleware
 *
 * Dual authentication system:
 *
 * 1. **E2E Proxy Auth** (primary — production):
 *    - Client signs requests with Ed25519 via Yallet extension (e2e-client.js)
 *    - proxy-api validates the signature and injects X-Yallet-Verified-* headers
 *    - proxy-api forwards with `Authorization: Bearer <YAULT_API_KEY>`
 *    - proxyAuthMiddleware trusts the proxy's verified headers
 *
 * 2. **Legacy Challenge-Response Auth** (fallback — dev/direct access):
 *    - Client calls generateChallenge(pubkey, walletType) → challenge
 *    - Client signs the challenge with their wallet
 *    - Client sends signed challenge via Authorization header or body
 *    - authMiddleware verifies signature locally
 *
 * Both set `req.auth = { pubkey, authority_id, walletType }` on success.
 *
 * Uses `tweetnacl` for Ed25519, native crypto + secp256k1 for EVM.
 * Challenges are stored in memory with 5-minute expiry.
 */

'use strict';

const crypto = require('crypto');

/** @type {Map<string, { challenge: string, pubkey: string, walletType: string, expires: number }>} */
const challengeStore = new Map();

/** Maximum number of active challenges to prevent OOM DoS. */
const MAX_CHALLENGES = 10000;

/** Challenge lifetime in milliseconds (5 minutes). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Interval for pruning expired challenges (60 seconds). */
const PRUNE_INTERVAL_MS = 60 * 1000;

// Periodically prune expired challenges
let _pruneTimer = null;

/**
 * Start the background prune timer (idempotent).
 */
function _startPruneTimer() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of challengeStore) {
      if (entry.expires < now) {
        challengeStore.delete(id);
      }
    }
  }, PRUNE_INTERVAL_MS);
  // Allow process to exit even if timer is running
  if (_pruneTimer.unref) _pruneTimer.unref();
}

// ---------------------------------------------------------------------------
// Challenge generation
// ---------------------------------------------------------------------------

/**
 * Generate a challenge nonce for a given public key / address.
 *
 * @param {string} pubkey     - Hex-encoded Ed25519 pubkey (64 chars) or EVM address (40 chars, with or without 0x)
 * @param {string} walletType - 'phantom' | 'metamask' | 'yallet' | 'manual' (default 'manual' = Ed25519)
 * @returns {{ challenge_id: string, challenge: string, expires_at: number }}
 */
function generateChallenge(pubkey, walletType) {
  _startPruneTimer();

  const wType = walletType || 'manual';
  let normalizedKey;

  if (wType === 'metamask' || wType === 'yallet') {
    // EVM: pubkey optional for "sign-only" flow (server will recover address from signature)
    const addr = typeof pubkey === 'string' ? pubkey.replace(/^0x/i, '').trim().toLowerCase() : '';
    if (addr && !/^[0-9a-f]{40}$/.test(addr)) {
      throw new Error('Invalid EVM address: must be a 40-character hex string (with or without 0x prefix)');
    }
    normalizedKey = addr || null;
  } else {
    // Ed25519 public key: 64 hex chars
    if (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
      throw new Error('Invalid pubkey: must be a 64-character hex string');
    }
    normalizedKey = pubkey.toLowerCase();
  }

  // Prevent unbounded growth of the challenge store (DoS protection)
  if (challengeStore.size >= MAX_CHALLENGES) {
    throw new Error('Too many pending challenges. Please try again later.');
  }

  const challenge = crypto.randomBytes(32).toString('hex');
  const challengeId = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  // For Ed25519, pubkey is required
  if ((wType !== 'metamask' && wType !== 'yallet') && !normalizedKey) {
    throw new Error('pubkey is required for this wallet type');
  }
  challengeStore.set(challengeId, {
    challenge,
    pubkey: normalizedKey,
    walletType: wType,
    expires: expiresAt,
    issuedAt: Date.now(), // #11 FIX: Record issuance timestamp for audit trail
  });

  return {
    challenge_id: challengeId,
    challenge,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Signature verification — Ed25519
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519 signature against a stored challenge.
 */
function _verifyEd25519(entry, signatureHex) {
  let nacl;
  try {
    nacl = require('tweetnacl');
  } catch (_err) {
    return { valid: false, error: 'tweetnacl module not available' };
  }

  if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
    return { valid: false, error: 'Invalid signature format: must be 128-character hex' };
  }

  try {
    const messageBytes = Buffer.from(entry.challenge, 'hex');
    const signatureBytes = Buffer.from(signatureHex, 'hex');
    const pubkeyBytes = Buffer.from(entry.pubkey, 'hex');

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
    if (!isValid) {
      return { valid: false, error: 'Signature verification failed' };
    }
    return { valid: true, pubkey: entry.pubkey };
  } catch (err) {
    return { valid: false, error: `Verification error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Signature verification — EVM (personal_sign / ecrecover)
// ---------------------------------------------------------------------------

/**
 * Recover EVM address from an Ethereum personal_sign signature.
 *
 * Message format (must match client): we use the challenge as raw hex string.
 * personal_sign hashes: "\x19Ethereum Signed Message:\n" + len(message) + message
 * with message = '0x' + challenge (64-char hex). Client must sign this exact
 * string (e.g. ethers.getBytes(ethers.toBeArray('0x' + challenge)) or
 * equivalent) so recovery matches.
 */
function _verifyEvm(entry, signatureHex) {
  // Normalise: strip 0x if present
  const sigHex = signatureHex.replace(/^0x/i, '');

  // Ethereum personal_sign signatures are 65 bytes (130 hex chars)
  if (!/^[0-9a-fA-F]{130}$/.test(sigHex)) {
    return { valid: false, error: 'Invalid EVM signature: must be 130-character hex (65 bytes)' };
  }

  try {
    // Try ethers v6 first, then v5
    let recoveredAddress;
    try {
      const ethers = require('ethers');
      // Message = '0x' + 64-char challenge hex; must match client signing exactly
      const message = '0x' + entry.challenge;
      if (ethers.verifyMessage) {
        // ethers v6
        recoveredAddress = ethers.verifyMessage(message, '0x' + sigHex).toLowerCase();
      } else if (ethers.utils && ethers.utils.verifyMessage) {
        // ethers v5
        recoveredAddress = ethers.utils.verifyMessage(message, '0x' + sigHex).toLowerCase();
      }
    } catch (_) {
      // ethers not available
    }

    if (!recoveredAddress) {
      return {
        valid: false,
        error: 'EVM signature verification requires the ethers package. Install with: npm install ethers',
      };
    }

    const recovered = recoveredAddress.replace(/^0x/i, '').toLowerCase();
    // Sign-only flow: no stored address — accept recovered address as pubkey
    if (entry.pubkey == null) {
      return { valid: true, pubkey: recovered, walletType: entry.walletType || 'yallet' };
    }
    if (recovered !== entry.pubkey.toLowerCase()) {
      return { valid: false, error: 'EVM signature does not match the expected address' };
    }
    return { valid: true, pubkey: entry.pubkey, walletType: entry.walletType || 'metamask' };
  } catch (err) {
    return { valid: false, error: `EVM verification error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Unified signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a signature against a stored challenge.
 * Routes to the correct verifier based on wallet type.
 *
 * @param {string} challengeId  - The challenge_id returned by generateChallenge
 * @param {string} signatureHex - Hex-encoded signature
 * @param {string} [walletType] - Override wallet type (if not stored in challenge)
 * @returns {{ valid: boolean, pubkey?: string, walletType?: string, error?: string }}
 */
function verifySignature(challengeId, signatureHex, walletType) {
  const entry = challengeStore.get(challengeId);
  if (!entry) {
    return { valid: false, error: 'Challenge not found or already consumed' };
  }

  // Expire check
  if (Date.now() > entry.expires) {
    challengeStore.delete(challengeId);
    return { valid: false, error: 'Challenge expired' };
  }

  // Consume challenge (one-time use)
  challengeStore.delete(challengeId);

  // Determine wallet type: explicit param > stored > default
  const wType = walletType || entry.walletType || 'manual';

  if (wType === 'metamask' || wType === 'yallet') {
    return _verifyEvm(entry, signatureHex);
  }

  // Default: Ed25519 (phantom, manual, or any other)
  return _verifyEd25519(entry, signatureHex);
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that verifies the caller's identity via wallet signature.
 *
 * Expects one of:
 * - Header `Authorization: Ed25519 <challengeId>:<signatureHex>`
 * - Header `Authorization: EVM <challengeId>:<signatureHex>`
 * - Body fields `{ auth_challenge_id, auth_signature }`
 *
 * On success, sets `req.auth = { pubkey, authority_id, walletType }` and calls next().
 * On failure, responds with 401.
 */
function authMiddleware(req, res, next) {
  let challengeId;
  let signatureHex;
  let walletType;

  // Try Authorization header first
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Ed25519 ')) {
    const parts = authHeader.slice(8).split(':');
    if (parts.length === 2) {
      challengeId = parts[0];
      signatureHex = parts[1];
      walletType = 'manual'; // Ed25519
    }
  } else if (authHeader.startsWith('EVM ')) {
    const parts = authHeader.slice(4).split(':');
    if (parts.length === 2) {
      challengeId = parts[0];
      signatureHex = parts[1];
      walletType = 'metamask';
    }
  }

  // Fall back to body fields (use auth_challenge_id / auth_signature to avoid
  // collision with domain-specific fields like evidence 'signature')
  if (!challengeId || !signatureHex) {
    challengeId = req.body?.auth_challenge_id || req.body?.challenge_id;
    signatureHex = req.body?.auth_signature;
    walletType = req.body?.wallet_type || walletType;
  }

  if (!challengeId || !signatureHex) {
    return res.status(401).json({
      error: 'Authentication required',
      detail: 'Provide wallet signature via Authorization header or body fields',
    });
  }

  const result = verifySignature(challengeId, signatureHex, walletType);
  if (!result.valid) {
    return res.status(401).json({
      error: 'Authentication failed',
      detail: result.error,
    });
  }

  // Derive authority_id from pubkey/address (same derivation as registration)
  const authorityId = crypto.createHash('sha256').update(result.pubkey, 'hex').digest('hex');

  req.auth = {
    pubkey: result.pubkey,
    authority_id: authorityId,
    walletType: result.walletType || walletType || 'manual',
  };

  next();
}

// ---------------------------------------------------------------------------
// E2E Proxy Auth Middleware
// ---------------------------------------------------------------------------

/**
 * Base58 alphabet (same as Bitcoin/Solana).
 */
const _B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode a base58-encoded string to a Buffer.
 * Used to convert Solana address (base58) → Ed25519 pubkey bytes → hex.
 */
function _base58Decode(str) {
  const result = [];
  for (const char of str) {
    let carry = _B58_ALPHABET.indexOf(char);
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
  // Preserve leading zeros (base58 '1' = 0x00)
  for (const char of str) {
    if (char === '1') result.push(0);
    else break;
  }
  return Buffer.from(result.reverse());
}

/**
 * Express middleware for E2E proxy-authenticated requests.
 *
 * The proxy-api (Cloudflare Worker) validates E2E signatures and injects:
 *   - Authorization: Bearer <YAULT_API_KEY>  (proxy → server trust)
 *   - X-Yallet-Verified-Address:     Solana address (base58 = Ed25519 pubkey)
 *   - X-Yallet-Verified-Xidentity:   X25519 public key (base64)
 *   - X-Yallet-Verified-Signing-Key: Ed25519 signing key (base64)
 *   - X-Yallet-Verified-EVM-Address:  EVM address (hex, optional)
 *
 * On success, sets `req.auth = { pubkey, authority_id, walletType }` and calls next().
 * Returns null if proxy headers are not present (so caller can fall back).
 */
function proxyAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';

  // Check if this request comes from the trusted proxy
  if (!authHeader.startsWith('Bearer ')) {
    return null; // Not a proxy request — signal caller to try legacy auth
  }

  const apiKey = authHeader.slice(7);
  const expectedKey = process.env.YAULT_API_KEY;

  if (!expectedKey) {
    // YAULT_API_KEY not configured — proxy auth disabled
    console.warn('[auth] YAULT_API_KEY not set, proxy auth disabled');
    return null;
  }

  // Constant-time comparison (timingSafeEqual throws if lengths differ — avoid 500)
  const apiKeyBuf = Buffer.from(apiKey, 'utf8');
  const expectedBuf = Buffer.from(expectedKey, 'utf8');
  if (apiKeyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(apiKeyBuf, expectedBuf)) {
    return res.status(401).json({
      error: 'Authentication failed',
      detail: 'Invalid proxy API key',
    });
  }

  // Extract verified identity injected by proxy-api
  const solanaAddress = req.headers['x-yallet-verified-address'];
  const evmAddress = req.headers['x-yallet-verified-evm-address'];

  if (!solanaAddress && !evmAddress) {
    return res.status(401).json({
      error: 'Authentication failed',
      detail: 'No verified identity in proxy headers',
    });
  }

  // Derive pubkey hex and authority_id
  let pubkeyHex;
  let walletType = 'yallet';

  if (evmAddress) {
    // EVM address → use as pubkey for authority_id derivation (matches legacy behavior)
    pubkeyHex = evmAddress.replace(/^0x/i, '').toLowerCase();
    walletType = 'yallet'; // EVM via Yallet
  } else if (solanaAddress) {
    // Solana address (base58) → decode to Ed25519 pubkey bytes → hex
    try {
      const pubkeyBytes = _base58Decode(solanaAddress);
      pubkeyHex = pubkeyBytes.toString('hex').toLowerCase();
    } catch (err) {
      return res.status(401).json({
        error: 'Authentication failed',
        detail: 'Invalid Solana address in proxy headers: ' + err.message,
      });
    }
    walletType = 'yallet'; // Ed25519 via Yallet
  }

  // Derive authority_id using same formula as legacy auth
  const authorityId = crypto.createHash('sha256').update(pubkeyHex, 'hex').digest('hex');

  req.auth = {
    pubkey: pubkeyHex,
    authority_id: authorityId,
    walletType,
    // Extra fields from proxy (available for downstream handlers)
    solanaAddress: solanaAddress || null,
    evmAddress: evmAddress || null,
    xidentity: req.headers['x-yallet-verified-xidentity'] || null,
    signingKey: req.headers['x-yallet-verified-signing-key'] || null,
  };

  next();
}

// ---------------------------------------------------------------------------
// Client session token (login once, no re-sign for data-only APIs)
// ---------------------------------------------------------------------------

const SESSION_SECRET = (() => {
  const env = process.env.CLIENT_SESSION_SECRET;
  if (env && env.length >= 32) return env;
  if (process.env.NODE_ENV === 'production') {
    console.error('[SECURITY] CLIENT_SESSION_SECRET is missing or too short (min 32 chars). Generating random ephemeral secret — sessions will not survive restarts.');
  }
  // Auto-generate a strong ephemeral secret so we never fall back to a hardcoded value.
  return crypto.randomBytes(32).toString('hex');
})();
const SESSION_TTL_SEC = 24 * 3600; // 24h

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = 4 - (str.length % 4);
  if (pad !== 4) str += '='.repeat(pad);
  return Buffer.from(str, 'base64');
}

/**
 * Create a session token for the given pubkey (issued after successful verify).
 */
function createClientSessionToken(pubkey) {
  const payload = { p: pubkey, e: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC };
  const raw = JSON.stringify(payload);
  const b64 = base64UrlEncode(Buffer.from(raw, 'utf8'));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest();
  return b64 + '.' + base64UrlEncode(sig);
}

/**
 * Verify a client session token. Returns { pubkey } or null.
 */
function verifyClientSessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  try {
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest();
    const actualSig = base64UrlDecode(sigB64);
    if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) return null;
    const raw = base64UrlDecode(b64).toString('utf8');
    const payload = JSON.parse(raw);
    if (payload.e && payload.e < Math.floor(Date.now() / 1000)) return null; // expired
    if (!payload.p) return null;
    return { pubkey: payload.p };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dual Auth Middleware (client-session first, then proxy, then challenge-response)
// ---------------------------------------------------------------------------

/**
 * Tries, in order: X-Client-Session (session token from login), Bearer (proxy),
 * then legacy challenge-response. So after login, data-only APIs use the session
 * token and do not require a second sign.
 */
function dualAuthMiddleware(req, res, next) {
  const clientSession = req.headers['x-client-session'];
  if (clientSession) {
    const session = verifyClientSessionToken(clientSession);
    if (session) {
      const authorityId = crypto.createHash('sha256').update(session.pubkey, 'hex').digest('hex');
      req.auth = {
        pubkey: session.pubkey,
        authority_id: authorityId,
        walletType: 'yallet',
      };
      return next();
    }
  }

  const authHeader = req.headers['authorization'] || '';

  // Agent API Key: Bearer sk-yault-*
  // ── Agent key authentication (pk-yault-* = read-only, sk-yault-* = full access) ──
  //
  // Follows the Stripe pk/sk pattern:
  //   pk-yault-xxx  →  public key (safe to embed in frontend), read-only access
  //   sk-yault-xxx  →  secret key (server-side only), full read+write access
  //
  // Read-only routes: balance queries, authorization status
  // Write routes: deposit, redeem, transfer, send (financial operations)

  const AGENT_READ_ROUTES = [
    '/api/vault/agent-authorization',  // read: check operator/allowance status + agent identity
    '/api/vault/balance/',             // read: GET /balance/:address (prefix-matched)
    '/api/vault/balances/',            // read: GET /balances/:address (prefix-matched)
  ];

  const AGENT_WRITE_ROUTES = [
    '/api/vault/deposit',              // write: deposit into vault
    '/api/vault/redeem',               // write: redeem from vault
    '/api/vault/transfer',             // write: transfer between accounts
    '/api/vault/send',                 // write: send tokens to arbitrary address
  ];

  const AGENT_ADMIN_ROUTES = [
    '/api/me/developer-keys',          // blocked downstream by requireWalletAuth, but auth is ok
    '/api/me/spending-policies',       // blocked downstream by requireWalletAuth, but auth is ok
  ];

  if (authHeader.startsWith('Bearer pk-yault-')) {
    // Public key: read-only access (balance queries, authorization checks)
    const urlPath = req.originalUrl.split('?')[0];
    const readAllowed = AGENT_READ_ROUTES.some((route) =>
      urlPath === route || urlPath.startsWith(route + '/') || urlPath.startsWith(route)
    );
    if (!readAllowed) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'Public keys (pk-yault-*) can only access read-only endpoints. Use a secret key (sk-yault-*) for write operations.',
      });
    }

    const agentId = authHeader.slice(7); // "pk-yault-xxx"
    const _db = require('../db');
    return _db.agentApiKeys.findByAgentId(agentId).then((record) => {
      if (!record) {
        return res.status(401).json({ error: 'Invalid public key' });
      }
      _db.agentApiKeys.findById(record.key_id).then((fresh) => {
        if (fresh) _db.agentApiKeys.update(record.key_id, { ...fresh, last_used_at: Date.now() });
      }).catch(() => {});
      const _authorityId = crypto.createHash('sha256').update(record.wallet_id, 'hex').digest('hex');
      req.auth = {
        pubkey: record.wallet_id,
        authority_id: _authorityId,
        walletType: 'agent',
        keyType: 'public',
        agent_key_id: record.key_id,
        agent_id: record.agent_id || null,
      };
      return next();
    }).catch((err) => {
      console.error('[auth] Agent public key lookup error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    });
  }

  if (authHeader.startsWith('Bearer sk-yault-')) {
    // Secret key: full read+write access
    const ALL_AGENT_ROUTES = [...AGENT_READ_ROUTES, ...AGENT_WRITE_ROUTES, ...AGENT_ADMIN_ROUTES];
    const urlPath = req.originalUrl.split('?')[0];
    const agentRouteAllowed = ALL_AGENT_ROUTES.some((route) =>
      urlPath === route || urlPath.startsWith(route + '/') || urlPath.startsWith(route)
    );
    if (!agentRouteAllowed) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'Agent API keys can only access vault endpoints. Use a wallet-signed request for this resource.',
      });
    }

    const apiKey = authHeader.slice(7);
    const keyHash = crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
    const _db = require('../db');
    return _db.agentApiKeys.findByHash(keyHash).then((record) => {
      if (!record) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      // Update last_used_at (best-effort, non-blocking).
      // Re-read fresh record to avoid overwriting concurrent policy_id changes.
      _db.agentApiKeys.findById(record.key_id).then((fresh) => {
        if (fresh) _db.agentApiKeys.update(record.key_id, { ...fresh, last_used_at: Date.now() });
      }).catch(() => {});
      const _authorityId = crypto.createHash('sha256').update(record.wallet_id, 'hex').digest('hex');
      req.auth = {
        pubkey: record.wallet_id,
        authority_id: _authorityId,
        walletType: 'agent',
        keyType: 'secret',
        agent_key_id: record.key_id,
        agent_id: record.agent_id || null,
      };
      return next();
    }).catch((err) => {
      console.error('[auth] Agent API key lookup error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    });
  }

  if (authHeader.startsWith('Bearer ')) {
    const proxyResult = proxyAuthMiddleware(req, res, next);
    // When proxy auth is disabled/missing key, fallback to legacy auth instead of hanging request.
    if (proxyResult === null) {
      return authMiddleware(req, res, next);
    }
    return proxyResult;
  }

  return authMiddleware(req, res, next);
}

// ---------------------------------------------------------------------------
// Authority session middleware (dashboard: one sign, then session token)
// ---------------------------------------------------------------------------

const db = require('../db');

/**
 * For authority-only routes: accept either X-Authority-Session token or
 * legacy Authorization: EVM/Ed25519 challenge-response.
 * Sets `req.auth = { pubkey, authority_id, walletType }` on success.
 */
async function authorityAuthMiddleware(req, res, next) {
  const sessionToken = req.headers['x-authority-session'];
  if (sessionToken) {
    try {
      const session = await db.authoritySessions.findById(sessionToken);
      if (session && session.expires > Date.now()) {
        req.auth = {
          pubkey: session.pubkey,
          authority_id: session.authority_id,
          walletType: 'yallet',
        };
        return next();
      }
      if (session) await db.authoritySessions.delete(sessionToken);
    } catch (err) {
      console.error('[auth] Authority session lookup error:', err.message);
    }
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }

  // Fallback to challenge-response auth, then verify the caller is a registered authority
  return authMiddleware(req, res, async () => {
    if (!req.auth?.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Derive authority_id and verify it exists in the registry
    const crypto = require('crypto');
    const derivedAuthorityId = crypto.createHash('sha256').update(req.auth.pubkey, 'hex').digest('hex');
    const authority = await db.authorities.findById(derivedAuthorityId);
    if (!authority) {
      return res.status(403).json({ error: 'Forbidden', detail: 'Caller is not a registered authority' });
    }
    req.auth.authority_id = derivedAuthorityId;
    next();
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateChallenge,
  verifySignature,
  createClientSessionToken,
  verifyClientSessionToken,
  authMiddleware,
  proxyAuthMiddleware,
  dualAuthMiddleware,
  authorityAuthMiddleware,
  requireAuth: dualAuthMiddleware,
};
