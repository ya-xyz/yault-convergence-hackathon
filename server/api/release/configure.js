/**
 * POST /api/release/configure
 *
 * Store recipient path configuration (labels, weights, fingerprints) and optional
 * trigger type (oracle | legal_event | activity_drand) and tlock/authority/oracle info.
 *
 * Body: {
 *   wallet_id:  string,
 *   trigger_type?: 'oracle' | 'legal_event' | 'activity_drand',
 *   tlock_duration_months?: number,   // for activity_drand: 6, 12, 24, ...
 *   authority_id?: string,           // for legal_event or activity_drand
 *   oracle_info?: { ... },           // for oracle (optional placeholder)
 *   paths: [
 *     { index: 1, label: "...", weight: 10, admin_factor_fingerprint: "abc...", email?: "...",
 *       recipient_evm_address?: "0x...", recipient_btc_address?: "...", recipient_solana_address?: "..." },
 *     ...
 *   ]
 * }
 *
 * Returns: { wallet_id, paths_count, total_weight, trigger_type?, tlock_duration_months? }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const db = require('../../db');

const router = Router();

const VALID_TRIGGER_TYPES = ['oracle', 'legal_event', 'activity_drand'];
const VALID_TLOCK_MONTHS = [6, 12, 24, 36, 60];

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/**
 * Verify caller owns the wallet_id (only wallet owner can configure or read config).
 */
function verifyWalletOwnership(req, walletId) {
  if (!req.auth || !req.auth.pubkey) return false;
  return normalizeAddr(req.auth.pubkey) === normalizeAddr(walletId);
}

/**
 * GET /api/release/configure?wallet_id=...
 * Returns stored release config for the wallet (paths, trigger_type, tlock_duration_months, authority_id, oracle_info).
 * Security: caller must own the wallet_id.
 */
