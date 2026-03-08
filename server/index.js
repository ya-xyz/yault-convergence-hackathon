/**
 * server/index.js — Express Application Entry Point
 *
 * Mounts all API routers, applies middleware, and starts the HTTP server.
 *
 * Route map:
 *   POST   /api/auth/challenge          - Generate Ed25519 challenge
 *   POST   /api/auth/verify             - Verify signed challenge
 *
 *   POST   /api/authority/register        - Register authority
 *   GET    /api/authority/search          - Search authorities
 *   POST   /api/authority/:id/verify      - Admin verify authority
 *   GET    /api/authority/:id             - Public profile
 *
 *   POST   /api/binding                 - Create binding
 *   DELETE /api/binding/:id             - Terminate binding
 *   GET    /api/binding                 - List bindings
 *
 *   POST   /api/trigger/initiate        - Authority initiates legal-event trigger
 *   POST   /api/trigger/:id/decision    - Authority decision (enters cooldown)
 *   POST   /api/trigger/:id/cancel      - Cancel decision during cooldown
 *   GET    /api/trigger/pending         - Pending triggers
 *
 *   GET    /api/revenue/authority/:id     - Authority revenue
 *   GET    /api/revenue/user/:walletId  - User vault revenue
 *   POST   /api/revenue/withdraw        - Initiate withdrawal
 *
 *   GET    /api/vault/balance/:address  - Wallet + vault balances
 *   POST   /api/vault/deposit           - Deposit wallet → vault
 *   POST   /api/vault/redeem            - Redeem vault → wallet
 *   POST   /api/vault/harvest           - Harvest accumulated yield
 *
 *   POST   /api/release/prepare-distribute - Prepare factor distribution (one E2E encrypted package per authority)
 *
 *   POST   /api/accounts/members          - Add sub-account member
 *   GET    /api/accounts/members          - List sub-account members
 *   PUT    /api/accounts/members/:id      - Update member permissions
 *   DELETE /api/accounts/members/:id      - Remove member
 *   GET    /api/accounts/members/parent   - Check if wallet is a sub-account
 *   POST   /api/accounts/allowances       - Create allowance / fund transfer
 *   PUT    /api/accounts/allowances/:id/cancel - Cancel recurring allowance
 *   GET    /api/accounts/allowances       - List allowances
 *
 *   GET    /api/admin/stats             - Platform statistics (admin)
 *   GET    /api/admin/users             - All users (admin)
 *   GET    /api/admin/users/:addr       - User detail (admin)
 *   GET    /api/admin/authorities       - All authorities (admin)
 *   GET    /api/admin/triggers          - All triggers (admin)
 *   GET    /api/admin/revenue           - Platform revenue (admin)
 *   GET    /api/admin/kyc              - KYC submissions (admin)
 *   POST   /api/admin/kyc/:addr/review - KYC approve/reject (admin)
 *
 *   POST   /api/kyc/submit             - Submit KYC (public)
 *   GET    /api/kyc/status/:addr       - KYC status (public)
 *
 *   POST   /api/trial/request          - Submit trial request (public)
 *
 *   GET    /api/invite/validate?token=  - Validate invite token (public)
 *   POST   /api/invite/accept          - Accept invite, become sub-account (auth)
 *
 *   GET    /api/compliance/screen      - Compliance screening (CRE external data source)
 *
 *   GET    /health                      - Health check
 */

'use strict';

// Load environment variables from .env (no-op if dotenv is not installed or .env is missing)
try { require('dotenv').config(); } catch (_) { /* optional dependency */ }

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { generateChallenge, verifySignature, createClientSessionToken, authMiddleware, dualAuthMiddleware, authorityAuthMiddleware } = require('./middleware/auth');

// ---------------------------------------------------------------------------
// API routers
// ---------------------------------------------------------------------------

const authorityRegister = require('./api/authority/register');
const authoritySearch = require('./api/authority/search');
const authorityVerify = require('./api/authority/verify');
const authorityProfile = require('./api/authority/profile');

const bindingCreate = require('./api/binding/create');
const bindingDelete = require('./api/binding/delete');
const bindingList = require('./api/binding/list');

const triggerInitiate = require('./api/trigger/initiate');
const triggerDecision = require('./api/trigger/decision');
const triggerPending = require('./api/trigger/pending');

const revenueAuthority = require('./api/revenue/authority');
const revenueUser = require('./api/revenue/user');
const revenueWithdraw = require('./api/revenue/withdraw');

