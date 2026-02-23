/**
 * POST /api/authority/register
 *
 * Authority registration: submit profile + license + Ed25519 pubkey.
 * Generates a deterministic authority_id = SHA256(pubkey).
 *
 * Body: { name, bar_number, jurisdiction, specialization[], languages[], pubkey, fee_structure }
 * Returns: { authority_id, status: "pending_verification" }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { AuthorityProfile } = require('../../models/schemas');
const db = require('../../db');

const router = Router();

/**
 * @route POST /
 * @description Register a new authority on the platform.
 */
router.post('/', async (req, res) => {
  try {
    const validation = AuthorityProfile.validate(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
      });
    }

    const profile = validation.data;

    // Deterministic authority_id derived from public key
    const authorityId = crypto
      .createHash('sha256')
      .update(profile.pubkey, 'hex')
      .digest('hex');

    // Check for duplicate registration
    const existing = await db.authorities.findById(authorityId);
    if (existing) {
      return res.status(409).json({
        error: 'Authority already registered',
        authority_id: authorityId,
      });
    }

    // Persist the profile
    const record = {
      ...profile,
      authority_id: authorityId,
    };
    await db.authorities.create(authorityId, record);

    return res.status(201).json({
      authority_id: authorityId,
      status: 'pending_verification',
    });
  } catch (err) {
    console.error('[authority/register] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
