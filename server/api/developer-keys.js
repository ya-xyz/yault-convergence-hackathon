/**
 * Developer API Keys — Agent / MCP integration keys
 *
 * POST /          - Generate a new API key
 * GET  /          - List all keys (hashed, no plaintext)
 * DELETE /:id     - Revoke a key
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../middleware/auth');
const db = require('../db');

const router = Router();

/** Block agent API keys from managing keys/policies — only wallet-signed requests allowed. */
function requireWalletAuth(req, res, next) {
  if (req.auth?.walletType === 'agent') {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'Agent API keys cannot manage developer keys. Use a wallet-signed request.',
    });
  }
  next();
}

/** Maximum keys per wallet to prevent abuse. */
const MAX_KEYS_PER_WALLET = 10;

/**
 * @route POST /
 * @description Generate a new agent API key.
 */
router.post('/', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const label = (req.body.label || '').trim().slice(0, 100) || 'Default';

    // Check existing key count
    const existing = await db.agentApiKeys.findByWallet(walletId);
    if (existing.length >= MAX_KEYS_PER_WALLET) {
      return res.status(400).json({
        error: 'Key limit reached',
        detail: `Maximum ${MAX_KEYS_PER_WALLET} API keys per wallet`,
      });
    }

    // Generate secret key: sk-yault-<32 random bytes base64url>
    const secret = crypto.randomBytes(32).toString('base64url');
    const plainKey = `sk-yault-${secret}`;
    const keyHash = crypto.createHash('sha256').update(plainKey, 'utf8').digest('hex');
    const keyId = crypto.randomBytes(16).toString('hex');
    const prefix = plainKey.slice(0, 14); // "sk-yault-XXXXX" for display

    // Generate public agent ID: pk-yault-<16 random bytes base64url>
    // This is the OAuth "client_id" equivalent — safe to share, shown in UI.
    const agentId = `pk-yault-${crypto.randomBytes(16).toString('base64url')}`;

    const record = {
      key_id: keyId,
      wallet_id: walletId,
      key_hash: keyHash,
      prefix,
      agent_id: agentId,
      label,
      created_at: Date.now(),
      last_used_at: null,
    };

    await db.agentApiKeys.create(keyId, record);

    // Audit log
    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'agent_api_key_created',
      wallet_id: walletId,
      key_id: keyId,
      label,
      timestamp: Date.now(),
    });

    // Return plaintext key ONLY on creation — never stored or shown again
    return res.status(201).json({
      key_id: keyId,
      agent_id: agentId,
      key: plainKey,
      prefix,
      label,
      created_at: record.created_at,
      message: 'Save this key now — it will not be shown again.',
    });
  } catch (err) {
    console.error('[developer-keys] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /
 * @description List all API keys for the authenticated wallet (no plaintext).
 */
router.get('/', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const keys = await db.agentApiKeys.findByWallet(walletId);

    return res.json({
      keys: keys
        .sort((a, b) => b.created_at - a.created_at)
        .map((k) => ({
          key_id: k.key_id,
          agent_id: k.agent_id || null,
          prefix: k.prefix,
          label: k.label,
          policy_id: k.policy_id || null,
          created_at: k.created_at,
          last_used_at: k.last_used_at,
        })),
      total: keys.length,
      limit: MAX_KEYS_PER_WALLET,
    });
  } catch (err) {
    console.error('[developer-keys] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route DELETE /:id
 * @description Revoke an API key. Only the owner can revoke.
 */
router.delete('/:id', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const { id } = req.params;

    const key = await db.agentApiKeys.findById(id);
    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }
    if (key.wallet_id !== walletId) {
      return res.status(403).json({ error: 'Not authorized to revoke this key' });
    }

    await db.agentApiKeys.delete(id);

    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'agent_api_key_revoked',
      wallet_id: walletId,
      key_id: id,
      timestamp: Date.now(),
    });

    return res.json({ key_id: id, status: 'revoked' });
  } catch (err) {
    console.error('[developer-keys] DELETE error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route PUT /:id/policy
 * @description Bind or unbind a spending policy to an API key.
 */
router.put('/:id/policy', dualAuthMiddleware, requireWalletAuth, async (req, res) => {
  try {
    const walletId = req.auth.pubkey;
    const { id } = req.params;
    const { policy_id } = req.body || {};

    const key = await db.agentApiKeys.findById(id);
    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }
    if (key.wallet_id !== walletId) {
      return res.status(403).json({ error: 'Not authorized to modify this key' });
    }

    if (policy_id) {
      const policy = await db.spendingPolicies.findById(policy_id);
      if (!policy || policy.wallet_id !== walletId) {
        return res.status(400).json({ error: 'Policy not found or not owned by this wallet' });
      }
    }

    const updated = { ...key, policy_id: policy_id || null };
    await db.agentApiKeys.update(id, updated);

    await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
      type: 'agent_api_key_policy_bound',
      wallet_id: walletId,
      key_id: id,
      policy_id: policy_id || null,
      timestamp: Date.now(),
    });

    return res.json({ key_id: id, policy_id: updated.policy_id });
  } catch (err) {
    console.error('[developer-keys] PUT policy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