const vaultRouter = require('./api/vault');
const activitiesRouter = require('./api/activities');
const releasePrepareDistribute = require('./api/release/prepare-distribute');
const insuranceRouter = require('./api/insurance');
const portfolioRouter = require('./api/portfolio/tracker');
const { adminRouter, kycSubmitRouter } = require('./api/admin');
const trialRequest = require('./api/trial/request');

const accountMembers = require('./api/accounts/members');
const accountAllowances = require('./api/accounts/allowances');
const accountInvites = require('./api/account-invites');
const inviteAccept = require('./api/invite-accept');
const walletPlan = require('./api/wallet-plan');

const releaseConfigure = require('./api/release/configure');
const releaseDistribute = require('./api/release/distribute');
const releaseDeliverFromRegistry = require('./api/release/deliver-from-registry');
const releaseRedeliverCandidates = require('./api/release/redeliver-candidates');
const releaseOracleAuthority = require('./api/release/oracle-authority');
const releaseStatus = require('./api/release/status');
const releaseFactors = require('./api/release/release-factors');
const releaseReplacePathPayload = require('./api/release/replace-path-payload');
const claimLookup = require('./api/claim/lookup');
const pathClaimRouter = require('./api/path-claim');

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
// Behind Cloudflare/Fly, trust proxy headers so rate-limit gets real client IP.
// Can be overridden with TRUST_PROXY env (e.g. "1", "true", "false").
const trustProxyEnv = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
if (trustProxyEnv === 'false' || trustProxyEnv === '0') {
  app.set('trust proxy', false);
} else if (trustProxyEnv) {
  app.set('trust proxy', trustProxyEnv === 'true' ? true : trustProxyEnv);
} else {
  app.set('trust proxy', true);
}

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((_req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.infura.io https://*.llamarpc.com https://*.publicnode.com https://*.arweave.net https://arweave.net; img-src 'self' data:; font-src 'self';");
  res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS (permissive for dev; tighten in production)
app.use((req, res, next) => {
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const allowedOrigin = process.env.CORS_ORIGIN || (isDev ? '*' : undefined);
  if (allowedOrigin) {
    res.header('Access-Control-Allow-Origin', allowedOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Session, X-Admin-Token, X-Admin-Session, X-Authority-Session, X-Yallet-Identity, X-Yallet-Signing-Key, X-Yallet-Address, X-Yallet-EVM-Address, X-Yallet-Signature, X-Yallet-Nonce, X-Oracle-Internal-Key');
  } else if (!isDev) {
    // #12 FIX: In non-development without CORS_ORIGIN, block OPTIONS and don't set Allow-Origin.
    // This also handles the case where NODE_ENV is unset (defaults to blocking).
    console.error('[cors] CORS_ORIGIN not set — cross-origin requests are BLOCKED');
    if (req.method === 'OPTIONS') {
      return res.status(403).json({ error: 'CORS not configured' });
    }
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// H-01 FIX: CSRF protection for state-modifying requests
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const allowedOrigin = process.env.CORS_ORIGIN;

    // In all non-development/non-test environments, verify Origin matches allowed origin
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test' && allowedOrigin && allowedOrigin !== '*') {
      let requestOrigin = origin || null;
      if (!requestOrigin && referer) {
        try {
          requestOrigin = new URL(referer).origin;
        } catch (_) {
          // Malformed referer — reject to be safe
          return res.status(403).json({ error: 'CSRF check failed: invalid referer' });
        }
      }
      // Reject requests with no Origin/Referer (prevents CSRF from programmatic clients)
      const hasApiKey = req.headers['x-api-key']
        || req.headers['authorization']
        || req.headers['x-admin-token']
        || req.headers['x-admin-session']
        || req.headers['x-authority-session']
        || req.headers['x-oracle-internal-key'];
      if (!requestOrigin && !hasApiKey) {
        return res.status(403).json({ error: 'CSRF check failed: missing origin' });
      }
      if (requestOrigin && requestOrigin !== allowedOrigin) {
        return res.status(403).json({ error: 'CSRF check failed: origin mismatch' });
      }
    }
  }
  next();
});

// Request logging (dev)
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
  });
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// Global API rate limit: 200 requests per minute per IP
// Skip for admin routes (already auth-gated) and test environment
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => process.env.NODE_ENV === 'test' || req.path.startsWith('/admin/') || req.path.startsWith('/admin'),
});
app.use('/api/', globalLimiter);

// Stricter rate limit on auth endpoints: 30 per minute per IP (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/auth/', authLimiter);

