/**
 * POST /api/authority/:id/verify
 *
 * Admin endpoint to verify an authority's license / credentials.
 * Supports two auth methods:
 *   1. Legacy: X-Admin-Token header (admin token)
 *   2. Wallet: Authorization: EVM <challengeId>:<signature> with address in ADMIN_WALLETS
 *
 * Params: :id - authority_id
 * Body: { verification_proof }
 * Returns: { verified: true, authority_id }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const db = require('../../db');
const { verifySignature } = require('../../middleware/auth');

const router = Router();

/** Admin token from environment. No fallback — must be explicitly configured. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

/** Comma-separated EVM addresses authorized as admin (with or without 0x prefix). */
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '')
  .split(',')
  .map(a => a.trim().replace(/^["']|["']$/g, '').replace(/^0x/i, '').toLowerCase())
  .filter(a => /^[0-9a-f]{40}$/.test(a));

/**
 * Check if the request has valid admin authorization.
 * Supports: X-Admin-Token, X-Admin-Session (async), EVM wallet signature.
 * Returns { authorized: true } or { authorized: false, status, error }.
 */
async function checkAdminAuth(req) {
  // Method 1: Admin token in header
  const token = req.headers['x-admin-token'];
  if (ADMIN_TOKEN && token && typeof token === 'string' &&
      token.length === ADMIN_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return { authorized: true, method: 'token' };
  }

  // Method 2: X-Admin-Session (Ops portal wallet login)
  const sessionToken = req.headers['x-admin-session'];
  if (sessionToken && ADMIN_WALLETS.length > 0) {
    const session = await db.adminSessions.findById(sessionToken);
    if (session && session.expires > Date.now()) {
      const addr = (session.address || '').replace(/^0x/i, '').toLowerCase();
      if (ADMIN_WALLETS.includes(addr)) {
        return { authorized: true, method: 'session' };
      }
    }
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
          return { authorized: true, method: 'wallet', address: addr };
        }
        return { authorized: false, status: 403, error: 'Wallet not authorized as admin' };
      }
      return { authorized: false, status: 401, error: result.error || 'Signature verification failed' };
    }
  }

  return { authorized: false, status: 403, error: 'Invalid or missing admin authorization' };
}

/**
 * @route POST /:id/verify
 * @description Mark an authority as verified (admin only).
 */
router.post('/:id/verify', async (req, res) => {
  try {
    if (!ADMIN_TOKEN && ADMIN_WALLETS.length === 0) {
      return res.status(503).json({ error: 'Admin verification not configured' });
    }

    const { id } = req.params;
    const { verification_proof } = req.body || {};

    // Admin authorization check (token, session, or wallet signature)
    const authCheck = await checkAdminAuth(req);
    if (!authCheck.authorized) {
      return res.status(authCheck.status).json({
        error: 'Forbidden',
        detail: authCheck.error,
      });
    }

    // Find the authority
    const authority = await db.authorities.findById(id);
    if (!authority) {
      return res.status(404).json({
        error: 'Not found',
        detail: `Authority with id ${id} not found`,
      });
    }

    if (authority.verified) {
      return res.status(200).json({
        authority_id: id,
        verified: true,
        detail: 'Already verified',
      });
    }

    // Update verification status
    const updatedRecord = {
      ...authority,
      verified: true,
      verification_proof: verification_proof || null,
      verified_at: Date.now(),
    };

    await db.authorities.update(id, updatedRecord);

    return res.json({
      authority_id: id,
      verified: true,
    });
  } catch (err) {
    console.error('[authority/verify] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