router.get('/', async (req, res) => {
  try {
    const wallet_id = req.query.wallet_id;
    if (!wallet_id || typeof wallet_id !== 'string') {
      return res.status(400).json({ error: 'wallet_id query is required' });
    }
    if (!verifyWalletOwnership(req, wallet_id)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view release config for your own wallet',
      });
    }
    const id = crypto.createHash('sha256').update(wallet_id).digest('hex').slice(0, 32);
    const record = await db.recipientPaths.findById(id);
    if (!record) {
      return res.json({ wallet_id, configured: false, paths: [], trigger_type: null, tlock_duration_months: null });
    }
    return res.json({
      wallet_id: record.wallet_id,
      configured: true,
      paths: record.paths || [],
      total_weight: record.total_weight,
      trigger_type: record.trigger_type || null,
      tlock_duration_months: record.tlock_duration_months ?? null,
      authority_id: record.authority_id || null,
      oracle_info: record.oracle_info || null,
    });
  } catch (err) {
    console.error('[release/configure] GET Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { wallet_id, paths, trigger_type, tlock_duration_months, authority_id, oracle_info } = req.body || {};

    // Validation
    const errors = [];
    if (!wallet_id || typeof wallet_id !== 'string') {
      errors.push('wallet_id is required');
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      errors.push('paths must be a non-empty array');
    }
    if (trigger_type != null && !VALID_TRIGGER_TYPES.includes(trigger_type)) {
      errors.push(`trigger_type must be one of: ${VALID_TRIGGER_TYPES.join(', ')}`);
    }
    if (tlock_duration_months != null) {
      const m = Number(tlock_duration_months);
      if (!Number.isInteger(m) || !VALID_TLOCK_MONTHS.includes(m)) {
        errors.push(`tlock_duration_months must be one of: ${VALID_TLOCK_MONTHS.join(', ')}`);
      }
    }
    if (trigger_type === 'activity_drand' && (tlock_duration_months == null || !VALID_TLOCK_MONTHS.includes(Number(tlock_duration_months)))) {
      errors.push('tlock_duration_months is required for activity_drand (e.g. 6, 12, 24)');
    }

    if (Array.isArray(paths)) {
      paths.forEach((p, i) => {
        if (!Number.isInteger(p.index) || p.index < 1) {
          errors.push(`paths[${i}].index must be a positive integer`);
        }
        if (typeof p.label !== 'string' || !p.label.trim()) {
          errors.push(`paths[${i}].label is required`);
        }
        if (typeof p.weight !== 'number' || p.weight <= 0) {
          errors.push(`paths[${i}].weight must be a positive number`);
        }
        if (typeof p.admin_factor_fingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(p.admin_factor_fingerprint)) {
          errors.push(`paths[${i}].admin_factor_fingerprint must be a 64-char hex SHA-256`);
        }
        if (p.recipient_mnemonic_hash != null && (typeof p.recipient_mnemonic_hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(String(p.recipient_mnemonic_hash).replace(/^0x/i, '')))) {
          errors.push(`paths[${i}].recipient_mnemonic_hash must be a 64-char hex string (e.g. SHA-256 of mnemonic)`);
        }
        if (p.recipient_evm_address != null && typeof p.recipient_evm_address === 'string' && p.recipient_evm_address.trim()) {
          const addr = p.recipient_evm_address.trim().replace(/^0x/i, '');
          if (addr.length !== 40 || !/^[0-9a-fA-F]+$/.test(addr)) {
            errors.push(`paths[${i}].recipient_evm_address must be a valid EVM address (0x + 40 hex chars)`);
          }
        }
        if (p.recipient_btc_address != null && typeof p.recipient_btc_address === 'string' && p.recipient_btc_address.trim()) {
          const btc = p.recipient_btc_address.trim();
          if (btc.length < 26 || btc.length > 62) {
            errors.push(`paths[${i}].recipient_btc_address must be a valid Bitcoin address (26–62 chars)`);
          }
        }
        if (p.recipient_solana_address != null && typeof p.recipient_solana_address === 'string' && p.recipient_solana_address.trim()) {
          const sol = p.recipient_solana_address.trim();
          if (sol.length < 32 || sol.length > 44) {
            errors.push(`paths[${i}].recipient_solana_address must be a valid Solana address (32–44 chars)`);
          }
        }
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // Security: caller must own the wallet_id
    if (!verifyWalletOwnership(req, wallet_id)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only configure release paths for your own wallet',
      });
    }

    // If authority_id is provided, verify it exists and is verified
    if (authority_id && typeof authority_id === 'string') {
      const authority = await db.authorities.findById(authority_id);
      if (!authority) {
        return res.status(400).json({ error: 'Validation failed', details: ['authority_id not found'] });
      }
      if (!authority.verified) {
        return res.status(400).json({ error: 'Validation failed', details: ['authority is not verified'] });
      }
    }

    const totalWeight = paths.reduce((sum, p) => sum + p.weight, 0);

    const record = {
      wallet_id,
      paths: paths.map(p => {
        const out = {
          index: p.index,
          label: p.label.trim(),
          weight: p.weight,
          percentage: ((p.weight / totalWeight) * 100).toFixed(2),
          admin_factor_fingerprint: p.admin_factor_fingerprint.toLowerCase(),
          recipient_evm_address: (typeof p.recipient_evm_address === 'string' && p.recipient_evm_address.trim()) ? p.recipient_evm_address.trim() : null,
          recipient_btc_address: (typeof p.recipient_btc_address === 'string' && p.recipient_btc_address.trim()) ? p.recipient_btc_address.trim() : null,
          recipient_solana_address: (typeof p.recipient_solana_address === 'string' && p.recipient_solana_address.trim()) ? p.recipient_solana_address.trim() : null,
          email: (typeof p.email === 'string' && p.email.trim()) ? p.email.trim().toLowerCase() : null,
        };
        if (p.recipient_mnemonic_hash != null) {
          const h = String(p.recipient_mnemonic_hash).replace(/^0x/i, '').trim();
          if (h.length === 64 && /^[0-9a-fA-F]+$/.test(h)) out.recipient_mnemonic_hash = h.toLowerCase();
        }
        return out;
      }),
      total_weight: totalWeight,
      created_at: Date.now(),
    };

    if (trigger_type != null) record.trigger_type = trigger_type;
    if (tlock_duration_months != null) record.tlock_duration_months = Number(tlock_duration_months);
    if (authority_id != null && typeof authority_id === 'string') record.authority_id = authority_id.trim();
    if (oracle_info != null && typeof oracle_info === 'object') record.oracle_info = oracle_info;

    // Use wallet_id as the key (one config per wallet, upsert)
    const id = crypto.createHash('sha256').update(wallet_id).digest('hex').slice(0, 32);
    await db.recipientPaths.create(id, record);

    const out = { wallet_id, paths_count: paths.length, total_weight: totalWeight };
    if (record.trigger_type) out.trigger_type = record.trigger_type;
    if (record.tlock_duration_months) out.tlock_duration_months = record.tlock_duration_months;
    return res.status(201).json(out);
  } catch (err) {
    console.error('[release/configure] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