// Strict limit on trigger initiation: 10 per minute per IP
const triggerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many trigger requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/trigger/initiate', triggerLimiter);

// Stricter limit on from-oracle (creates trigger records; abuse prevention)
const fromOracleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many from-oracle requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/trigger/from-oracle', fromOracleLimiter);

// Limit by-mnemonic-hash lookups (reduces brute-force enumeration of 64-char hash)
const mnemonicHashLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookups, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/claim/by-mnemonic-hash', mnemonicHashLimiter);

// Stricter limit on release configure/distribute and invite accept
const releaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/release/configure', releaseLimiter);
app.use('/api/release/distribute', releaseLimiter);
app.use('/api/release/prepare-distribute', releaseLimiter);

// Stricter limit on authority registration: 10 per minute per IP
const authorityRegisterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/authority/register', authorityRegisterLimiter);

// Stricter limit on wallet-plan endpoints: 30 per minute per IP
const walletPlanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wallet-plan requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/wallet-plan', walletPlanLimiter);

const inviteAcceptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invite attempts, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/invite/accept', inviteAcceptLimiter);

const adminSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin session attempts, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/admin/session', adminSessionLimiter);

// ---------------------------------------------------------------------------
// Auth endpoints (challenge-response, not routers)
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/challenge
 * Body: { pubkey, wallet_type? }
 * Returns: { challenge_id, challenge, expires_at }
 */
