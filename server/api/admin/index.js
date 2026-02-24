/**
 * server/api/admin/index.js — Platform Operations API
 *
 * Admin-only endpoints for platform operators.
 * Supports two auth methods:
 *   1. Legacy: X-Admin-Token header (static token from ADMIN_TOKEN env var)
 *   2. Wallet: Authorization: EVM <challengeId>:<signature> with address in ADMIN_WALLETS
 *
 *   GET  /stats           — Platform-wide statistics
 *   GET  /users           — List all users (wallet addresses)
 *   GET  /users/:address  — User detail (bindings, triggers, KYC status)
 *   GET  /authorities     — List all authorities with verification status
 *   GET  /triggers        — List all triggers across the platform
 *   GET  /revenue         — Platform revenue summary
 *   GET  /kyc             — List KYC submissions
 *   POST /kyc/:address/review — Approve/reject KYC
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const db = require('../../db');
const config = require('../../config');
const vaultContract = require('../../services/vaultContract');
const { verifySignature, verifyClientSessionToken, dualAuthMiddleware } = require('../../middleware/auth');

const router = Router();

// ─── Admin Auth Middleware ───

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

/** Comma-separated EVM addresses authorized as admin (with or without 0x prefix). Quotes are stripped. */
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '')
  .split(',')
  .map(a => a.trim().replace(/^["']|["']$/g, '').replace(/^0x/i, '').toLowerCase())
  .filter(a => /^[0-9a-f]{40}$/.test(a));

/** H-04 FIX: Sessions are now persisted via db.adminSessions (SQLite-backed) */
const sessionCreateTracker = new Map(); // IP -> { count, resetAt }
const SESSION_RATE_LIMIT = 5; // max per minute
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 100;

// Prune expired sessions periodically
const _sessionPruneTimer = setInterval(async () => {
  try {
    const now = Date.now();
    const allSessions = await db.adminSessions.findAll();
    for (const entry of allSessions) {
      if (entry.expires < now && entry._sessionId) {
        await db.adminSessions.delete(entry._sessionId);
      }
    }
  } catch (_) { /* ignore pruning errors */ }
}, 60 * 1000);
if (_sessionPruneTimer.unref) _sessionPruneTimer.unref();

/**
 * POST /admin/session — Exchange a one-time wallet signature for a session token.
 * Body: { challenge_id, signature, wallet_type }
 * Returns: { session_token, address, expires_at }
 *
 * This is mounted BEFORE adminAuth so it doesn't require an existing session.
 */
router.post('/session', async (req, res) => {
  const clientSession = req.headers['x-client-session'];
  if (clientSession) {
    const session = verifyClientSessionToken(clientSession);
    if (session && session.pubkey) {
      const addr = (session.pubkey || '').replace(/^0x/i, '').toLowerCase();
      if (ADMIN_WALLETS.length > 0 && ADMIN_WALLETS.includes(addr)) {
        const allSessions = await db.adminSessions.findAll();
        if (allSessions.length >= MAX_SESSIONS) {
          const oldest = allSessions.sort((a, b) => a.expires - b.expires)[0];
          if (oldest && oldest._sessionId) {
            await db.adminSessions.delete(oldest._sessionId);
          }
        }
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + SESSION_TTL_MS;
        await db.adminSessions.create(sessionToken, { _sessionId: sessionToken, address: addr, expires: expiresAt });
        return res.json({ session_token: sessionToken, address: addr, expires_at: expiresAt });
      }
      return res.status(403).json({ error: 'Wallet not authorized as admin' });
    }
  }

  const { challenge_id, signature, wallet_type } = req.body || {};
  if (!challenge_id || !signature) {
    return res.status(400).json({ error: 'challenge_id and signature are required' });
  }

  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const tracker = sessionCreateTracker.get(clientIp);
  if (tracker && tracker.resetAt > now) {
    if (tracker.count >= SESSION_RATE_LIMIT) {
      return res.status(429).json({ error: 'Too many session requests, please try again later' });
    }
    tracker.count++;
  } else {
    sessionCreateTracker.set(clientIp, { count: 1, resetAt: now + 60 * 1000 });
  }

  const result = verifySignature(challenge_id, signature, wallet_type || 'yallet');
  if (!result.valid) {
    return res.status(401).json({ error: result.error || 'Signature verification failed' });
  }

  const addr = result.pubkey.replace(/^0x/i, '').toLowerCase();
  if (!ADMIN_WALLETS.includes(addr)) {
    return res.status(403).json({ error: 'Wallet not authorized as admin' });
  }

  // Evict oldest if at capacity
  const allSessions = await db.adminSessions.findAll();
  if (allSessions.length >= MAX_SESSIONS) {
    const oldest = allSessions.sort((a, b) => a.expires - b.expires)[0];
    if (oldest && oldest._sessionId) {
      await db.adminSessions.delete(oldest._sessionId);
    }
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db.adminSessions.create(sessionToken, { _sessionId: sessionToken, address: addr, expires: expiresAt });

  return res.json({
    session_token: sessionToken,
    address: addr,
    expires_at: expiresAt,
  });
});

async function adminAuth(req, res, next) {
  // Method 1: Legacy admin token (X-Admin-Token header)
  // H-02 FIX: Only accept admin token from headers (not query params to avoid log exposure)
  const token = req.headers['x-admin-token'];
  if (ADMIN_TOKEN && token && typeof token === 'string' &&
      token.length === ADMIN_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    req.adminAuth = { method: 'token' };
    return next();
  }

  // Method 2: Session token (X-Admin-Session header) — H-04 FIX: db-backed sessions
  const sessionToken = req.headers['x-admin-session'];
  if (sessionToken) {
    const session = await db.adminSessions.findById(sessionToken);
    if (session && session.expires > Date.now()) {
      req.adminAuth = { address: session.address, method: 'session' };
      return next();
    }
    if (session) await db.adminSessions.delete(sessionToken); // expired
    return res.status(401).json({ error: 'Session expired, please re-authenticate' });
  }

  // Method 3: Wallet signature (Authorization: EVM <challengeId>:<signature>)
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('EVM ')) {
    const parts = authHeader.slice(4).split(':');
    if (parts.length === 2) {
      const [challengeId, signature] = parts;
      const result = verifySignature(challengeId, signature, 'yallet');
      if (result.valid) {
        const addr = result.pubkey.replace(/^0x/i, '').toLowerCase();
        if (ADMIN_WALLETS.includes(addr)) {
          req.adminAuth = { address: addr, method: 'wallet' };
          return next();
        }
        return res.status(403).json({ error: 'Wallet not authorized as admin' });
      }
      return res.status(401).json({ error: result.error || 'Signature verification failed' });
    }
  }

  // Neither method succeeded
  if (!ADMIN_TOKEN && ADMIN_WALLETS.length === 0) {
    return res.status(503).json({ error: 'Admin API not configured (set ADMIN_TOKEN or ADMIN_WALLETS)' });
  }
  return res.status(403).json({ error: 'Forbidden' });
}

router.use(adminAuth);

// ─── KYC (persisted in DB; provider API integration is future) ───

function kycId(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

// ─── GET /stats ───

router.get('/stats', async (_req, res) => {
  try {
    const authorities = await db.authorities.findAll();
    const bindings = await db.bindings.findAll();
    const triggers = await db.triggers.findAll();

    const authorityArr = Array.isArray(authorities) ? authorities : [];
    const bindingArr = Array.isArray(bindings) ? bindings : [];
    const triggerArr = Array.isArray(triggers) ? triggers : [];

    const verifiedFirms = authorityArr.filter(l => l.verified).length;
    const activeBindings = bindingArr.filter(b => b.status === 'active').length;
    const pendingTriggers = triggerArr.filter(t => t.status === 'pending' || t.status === 'cooldown').length;
    const releasedTriggers = triggerArr.filter(t => t.status === 'released').length;
    const abortedTriggers = triggerArr.filter(t => t.status === 'aborted').length;

    // Unique wallet IDs
    const walletIds = new Set();
    bindingArr.forEach(b => { if (b.wallet_id) walletIds.add(b.wallet_id); });
    triggerArr.forEach(t => { if (t.wallet_id) walletIds.add(t.wallet_id); });

    const allKyc = await db.kyc.findAll();
    const kycArr = Array.isArray(allKyc) ? allKyc : [];
    const kycPending = kycArr.filter(k => k.status === 'pending').length;
    const kycApproved = kycArr.filter(k => k.status === 'approved').length;

    res.json({
      platform: {
        total_users: walletIds.size,
        total_authorities: authorityArr.length,
        verified_authorities: verifiedFirms,
        total_bindings: bindingArr.length,
        active_bindings: activeBindings,
        total_triggers: triggerArr.length,
        pending_triggers: pendingTriggers,
        released_triggers: releasedTriggers,
        aborted_triggers: abortedTriggers,
      },
      kyc: {
        pending: kycPending,
        approved: kycApproved,
        total: kycArr.length,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/stats] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /vault-config (for ops Vault tab: vault address, chainId, rpcUrl) ───

router.get('/vault-config', (_req, res) => {
  const c = config.contracts || {};
  const vaultAddress = (c.vaultAddress || '').trim();
  const chainId = (c.vaultChainId || c.chainId || '1').toString();
  const rpcUrl = (c.evmRpcUrl || '').trim() || 'https://eth.llamarpc.com';
  res.json({
    vaultAddress: vaultAddress || null,
    chainId,
    rpcUrl,
  });
});

// ─── GET /vault/users-with-yield (list addresses that have harvestable yield, for monthly harvest-for-all) ───

const MIN_YIELD_THRESHOLD = 0.01; // 0.01 USDC minimum to show (contract has minHarvestYield too)

router.get('/vault/users-with-yield', async (_req, res) => {
  const configContracts = config.contracts || {};
  if (!(configContracts.vaultAddress || '').trim()) {
    return res.status(503).json({ error: 'Vault not configured (VAULT_ADDRESS)' });
  }
  try {
    const ids = await db.vaultPositions.findAllIds();
    const usersWithYield = [];
    for (const id of ids) {
      const addr0x = id.startsWith('0x') ? id : '0x' + id;
      const bal = await vaultContract.getVaultBalance(config, addr0x);
      if (!bal) continue;
      const assets = parseFloat(bal.assets) || 0;
      const principal = parseFloat(bal.principal) || 0;
      const yieldAmount = assets - principal;
      if (yieldAmount >= MIN_YIELD_THRESHOLD) {
        usersWithYield.push({
          address: addr0x,
          yield: yieldAmount,
          yieldFormatted: yieldAmount.toFixed(4),
        });
      }
    }
    return res.json({ users: usersWithYield });
  } catch (err) {
    console.error('[admin] users-with-yield error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to fetch users with yield' });
  }
});

// ─── POST /vault/harvest-for (owner-only: harvest on behalf of a user for periodic settlement) ───

router.post('/vault/harvest-for', async (req, res) => {
  const configContracts = config.contracts || {};
  const vaultAddress = (configContracts.vaultAddress || '').trim();
  if (!vaultAddress) {
    return res.status(503).json({ error: 'Vault not configured (VAULT_ADDRESS)' });
  }
  const userAddress = (req.body?.user_address || req.body?.address || '').trim();
  if (!userAddress || !/^0x?[0-9a-fA-F]{40}$/.test(userAddress.replace(/^0x/, ''))) {
    return res.status(400).json({ error: 'Valid user_address (EVM) is required' });
  }
  const evmUser = userAddress.startsWith('0x') ? userAddress : '0x' + userAddress;
  try {
    const tx = await vaultContract.buildHarvestForTx(config, evmUser);
    if (!tx) {
      return res.status(503).json({ error: 'Failed to build harvestFor transaction' });
    }
    return res.json({
      status: 'pending_signature',
      transaction: tx,
      message: 'Sign and send as vault owner to harvest yield for the user.',
    });
  } catch (err) {
    console.error('[admin] harvest-for error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to build harvestFor tx' });
  }
});

// ─── GET /users ───
// Query: search (name or address segment), page (default 1), limit (default 20)

function normalizeAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

router.get('/users', async (req, res) => {
  try {
    const search = (req.query.search || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const allUserRows = await db.users.findAll();
    const bindings = await db.bindings.findAll();
    const triggers = await db.triggers.findAll();
    const bindingArr = Array.isArray(bindings) ? bindings : [];
    const triggerArr = Array.isArray(triggers) ? triggers : [];

    const countByWallet = (arr, key) => {
      const m = new Map();
      arr.forEach((item) => {
        const w = (item[key] || '').replace(/^0x/i, '').toLowerCase();
        if (!w) return;
        m.set(w, (m.get(w) || 0) + 1);
      });
      return m;
    };
    const bindingCount = countByWallet(bindingArr, 'wallet_id');
    const triggerCount = countByWallet(triggerArr, 'wallet_id');

    const userMap = new Map();
    const addUser = (address, data = {}) => {
      const addr = normalizeAddress(address);
      if (!addr) return;
      if (!userMap.has(addr)) {
        userMap.set(addr, {
          address: addr,
          name: data.name || '',
          role: data.role || 'client',
          bindings: 0,
          triggers: 0,
          kyc: 'none',
          created_at: data.created_at,
        });
      }
      const u = userMap.get(addr);
      u.bindings = bindingCount.get(addr) || 0;
      u.triggers = triggerCount.get(addr) || 0;
    };

    allUserRows.forEach((row) => {
      const id = (row && row.wallet_id) ? row.wallet_id : (typeof row === 'object' && row !== null ? row.id : null);
      if (id) addUser(id, row);
    });
    bindingArr.forEach(b => { if (b.wallet_id) addUser(b.wallet_id, {}); });
    triggerArr.forEach(t => { if (t.wallet_id) addUser(t.wallet_id, {}); });

    for (const [addr, u] of userMap) {
      const kycRecord = await db.kyc.findById(kycId(addr));
      u.kyc = kycRecord ? kycRecord.status : 'none';
      const userRow = allUserRows.find(r => normalizeAddress(r.wallet_id) === addr);
      if (userRow) {
        u.name = userRow.name || u.name;
        u.role = userRow.role || u.role;
        u.created_at = userRow.created_at || u.created_at;
      }
    }

    let list = Array.from(userMap.values());
    if (search) {
      list = list.filter(u => {
        const addr = (u.address || '').toLowerCase();
        const name = (u.name || '').toLowerCase();
        return addr.includes(search) || name.includes(search);
      });
    }
    list.sort((a, b) => {
      const ta = (a.created_at && new Date(a.created_at).getTime()) || 0;
      const tb = (b.created_at && new Date(b.created_at).getTime()) || 0;
      if (tb !== ta) return tb - ta;
      return (a.address || '').localeCompare(b.address || '');
    });

    const total = list.length;
    const start = (page - 1) * limit;
    const users = list.slice(start, start + limit);

    res.json({ users, total, page, limit });
  } catch (err) {
    console.error('[admin/users] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /users/:address ───

router.get('/users/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const addr = normalizeAddress(address);
    const userRow = await db.users.findById(addr);
    const bindings = await db.bindings.findByWallet(addr);
    const triggers = await db.triggers.findByWallet(addr);
    const kycRecord = await db.kyc.findById(kycId(addr));
    const kyc = kycRecord || { status: 'none' };

    const safeBindings = Array.isArray(bindings)
      ? bindings.map((b) => { const { encrypted_packages, ...rest } = b; return rest; })
      : [];
    res.json({
      address: addr,
      name: (userRow && userRow.name) || '',
      role: (userRow && userRow.role) || 'client',
      kyc,
      bindings: safeBindings,
      triggers: Array.isArray(triggers) ? triggers : [],
    });
  } catch (err) {
    console.error('[admin/users/:address] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /users/:address/role ───
// Body: { role: 'client' | 'authority' }. Setting to authority ensures an authority record exists for this user.

router.patch('/users/:address/role', async (req, res) => {
  try {
    const { address } = req.params;
    const addr = normalizeAddress(address);
    const { role } = req.body || {};
    if (!['client', 'authority'].includes(role)) {
      return res.status(400).json({ error: 'role must be "client" or "authority"' });
    }

    let userRow = await db.users.findById(addr);
    const now = new Date().toISOString();
    if (!userRow) {
      await db.users.create(addr, { wallet_id: addr, role, created_at: now, updated_at: now });
    } else {
      const updated = { ...userRow, role, updated_at: now };
      await db.users.update(addr, updated);
    }

    if (role === 'authority') {
      const authorityId = crypto.createHash('sha256').update(addr, 'hex').digest('hex');
      let authority = await db.authorities.findById(authorityId);
      if (!authority) {
        authority = {
          authority_id: authorityId,
          name: (userRow && userRow.name) || 'Authority',
          pubkey: addr,
          verified: false,
          region: null,
          active_bindings: 0,
          max_capacity: 100,
          created_at: now,
        };
        await db.authorities.create(authorityId, authority);
      }
    }

    const updatedUser = await db.users.findById(addr);
    return res.json({ address: addr, role: updatedUser?.role || role });
  } catch (err) {
    console.error('[admin/users/:address/role] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /authorities ───

router.get('/authorities', async (_req, res) => {
  try {
    const authorities = await db.authorities.findAll();
    res.json(Array.isArray(authorities) ? authorities : []);
  } catch (err) {
    console.error('[admin/authorities] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /triggers ───

router.get('/triggers', async (_req, res) => {
  try {
    const triggers = await db.triggers.findAll();
    res.json(Array.isArray(triggers) ? triggers : []);
  } catch (err) {
    console.error('[admin/triggers] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /trigger/policy — Release pause and high-value wallet list (from config/env) ───

router.get('/trigger/policy', (_req, res) => {
  const triggerConfig = config.trigger || {};
  res.json({
    releasePaused: !!triggerConfig.releasePaused,
    highValueWalletIds: Array.isArray(triggerConfig.highValueWalletIds) ? triggerConfig.highValueWalletIds : [],
  });
});

// ─── POST /trigger/:id/legal-confirm — Admin legal confirmation for dual attestation ───

router.post('/trigger/:id/legal-confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const trigger = await db.triggers.findById(id);
    if (!trigger) {
      return res.status(404).json({ error: 'Not found', detail: `Trigger ${id} not found` });
    }
    if (trigger.status !== 'cooldown') {
      return res.status(400).json({
        error: 'Invalid state',
        detail: `Trigger is in "${trigger.status}". Legal confirmation only applies to triggers in cooldown.`,
      });
    }
    const now = Date.now();
    const updated = { ...trigger, legal_confirmation_received_at: now };
    await db.triggers.update(id, updated);
    return res.json({
      trigger_id: id,
      legal_confirmation_received_at: now,
      message: 'Legal confirmation recorded by admin.',
    });
  } catch (err) {
    console.error('[admin/trigger/legal-confirm] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /trigger/:id/abort — Emergency abort: pause cooldown (remaining time is preserved for resume) ───

router.post('/trigger/:id/abort', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim().substring(0, 2000) : '';
    const trigger = await db.triggers.findById(id);
    if (!trigger) {
      return res.status(404).json({ error: 'Not found', detail: `Trigger ${id} not found` });
    }
    if (trigger.status !== 'cooldown') {
      return res.status(400).json({
        error: 'Invalid state',
        detail: `Trigger is in "${trigger.status}". Emergency abort only applies to triggers in cooldown.`,
      });
    }
    const now = Date.now();
    const remainingCooldownMs = Math.max(0, (trigger.effective_at || 0) - now);
    const adminId = req.adminAuth && (req.adminAuth.address || req.adminAuth.method) ? (req.adminAuth.address || req.adminAuth.method) : 'admin';
    const updated = {
      ...trigger,
      status: 'aborted',
      aborted_at: now,
      aborted_by: adminId,
      aborted_reason: reason || null,
      remaining_cooldown_ms: remainingCooldownMs,
    };
    await db.triggers.update(id, updated);
    try {
      await db.auditLog.create(`abort_${id}_${now}`, {
        type: 'TRIGGER_EMERGENCY_ABORT',
        trigger_id: id,
        wallet_id: trigger.wallet_id,
        recipient_index: trigger.recipient_index,
        aborted_at: now,
        aborted_by: adminId,
        aborted_reason: reason || null,
        remaining_cooldown_ms: remainingCooldownMs,
      });
    } catch (auditErr) {
      console.warn('[admin/trigger/abort] Audit log failed:', auditErr.message);
    }
    return res.json({
      trigger_id: id,
      status: 'aborted',
      aborted_at: now,
      remaining_cooldown_ms: remainingCooldownMs,
      message: 'Trigger aborted. Cooldown paused; on resume the remaining time will apply.',
    });
  } catch (err) {
    console.error('[admin/trigger/abort] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /trigger/:id/resume — Resume an aborted trigger; cooldown restarts with remaining time ───

router.post('/trigger/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const trigger = await db.triggers.findById(id);
    if (!trigger) {
      return res.status(404).json({ error: 'Not found', detail: `Trigger ${id} not found` });
    }
    if (trigger.status !== 'aborted') {
      return res.status(400).json({
        error: 'Invalid state',
        detail: `Trigger is in "${trigger.status}". Resume only applies to aborted triggers.`,
      });
    }
    const now = Date.now();
    const remainingMs = typeof trigger.remaining_cooldown_ms === 'number' && trigger.remaining_cooldown_ms >= 0
      ? trigger.remaining_cooldown_ms
      : 0;
    const newEffectiveAt = now + remainingMs;
    const adminId = req.adminAuth && (req.adminAuth.address || req.adminAuth.method) ? (req.adminAuth.address || req.adminAuth.method) : 'admin';
    const updated = {
      ...trigger,
      status: 'cooldown',
      effective_at: newEffectiveAt,
      cooldown_ms: remainingMs,
    };
    delete updated.aborted_at;
    delete updated.aborted_by;
    delete updated.aborted_reason;
    delete updated.remaining_cooldown_ms;
    await db.triggers.update(id, updated);
    try {
      await db.auditLog.create(`resume_${id}_${now}`, {
        type: 'TRIGGER_ABORT_RESUMED',
        trigger_id: id,
        wallet_id: trigger.wallet_id,
        recipient_index: trigger.recipient_index,
        resumed_at: now,
        resumed_by: adminId,
        remaining_cooldown_ms: remainingMs,
        new_effective_at: newEffectiveAt,
      });
    } catch (auditErr) {
      console.warn('[admin/trigger/resume] Audit log failed:', auditErr.message);
    }
    return res.json({
      trigger_id: id,
      status: 'cooldown',
      effective_at: newEffectiveAt,
      cooldown_remaining_ms: remainingMs,
      message: remainingMs > 0
        ? 'Trigger resumed. Cooldown restarted with remaining time; it will finalize when that expires (if not paused).'
        : 'Trigger resumed. Remaining time was 0; it will finalize on the next run (if not paused).',
    });
  } catch (err) {
    console.error('[admin/trigger/resume] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /trigger/emergency-release — Manual emergency release via fallback attestation ───

router.post('/trigger/emergency-release', async (req, res) => {
  try {
    const { wallet_id, recipient_index, evidence_hash } = req.body || {};
    const walletId = (wallet_id || '').trim();
    const recipientIndex = parseInt(recipient_index, 10);
    let evidenceHash = (evidence_hash || '').trim().replace(/^0x/i, '');
    if (!walletId || !Number.isInteger(recipientIndex) || recipientIndex < 0) {
      return res.status(400).json({ error: 'wallet_id and recipient_index (non-negative integer) are required' });
    }
    if (!evidenceHash || evidenceHash.length !== 64 || !/^[0-9a-fA-F]+$/.test(evidenceHash)) {
      return res.status(400).json({ error: 'evidence_hash must be a 64-char hex SHA-256 hash' });
    }
    const crypto = require('crypto');
    const { TriggerEvent } = require('../../models/schemas');
    const { submitFallbackAttestation } = require('../../services/attestationSubmitter');
    const { sendCooldownNotification } = require('../../services/email');
    const cooldownDefaultHours = (config.cooldown && config.cooldown.defaultHours) != null ? config.cooldown.defaultHours : 168;
    const cooldownMs = cooldownDefaultHours * 60 * 60 * 1000;
    const ORACLE_AUTHORITY_ID =
      config.oracle?.oracleAuthorityId ||
      crypto.createHash('sha256').update('yault-chainlink-oracle', 'utf8').digest('hex');
    const walletIdNo0x = walletId.replace(/^0x/i, '').toLowerCase();
    const walletIdNorm = `0x${walletIdNo0x}`;
    const existingWith0x = await db.triggers.findByWallet(walletIdNorm);
    const existingWithout0x = await db.triggers.findByWallet(walletIdNo0x);
    const existing = [...(existingWith0x || []), ...(existingWithout0x || [])];
    const normalizeWalletId = (v) => String(v || '').replace(/^0x/i, '').toLowerCase();
    const dup = existing.find(
      (t) =>
        normalizeWalletId(t.wallet_id) === walletIdNo0x &&
        Number(t.recipient_index) === recipientIndex &&
        (t.status === 'pending' || t.status === 'cooldown')
    );
    if (dup) {
      return res.status(409).json({
        error: 'Duplicate trigger',
        detail: 'An active trigger already exists for this wallet/recipient',
        trigger_id: dup.trigger_id,
      });
    }
    const now = Date.now();
    const effectiveAt = now + cooldownMs;
    const triggerId = crypto.randomBytes(16).toString('hex');
    const triggerValidation = TriggerEvent.validate({
      wallet_id: walletIdNorm,
      authority_id: ORACLE_AUTHORITY_ID,
      recipient_index: recipientIndex,
      tlock_round: undefined,
      arweave_tx_id: null,
      release_request: null,
    });
    if (!triggerValidation.valid) {
      return res.status(400).json({ error: 'Validation failed', details: triggerValidation.errors });
    }
    let attestationTxHash = null;
    try {
      const atResult = await submitFallbackAttestation(config, {
        walletId: walletIdNorm,
        recipientIndex,
        decision: 'release',
        evidenceHash,
      });
      attestationTxHash = atResult.txHash;
    } catch (atErr) {
      return res.status(502).json({
        error: 'Fallback attestation submit failed',
        detail: atErr.message,
      });
    }
    const record = {
      ...triggerValidation.data,
      trigger_id: triggerId,
      trigger_type: 'oracle',
      emergency_recovery: true,
      reason_code: 'authorized_request',
      matter_id: null,
      evidence_hash: evidenceHash,
      initiation_signature: null,
      initiated_by: 'admin-emergency-release',
      initiated_at: now,
      notes: 'Manual emergency release (fallback attestation)',
      status: 'cooldown',
      decision: 'release',
      decision_reason: 'Emergency recovery',
      decision_reason_code: 'authorized_request',
      decision_evidence_hash: evidenceHash,
      decision_signature: null,
      cooldown_ms: cooldownMs,
      decided_at: now,
      effective_at: effectiveAt,
      decided_by: 'admin',
    };
    await db.triggers.create(triggerId, record);
    try {
      const bindings = await db.bindings.findByWallet(walletIdNorm);
      const binding = bindings.find((b) => b.status === 'active');
      const emails = [];
      if (binding && binding.authority_id) {
        const authority = await db.authorities.findById(binding.authority_id);
        if (authority && authority.email) emails.push(authority.email);
      }
      if (process.env.COOLDOWN_NOTIFY_EMAIL) emails.push(process.env.COOLDOWN_NOTIFY_EMAIL);
      if (emails.length > 0) {
        await sendCooldownNotification(emails, {
          triggerId,
          walletId: walletIdNorm,
          recipientIndex,
          effectiveAt,
        });
      }
    } catch (emailErr) {
      console.warn('[admin/emergency-release] Cooldown notification failed:', emailErr.message);
    }
    return res.status(201).json({
      trigger_id: triggerId,
      status: 'cooldown',
      emergency_recovery: true,
      attestation_tx: attestationTxHash,
      effective_at: effectiveAt,
      cooldown_hours: cooldownDefaultHours,
    });
  } catch (err) {
    console.error('[admin/trigger/emergency-release] Error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── GET /revenue ───

router.get('/revenue', async (_req, res) => {
  try {
    const revenue = await db.revenue.findAll();
    const records = Array.isArray(revenue) ? revenue : [];

    let platformTotal = 0;
    let authorityTotal = 0;
    let userTotal = 0;
    records.forEach(r => {
      platformTotal += r.platform_fee || 0;
      authorityTotal += r.authority_fee || 0;
      userTotal += r.user_yield || 0;
    });

    res.json({
      records_count: records.length,
      platform_revenue: platformTotal,
      authority_revenue: authorityTotal,
      user_yield: userTotal,
      records: records.slice(0, 50), // latest 50
    });
  } catch (err) {
    console.error('[admin/revenue] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── KYC Endpoints ───

// GET /kyc — List all KYC submissions (address is stored inside each document)
router.get('/kyc', async (_req, res) => {
  try {
    const all = await db.kyc.findAll();
    const entries = (Array.isArray(all) ? all : []).map(record => ({
      address: record.address || '',
      ...record,
    }));
    res.json(entries);
  } catch (err) {
    console.error('[admin/kyc] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /kyc/:address/review — Approve or reject
router.post('/kyc/:address/review', async (req, res) => {
  try {
    const { address } = req.params;
    const { decision, reason } = req.body || {};
    const id = kycId(address);

    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    }

    const existing = await db.kyc.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'No KYC submission found for this address' });
    }

    const updated = {
      ...existing,
      address: id,
      status: decision,
      reviewed_at: new Date().toISOString(),
      review_reason: reason || '',
    };
    await db.kyc.create(id, updated);
    res.json({ address: id, status: decision });
  } catch (err) {
    console.error('[admin/kyc/review] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Campaign CRUD (placeholder for referral / rebate) ───

router.get('/campaigns', async (_req, res) => {
  try {
    const all = await db.campaigns.findAll();
    return res.json(Array.isArray(all) ? all : []);
  } catch (err) {
    console.error('[admin/campaigns] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await db.campaigns.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(campaign);
  } catch (err) {
    console.error('[admin/campaigns/:id] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { CampaignConfig } = require('../../models/schemas');
    const validation = CampaignConfig.validate(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }
    const id = crypto.randomUUID();
    const record = { ...validation.data, campaign_id: id };
    await db.campaigns.create(id, record);
    return res.status(201).json(record);
  } catch (err) {
    console.error('[admin/campaigns] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/campaigns/:id', async (req, res) => {
  try {
    const { CampaignConfig } = require('../../models/schemas');
    const existing = await db.campaigns.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    const allowedFields = ['name', 'enabled', 'rebate_bps', 'max_per_user_bps',
      'start_date', 'end_date', 'referral_yield_boost_bps', 'invitee_fee_waiver_days', 'status'];
    const merged = { ...existing, updated_at: Date.now() };
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) merged[field] = req.body[field];
    }
    const validation = CampaignConfig.validate(merged);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }
    const updated = {
      ...validation.data,
      campaign_id: existing.campaign_id,
      created_at: existing.created_at,
      updated_at: Date.now(),
    };
    await db.campaigns.update(req.params.id, updated);
    return res.json(updated);
  } catch (err) {
    console.error('[admin/campaigns] PATCH error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Referrals: list all referral records (admin view)
router.get('/referrals', async (_req, res) => {
  try {
    const all = await db.referrals.findAll();
    return res.json(Array.isArray(all) ? all : []);
  } catch (err) {
    console.error('[admin/referrals] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Public KYC Submit (called by client-portal, no admin auth) ───
// This is exported separately and mounted without adminAuth

const kycSubmitRouter = Router();

// POST /api/kyc/submit — requires auth; caller can only submit KYC for their own address
kycSubmitRouter.post('/submit', dualAuthMiddleware, async (req, res) => {
  try {
    const { address, level, provider } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }
    const id = kycId(address);
    const callerAddr = (req.auth?.pubkey || '').replace(/^0x/i, '').toLowerCase();
    if (id !== callerAddr) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only submit KYC for your own wallet address',
      });
    }

    const existing = await db.kyc.findById(id);
    if (existing && existing.status === 'approved') {
      return res.json({ address: id, status: 'approved', message: 'Already verified' });
    }

    const doc = {
      address: id,
      status: 'pending',
      level: level || 'basic',
      provider: provider || 'manual',
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
      documents: [],
    };
    await db.kyc.create(id, doc);

    res.json({
      address: id,
      status: 'pending',
      message: 'KYC submission received. Persisted in DB. Provider API integration is future.',
    });
  } catch (err) {
    console.error('[kyc/submit] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/kyc/status/:address — requires auth; caller may only query their own address
kycSubmitRouter.get('/status/:address', dualAuthMiddleware, async (req, res) => {
  try {
    const { address } = req.params;
    const id = kycId(address);
    const callerAddr = (req.auth?.pubkey || '').replace(/^0x/i, '').toLowerCase();
    if (id !== callerAddr) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view KYC status for your own wallet address',
      });
    }
    const data = await db.kyc.findById(id);
    if (!data) {
      return res.json({ address: id, status: 'none', message: 'No KYC submission found' });
    }
    res.json({ address: id, ...data });
  } catch (err) {
    console.error('[kyc/status] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { adminRouter: router, kycSubmitRouter };
