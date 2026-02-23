/**
 * POST /api/release/release-factors
 *
 * Authority submits all admin_factors for a wallet after trigger release.
 * These are stored in the platform DB for recipient claim lookup.
 *
 * Body: {
 *   wallet_id:   string,
 *   trigger_id:  string,
 *   admin_factors: [
 *     { index: 1, admin_factor_hex: "...", blob_hex?: "..." },  // blob_hex = 80 hex (AF 32 + amount 8)
 *     ...
 *   ]
 * }
 *
 * Returns: { stored: N, verified: true/false }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const db = require('../../db');

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { wallet_id, trigger_id, admin_factors } = req.body || {};

    // Validation
    const errors = [];
    if (!wallet_id || typeof wallet_id !== 'string') errors.push('wallet_id is required');
    if (!trigger_id || typeof trigger_id !== 'string') errors.push('trigger_id is required');
    if (!Array.isArray(admin_factors) || admin_factors.length === 0) {
      errors.push('admin_factors must be a non-empty array');
    }

    if (Array.isArray(admin_factors)) {
      admin_factors.forEach((af, i) => {
        if (!Number.isInteger(af.index) || af.index < 1) {
          errors.push(`admin_factors[${i}].index must be a positive integer`);
        }
        if (typeof af.admin_factor_hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(af.admin_factor_hex)) {
          errors.push(`admin_factors[${i}].admin_factor_hex must be a 64-char hex string (32 bytes)`);
        }
        if (af.blob_hex != null) {
          const bh = String(af.blob_hex).replace(/^0x/i, '').trim();
          if (bh.length !== 80 || !/^[0-9a-fA-F]+$/.test(bh)) {
            errors.push(`admin_factors[${i}].blob_hex must be 80 hex chars (32 AF + 8 amount)`);
          }
        }
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // Verify trigger exists and is released
    const trigger = await db.triggers.findById(trigger_id);
    if (!trigger) {
      return res.status(404).json({ error: 'Trigger not found' });
    }
    // Note: Triggers with trigger_type === 'oracle' have authority_id = oracle (no Ed25519 key).
    // AdminFactor is still held by the entity authority; extend this endpoint to allow the
    // bound entity authority to submit admin_factors for oracle-created triggers if needed.
    if (trigger.status !== 'released') {
      return res.status(400).json({
        error: 'Trigger not released',
        detail: `Trigger status is "${trigger.status}", expected "released"`,
      });
    }
    if (trigger.wallet_id.toLowerCase() !== wallet_id.toLowerCase()) {
      return res.status(400).json({ error: 'Trigger wallet_id mismatch' });
    }

    // Security: only the authority who made the release decision can submit admin_factors
    const callerAuthorityId = req.auth?.authority_id;
    if (!callerAuthorityId || callerAuthorityId !== trigger.authority_id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'Only the authority who made the release decision can submit admin factors',
      });
    }

    // Verify fingerprints match stored config (if available)
    // Try exact match first, then case-insensitive
    let pathConfigs = await db.recipientPaths.findByWallet(wallet_id);
    if (pathConfigs.length === 0) {
      pathConfigs = await db.recipientPaths.findByWallet(wallet_id.toLowerCase());
    }
    let verified = false;

    if (pathConfigs.length > 0) {
      const storedPaths = pathConfigs[0].paths;
      verified = admin_factors.every(af => {
        const fingerprint = crypto.createHash('sha256')
          .update(Buffer.from(af.admin_factor_hex, 'hex'))
          .digest('hex');
        const stored = storedPaths.find(sp => sp.index === af.index);
        return stored && stored.admin_factor_fingerprint === fingerprint;
      });
    }

    // Store released factors (optional blob_hex; recipient_mnemonic_hash from path config so authority knows blob ↔ wallet)
    const storedPaths = pathConfigs.length > 0 ? pathConfigs[0].paths : [];
    const recordId = crypto.randomBytes(16).toString('hex');
    const record = {
      wallet_id,
      trigger_id,
      factors: admin_factors.map(af => {
        const fingerprint = crypto.createHash('sha256')
          .update(Buffer.from(af.admin_factor_hex, 'hex'))
          .digest('hex');
        const pathEntry = storedPaths.find(sp => sp.index === af.index);
        const out = {
          index: af.index,
          admin_factor_hex: af.admin_factor_hex.toLowerCase(),
          fingerprint,
        };
        if (af.blob_hex != null) {
          const bh = String(af.blob_hex).replace(/^0x/i, '').trim();
          if (bh.length === 80 && /^[0-9a-fA-F]+$/.test(bh)) {
            out.blob_hex = bh.toLowerCase();
          }
        }
        if (pathEntry && pathEntry.recipient_mnemonic_hash) {
          out.recipient_mnemonic_hash = pathEntry.recipient_mnemonic_hash;
        }
        return out;
      }),
      verified,
      released_at: Date.now(),
    };

    await db.releasedFactors.create(recordId, record);

    return res.status(201).json({
      stored: admin_factors.length,
      verified,
    });
  } catch (err) {
    console.error('[release/release-factors] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