app.post('/api/auth/challenge', (req, res) => {
  try {
    const { pubkey, wallet_type } = req.body || {};
    const w = wallet_type || 'manual';
    // For EVM (yallet/metamask), pubkey is optional — "sign-only" flow recovers address from signature
    if (!pubkey && w !== 'yallet' && w !== 'metamask') {
      return res.status(400).json({ error: 'pubkey is required' });
    }
    const result = generateChallenge(pubkey || '', wallet_type);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/auth/verify
 * Body: { challenge_id, signature, wallet_type? }
 * Returns: { valid, pubkey, session_token? } or { valid: false, error }
 * session_token: Used for data APIs after login, just include X-Client-Session header, no re-signing needed
 * Creates a user record in the DB users table on first login with this wallet.
 */
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { challenge_id, signature, wallet_type } = req.body || {};
    if (!challenge_id || !signature) {
      return res.status(400).json({ error: 'challenge_id and signature are required' });
    }
    const result = verifySignature(challenge_id, signature, wallet_type);
    if (!result.valid) {
      return res.status(401).json(result);
    }
    const db = require('./db');
    await db.ensureReady();
    const walletId = (result.pubkey || '').replace(/^0x/i, '').toLowerCase();
    if (walletId && /^[0-9a-f]{40,64}$/.test(walletId)) {
      const existing = await db.users.findById(walletId);
      if (!existing) {
        const now = new Date().toISOString();
        await db.users.create(walletId, { wallet_id: walletId, created_at: now, updated_at: now });
      }
    }
    const session_token = createClientSessionToken(result.pubkey);
    // Record login activity
    try {
      const { recordActivity } = require('./api/activities');
      await recordActivity(walletId, 'login', {
        detail: wallet_type || 'wallet',
        status: 'confirmed',
      });
    } catch (_) { /* best-effort */ }
    return res.json({ ...result, session_token });
  } catch (err) {
    console.error('[auth/verify] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Mount API routers
// ---------------------------------------------------------------------------

// H-03 FIX: Input validation middleware for route parameters
const HEX_ID_PATTERN = /^[0-9a-fA-F]{40,128}$/;
const SAFE_ID_PATTERN = /^[0-9a-zA-Z_-]{1,128}$/;

function validateParamMiddleware(paramName, pattern) {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (value && !pattern.test(value)) {
      return res.status(400).json({
        error: 'Invalid parameter format',
        detail: `Parameter '${paramName}' does not match expected format`,
      });
    }
    next();
  };
}

// Apply param validation to routes with ID parameters
app.param('id', (req, res, next, val) => {
  if (val && val.length > 128) {
    return res.status(400).json({ error: 'Parameter too long' });
  }
  if (val && !SAFE_ID_PATTERN.test(val)) {
    return res.status(400).json({ error: 'Invalid parameter format' });
  }
  next();
});
app.param('walletId', (req, res, next, val) => {
  if (val && val.length > 128) {
    return res.status(400).json({ error: 'Parameter too long' });
  }
  if (val && !SAFE_ID_PATTERN.test(val)) {
    return res.status(400).json({ error: 'Invalid parameter format' });
  }
  next();
});
app.param('addr', (req, res, next, val) => {
  if (val && val.length > 128) {
    return res.status(400).json({ error: 'Parameter too long' });
  }
  if (val && !SAFE_ID_PATTERN.test(val)) {
    return res.status(400).json({ error: 'Invalid parameter format' });
  }
  next();
});
app.param('address', (req, res, next, val) => {
  if (val && val.length > 128) {
    return res.status(400).json({ error: 'Parameter too long' });
  }
  next();
});

// Authority routes (session before other routes so POST /session is matched)
const authoritySession = require('./api/authority/session');
const authorityAdminFactorRelease = require('./api/authority/admin-factor-release');
app.use('/api/authority/session', authoritySession);
app.use('/api/authority/AdminFactor', authorityAdminFactorRelease); // GET /release?recipient_id= (info), POST /release { recipient_id, admin_factor } (auth required)
app.use('/api/authority/register', authorityRegister);
app.use('/api/authority/search', authoritySearch);
const authorityReleaseLinks = require('./api/authority/release-links');
app.use('/api/authority/release-links', authorityReleaseLinks);
app.use('/api/authority', authorityVerify);   // handles POST /:id/verify
app.use('/api/authority', authorityProfile);  // handles GET /:id

// Binding routes
app.use('/api/binding', bindingCreate);    // handles POST /
app.use('/api/binding', bindingDelete);    // handles DELETE /:id
app.use('/api/binding', bindingList);      // handles GET /

// Compliance: CRE workflow calls GET /api/compliance/screen as external data source (KYC/AML screening)
const complianceScreen = require('./api/compliance/screen');
app.use('/api/compliance', complianceScreen);

// Oracle: CRE workflow polls GET /api/oracle/pending; platform uses GET /api/trigger/attestation, POST /api/trigger/from-oracle
const triggerOracle = require('./api/trigger/oracle');
app.use('/api/oracle', triggerOracle.oraclePendingRouter); // GET /pending
// Trigger routes (oracle first so /attestation and /from-oracle are matched)
app.use('/api/trigger', triggerOracle);     // GET /attestation, POST /from-oracle
app.use('/api/trigger/initiate', triggerInitiate);
app.use('/api/trigger', triggerDecision);  // handles POST /:id/decision, POST /:id/cancel
app.use('/api/trigger/pending', triggerPending);
const attestationFallback = require('./api/trigger/attestation-fallback');
app.use('/api/trigger/attestation/fallback', attestationFallback);

// Revenue routes
app.use('/api/revenue/authority', revenueAuthority);
app.use('/api/revenue/user', revenueUser);
app.use('/api/revenue/withdraw', revenueWithdraw);

// Vault routes (wallet/vault)
app.use('/api/vault', vaultRouter);

// Activities (global activity log: login, deposit, redeem, harvest, escrow, etc.)
app.use('/api/activities', activitiesRouter);

// Insurance (DeFi insurance protocol integration)
app.use('/api/insurance', insuranceRouter);

// Portfolio tracking (Chainlink Data Feeds integration)
app.use('/api/portfolio', portfolioRouter);

// Sub-accounts (family members / corporate sub-accounts)
app.use('/api/accounts/members', accountMembers);
app.use('/api/accounts/allowances', accountAllowances);

// Client portal persistence (invites + saved plan, requires auth)
app.use('/api/account-invites', accountInvites);
app.use('/api/invite', inviteAccept);   // GET /validate (public), POST /accept (auth)
app.use('/api/wallet-plan', walletPlan);
const meAddresses = require('./api/me/addresses');
const meTokens = require('./api/me/tokens');
const meProfile = require('./api/me/profile');
app.use('/api/me/addresses', meAddresses);
app.use('/api/me/tokens', meTokens);
app.use('/api/me/profile', meProfile);

// Admin / Ops (requires ADMIN_TOKEN)
app.use('/api/admin', adminRouter);

// KYC (public submit + status check, no admin auth needed)
app.use('/api/kyc', kycSubmitRouter);

// Trial request with email notification (PR#6)
app.use('/api/trial/request', trialRequest);

// Release configuration, distribution, status, and factor release
// These endpoints handle sensitive asset release operations and require authentication.
app.use('/api/release/configure', dualAuthMiddleware, releaseConfigure);
app.use('/api/release/prepare-distribute', dualAuthMiddleware, releasePrepareDistribute);
app.use('/api/release/distribute', dualAuthMiddleware, releaseDistribute);
app.use('/api/release/deliver-from-registry', authorityAuthMiddleware, releaseDeliverFromRegistry);
app.use('/api/release/redeliver-candidates', authorityAuthMiddleware, releaseRedeliverCandidates);
app.use('/api/release/oracle-authority', dualAuthMiddleware, releaseOracleAuthority);
app.use('/api/release/status', dualAuthMiddleware, releaseStatus);
app.use('/api/release/release-factors', dualAuthMiddleware, releaseFactors);
app.use('/api/release/replace-path-payload', dualAuthMiddleware, releaseReplacePathPayload);

// Claim lookup (recipient retrieves released factors — requires auth)
app.use('/api/claim', dualAuthMiddleware, claimLookup);

// Path claim contract (YaultPathClaim): config, remaining, claim-params for frontend (auth required to reduce scraping)
app.use('/api/path-claim', dualAuthMiddleware, pathClaimRouter);

// Chains configuration (public — no auth required)
const chainsConfig = require('./config/chains');

app.get('/api/chains', (_req, res) => {
  res.json({ chains: chainsConfig.getChainSummary() });
});

app.get('/api/chains/:chainKey', (req, res) => {
  const chain = chainsConfig.getChain(req.params.chainKey);
  if (!chain) {
    return res.status(404).json({ error: `Unknown chain: ${req.params.chainKey}` });
  }
  // Return public info only (no API keys)
  res.json({
    key: chain.key,
    name: chain.name,
    type: chain.type,
    chainId: chain.chainId || null,
    nativeCurrency: chain.nativeCurrency,
    explorerUrl: chain.explorerUrl,
    usdc: chain.usdc || null,
    hasVault: !!chain.vault,
    enabled: chain.enabled,
  });
});

// ---------------------------------------------------------------------------
// Trial application (public — no auth required)
// ---------------------------------------------------------------------------

app.post('/api/trial/apply', async (req, res) => {
  try {
    const { name, email, useCase, notes } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    // #17 FIX: Strengthened email regex (RFC 5322 simplified)
    const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }
    if (!useCase || typeof useCase !== 'string') {
      return res.status(400).json({ error: 'Use case is required.' });
    }

    const trialCrypto = require('crypto');
    const application = {
      id: trialCrypto.randomBytes(12).toString('hex'),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      useCase,
      notes: (notes || '').trim(),
      createdAt: new Date().toISOString(),
    };

    await db.trialApplications.create(application.id, application);
    console.log('[trial] New application:', JSON.stringify(application, null, 2));

    return res.json({ success: true, id: application.id });
  } catch (err) {
    console.error('[trial] Application error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trial/applications', async (req, res) => {
  // Admin-only: list trial applications
  // H-02 FIX: Only accept admin token from headers (not query params to avoid log exposure); constant-time compare
  const token = req.headers['x-admin-token'] || '';
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'Admin not configured.' });
  }
  const tokenBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  const applications = await db.trialApplications.findAll();
  return res.json({ applications, total: applications.length });
});

// ---------------------------------------------------------------------------
// Health check (production: minimal response to avoid leaking uptime/details)
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.json({ status: 'ok' });
  }
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Optional static frontend hosting
// ---------------------------------------------------------------------------
// Default: disabled in production (API-only deployment), enabled in development/test.
const serveStatic = (() => {
  const raw = String(process.env.SERVE_STATIC || '').toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
})();
if (serveStatic) {
  app.use(express.static(path.join(__dirname, '..', 'webapp', 'public')));
}

// ---------------------------------------------------------------------------
// 404 handler (API only; static already tried)
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3001;
const db = require('./db');
const scheduler = require('./services/scheduler');

const TEST_AUTHORITY_WALLET = '0x00e1304043f99B88F89e7f7a742dc0D66a1de17a';

async function seedTestAuthorityIfNeeded() {
  const addrHex = TEST_AUTHORITY_WALLET.replace(/^0x/i, '').toLowerCase();
  const authorityId = crypto.createHash('sha256').update(addrHex, 'hex').digest('hex');
  const existing = await db.authorities.findById(authorityId);
  if (existing) return;
  await db.authorities.create(authorityId, {
    authority_id: authorityId,
    name: 'Test Authority (3-Role)',
    bar_number: 'TEST-001',
    jurisdiction: 'Test',
    region: 'Test',
    specialization: ['Asset release', 'Compliance'],
    languages: ['en', 'zh'],
    pubkey: addrHex,
    fee_structure: { base_fee_bps: 500, flat_fee_usd: 0, currency: 'USD' },
    email: null,
    website: null,
    verified: true,
    rating: null,
    rating_count: 0,
    active_bindings: 0,
    max_capacity: 100,
    created_at: new Date().toISOString(),
  });
  console.log('[server] Seeded test Authority for', TEST_AUTHORITY_WALLET);
}

async function seedOracleAuthorityIfNeeded() {
  const oracleAuthorityId = (process.env.ORACLE_AUTHORITY_ID || '').trim();
  if (!oracleAuthorityId) return;
  const existing = await db.authorities.findById(oracleAuthorityId);
  if (existing) return;

  await db.authorities.create(oracleAuthorityId, {
    authority_id: oracleAuthorityId,
    name: 'Oracle Authority',
    bar_number: 'ORACLE-001',
    jurisdiction: 'System',
    region: 'Global',
    specialization: ['Oracle attestation'],
    languages: ['en'],
    pubkey: '',
    fee_structure: { base_fee_bps: 0, flat_fee_usd: 0, currency: 'USD' },
    email: null,
    website: null,
    verified: true,
    rating: null,
    rating_count: 0,
    active_bindings: 0,
    max_capacity: 1000000,
    created_at: new Date().toISOString(),
  });
  console.log('[server] Seeded Oracle Authority for ORACLE_AUTHORITY_ID');
}

/** In production, log warnings for insecure or missing sensitive config. */
function warnProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const cors = process.env.CORS_ORIGIN;
  if (!cors || cors === '*') {
    console.warn('[server] SECURITY: In production set CORS_ORIGIN to your frontend origin (e.g. https://app.yallet.xyz).');
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    console.warn('[server] SECURITY: Set JWT_SECRET (min 32 chars recommended) in production for session signing.');
  }
  const clientSessionSecret = process.env.CLIENT_SESSION_SECRET;
  if (!clientSessionSecret || clientSessionSecret === 'yallet-client-session-dev' || clientSessionSecret.length < 32) {
    console.warn('[server] SECURITY: Set a strong, unique CLIENT_SESSION_SECRET (min 32 chars) in production for client session signing.');
  }
  if (process.env.YAULT_API_KEY && (cors === '*' || !cors)) {
    console.warn('[server] SECURITY: When using proxy auth (YAULT_API_KEY), ensure the proxy is the only entry point to this server (network/firewall).');
  }
  if (process.env.RELEASE_ATTESTATION_ADDRESS && !process.env.RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY) {
    console.warn('[server] RELEASE_ATTESTATION_ADDRESS is set but RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY is missing; fallback attestation will fail.');
  }
  if (!process.env.ORACLE_INTERNAL_API_KEY) {
    console.warn('[server] SECURITY: Set ORACLE_INTERNAL_API_KEY in production; POST /api/trigger/from-oracle is disabled until set.');
  }
}

