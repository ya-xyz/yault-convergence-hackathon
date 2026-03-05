/**
 * POST /api/release/prepare-distribute
 *
 * Prepare distribution of the authorization factor to selected authorities.
 * Each authority receives one E2E encrypted package (full factor, encrypted for that authority).
 *
 * Body: { admin_factor_hex, firms: [{ id, name, public_key_hex }] }
 * Returns: { fingerprint, packages: [{ authorityId, firmName, packageHex, ephemeralPubkeyHex, delivered }] }
 *
 * Stub: generates one package per firm (stub ciphertext). Production client would
 * encrypt the full admin_factor_hex per authority's public key and send those packages
 * via POST /api/release/distribute.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const router = Router();

router.post('/', (req, res) => {
  try {
    const { admin_factor_hex, firms } = req.body || {};

    if (!admin_factor_hex || !/^[0-9a-fA-F]{64}$/.test(admin_factor_hex)) {
      return res.status(400).json({ error: 'admin_factor_hex must be a 64-character hex string' });
    }
    if (!Array.isArray(firms) || firms.length < 1) {
      return res.status(400).json({ error: 'At least 1 firm is required' });
    }

    const fingerprint = crypto
      .createHash('sha256')
      .update(Buffer.from(admin_factor_hex, 'hex'))
      .digest('hex');

    // One package per authority (full factor encrypted for that authority; stub = random bytes)
    const packages = firms.map((firm) => ({
      authorityId: firm.id,
      firmName: firm.name || firm.id,
      packageHex: crypto.randomBytes(48).toString('hex'),
      ephemeralPubkeyHex: crypto.randomBytes(32).toString('hex'),
      delivered: true,
    }));

    return res.json({
      fingerprint,
      packages,
    });
  } catch (err) {
    console.error('[release/prepare-distribute] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
