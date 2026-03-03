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
const rateLimit = require('express-rate-limit');
const { AuthorityProfile } = require('../../models/schemas');
const db = require('../../db');

// Strict rate limit on key rotation: 5 per hour per IP
const rotateKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many key rotation attempts, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});

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

/**
 * @route POST /rotate-key
 * @description Rotate an authority's Ed25519 public key.
 *              Requires the old key to sign the rotation request (proving ownership).
 *              Creates a new authority_id (SHA256(newPubkey)) and migrates all bindings.
 * Body: { old_authority_id, new_pubkey, signature (of "rotate:{old_authority_id}:{new_pubkey}" signed by old key) }
 */
router.post('/rotate-key', rotateKeyLimiter, async (req, res) => {
  try {
    const { old_authority_id, new_pubkey, signature } = req.body || {};

    if (!old_authority_id || !new_pubkey || !signature) {
      return res.status(400).json({ error: 'old_authority_id, new_pubkey, and signature are required' });
    }
    if (typeof new_pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(new_pubkey)) {
      return res.status(400).json({ error: 'new_pubkey must be a 64-char hex string (32 bytes Ed25519)' });
    }

    // Look up old authority
    const oldAuth = await db.authorities.findById(old_authority_id);
    if (!oldAuth) {
      return res.status(404).json({ error: 'Authority not found' });
    }

    // Verify signature using old key (Ed25519)
    const message = `rotate:${old_authority_id}:${new_pubkey}`;
    let verified = false;
    try {
      const { verify } = require('../../services/ed25519');
      verified = verify(message, signature, oldAuth.pubkey);
    } catch (verifyErr) {
      console.error('[authority/rotate-key] Signature verification error:', verifyErr.message);
      return res.status(400).json({ error: 'Signature verification failed' });
    }
    if (!verified) {
      return res.status(403).json({ error: 'Invalid signature — must be signed by the current authority key' });
    }

    // Compute new authority_id
    const newAuthorityId = crypto
      .createHash('sha256')
      .update(new_pubkey, 'hex')
      .digest('hex');

    // Prevent collision
    const existingNew = await db.authorities.findById(newAuthorityId);
    if (existingNew) {
      return res.status(409).json({ error: 'New key is already registered as a different authority' });
    }

    // Atomicity: create new record, update old record, and migrate bindings.
    // If any step fails, roll back completed steps to prevent inconsistent state.
    const newRecord = {
      ...oldAuth,
      pubkey: new_pubkey,
      authority_id: newAuthorityId,
      previous_authority_id: old_authority_id,
      key_rotated_at: new Date().toISOString(),
    };
    const updatedOld = {
      ...oldAuth,
      status: 'key_rotated',
      rotated_to: newAuthorityId,
      rotated_at: new Date().toISOString(),
    };

    // Step 1: Create new authority record
    await db.authorities.create(newAuthorityId, newRecord);

    // Step 2: Mark old authority as rotated
    try {
      await db.authorities.update(old_authority_id, updatedOld);
    } catch (step2Err) {
      // Rollback step 1: delete newly created record
      try { await db.authorities.delete(newAuthorityId); } catch (_) {}
      throw step2Err;
    }

    // Step 3: Migrate bindings
    const bindings = await db.bindings.findByAuthority(old_authority_id);
    const migratedBindingIds = [];
    try {
      for (const binding of bindings) {
        const bindingId = binding.id || `${binding.wallet_id}_${old_authority_id}`;
        const updatedBinding = { ...binding, authority_id: newAuthorityId };
        await db.bindings.update(bindingId, updatedBinding);
        migratedBindingIds.push({ id: bindingId, original: binding });
      }
    } catch (step3Err) {
      // Rollback step 3: restore already-migrated bindings
      for (const { id: bId, original } of migratedBindingIds) {
        try { await db.bindings.update(bId, original); } catch (_) {}
      }
      // Rollback step 2: restore old authority
      try { await db.authorities.update(old_authority_id, oldAuth); } catch (_) {}
      // Rollback step 1: delete new authority
      try { await db.authorities.delete(newAuthorityId); } catch (_) {}
      throw step3Err;
    }

    return res.status(200).json({
      old_authority_id,
      new_authority_id: newAuthorityId,
      bindings_migrated: bindings.length,
    });
  } catch (err) {
    console.error('[authority/rotate-key] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