if (require.main === module) {
  db.ensureReady()
    .then(() => {
      // Always ensure configured oracle authority exists, so oracle plan distribute can create bindings.
      return seedOracleAuthorityIfNeeded();
    })
    .then(() => {
      // #21 FIX: Guard test authority seed — only in development
      if (process.env.NODE_ENV === 'development') {
        return seedTestAuthorityIfNeeded();
      }
    })
    .then(() => {
      warnProductionConfig();
      const server = app.listen(PORT, () => {
        console.log(`[server] Yault API running on port ${PORT}`);
        console.log(`[server] Health check: http://localhost:${PORT}/health`);
        if (!process.env.ADMIN_WALLETS && !process.env.ADMIN_TOKEN) {
          console.log('[server] Ops portal: add ADMIN_WALLETS=0xYourAddress to .env');
        }
      });
      scheduler.start();

      // #20 FIX: Graceful shutdown handler
      function gracefulShutdown(signal) {
        console.log(`[server] Received ${signal}, shutting down gracefully...`);
        if (typeof scheduler.stop === 'function') scheduler.stop();
        server.close(async () => {
          console.log('[server] HTTP server closed');
          await db._close();
          console.log('[server] Database saved and closed');
          process.exit(0);
        });
        // Force exit after 10 seconds if graceful shutdown stalls
        setTimeout(() => {
          console.error('[server] Graceful shutdown timed out, forcing exit');
          process.exit(1);
        }, 10000).unref();
      }
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    })
    .catch((err) => {
      console.error('[server] Failed to initialise database:', err);
      process.exit(1);
    });
}

// Export for testing
module.exports = app;
