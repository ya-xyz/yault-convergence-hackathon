/**
 * POST /api/trigger/initiate
 *
 * Authority manually initiates a release trigger based on a legal event
 * (e.g., verified death certificate, court order, probate completion).
 *
 * This replaces the previous tlock auto-expiry notification mechanism.
 * The authority must have completed all off-chain legal verification before
 * calling this endpoint. The platform acts as a "legal-event relay" — it
 * does not judge the validity of the legal event; it records and audits it.
 *
 * Requires: Authority authentication (Ed25519 challenge-response)
 *
 * Body: {
 *   wallet_id:         string  (required) — Owner's pseudonymous wallet ID
 *   recipient_index:   number  (required) — 1-based recipient path index
 *   reason_code:       string  (required) — One of ReleaseDecision.VALID_REASON_CODES
 *   matter_id:         string  (optional) — Internal case / matter reference
 *   evidence_hash:     string  (required) — SHA-256 hash of legal evidence bundle
 *   signature:         string  (required) — Ed25519 signature of evidence_hash
 *   notes:             string  (optional) — Free-text notes for audit
 * }
 *
 * Returns 201: { trigger_id, status: "pending", notified }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { TriggerEvent, ReleaseDecision } = require('../../models/schemas');
const db = require('../../db');
const config = require('../../config');
const { sendTriggerNotification } = require('../../services/email');
const { getAttestation } = require('../../services/attestationClient');
const { authorityAuthMiddleware } = require('../../middleware/auth');

const router = Router();

/**
 * @route POST /
 * @description Authority initiates a legal-event trigger for a recipient path.
 */
router.post('/', authorityAuthMiddleware, async (req, res) => {
  try {
    const {
      wallet_id,
      recipient_index,
      reason_code,
      matter_id,
      evidence_hash,
      signature,
      notes,
    } = req.body || {};

    // ── Validation ──────────────────────────────────────────────────────

    const errors = [];

    if (!wallet_id || typeof wallet_id !== 'string') {
      errors.push('wallet_id is required and must be a non-empty string');
    }
    if (!Number.isInteger(recipient_index) || recipient_index < 0) {
      errors.push('recipient_index must be a non-negative integer');
    }
    if (!reason_code || !ReleaseDecision.VALID_REASON_CODES.includes(reason_code)) {
      errors.push(
        `reason_code is required and must be one of: ${ReleaseDecision.VALID_REASON_CODES.join(', ')}`
      );
    }
    if (!evidence_hash || typeof evidence_hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(evidence_hash)) {
      errors.push('evidence_hash must be a 64-character hex SHA-256 hash');
    }
    if (!signature || typeof signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signature)) {
      errors.push('signature must be a 128-character hex Ed25519 signature');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // This endpoint requires Ed25519 authority (64-char pubkey). EVM/yallet (40-char) cannot sign evidence_hash here.
    const pubkeyHex = (req.auth.pubkey || '').replace(/^0x/i, '');
    if (pubkeyHex.length !== 64) {
      return res.status(400).json({
        error: 'Ed25519 authority required',
        detail: 'Trigger initiation requires signing with an Ed25519 wallet (e.g. Phantom). Please sign in with an Ed25519 authority key to initiate triggers.',
      });
    }

    // ── Verify Ed25519 signature ──────────────────────────────────────
    try {
      const nacl = require('tweetnacl');
      const messageBytes = Buffer.from(evidence_hash, 'hex');
      const signatureBytes = Buffer.from(signature, 'hex');
      const pubkeyBytes = Buffer.from(pubkeyHex, 'hex');
      const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
      if (!isValid) {
        return res.status(401).json({
          error: 'Signature verification failed',
          detail: 'The Ed25519 signature does not match the evidence_hash and authenticated public key.',
        });
      }
    } catch (sigErr) {
      return res.status(400).json({
        error: 'Signature verification error',
        detail: 'Could not verify signature. Ensure it is a valid 128-character hex Ed25519 signature.',
      });
    }

    // ── Oracle first: if chain has oracle release attestation, entity is fallback ──
    const authorityId = req.auth.authority_id;
    if (config.oracle?.enabled && config.oracle?.releaseAttestationAddress) {
      const attestation = await getAttestation({
        rpcUrl: config.oracle.rpcUrl,
        contractAddress: config.oracle.releaseAttestationAddress,
        walletId: wallet_id,
        recipientIndex: recipient_index,
      });
      if (attestation?.source === 'oracle' && attestation?.decision === 'release') {
        return res.status(409).json({
          error: 'Oracle already attested release',
          detail:
            'An oracle attestation for release exists for this wallet/recipient. Create trigger via POST /api/trigger/from-oracle or check GET /api/trigger/attestation.',
        });
      }
    }

    // ── Verify binding ──────────────────────────────────────────────────

    const bindings = await db.bindings.findByWallet(wallet_id);
    const activeBinding = bindings.find(
      (b) =>
        b.authority_id === authorityId &&
        b.status === 'active' &&
        Array.isArray(b.recipient_indices) &&
        b.recipient_indices.some((idx) => Number(idx) === Number(recipient_index))
    );

    if (!activeBinding) {
      return res.status(403).json({
        error: 'No active binding',
        detail:
          'No active binding found between this authority and the specified wallet/recipient.',
      });
    }

    // ── Validate TriggerEvent schema ────────────────────────────────────

    const triggerValidation = TriggerEvent.validate({
      wallet_id,
      authority_id: authorityId,
      recipient_index,
      tlock_round: undefined, // No tlock round — this is a legal-event release trigger
      arweave_tx_id: null,
      release_request: null,
    });

    if (!triggerValidation.valid) {
      return res.status(400).json({
        error: 'Internal validation failed',
        details: triggerValidation.errors,
      });
    }

    const triggerId = crypto.randomBytes(16).toString('hex');
    const now = Date.now();

    const record = {
      ...triggerValidation.data,
      trigger_id: triggerId,
      trigger_type: 'legal_event', // Distinguish from legacy tlock triggers
      reason_code,
      matter_id: matter_id ? String(matter_id).trim() : null,
      evidence_hash,
      initiation_signature: signature,
      initiated_by: req.auth.pubkey,
      initiated_at: now,
      notes: notes ? String(notes).substring(0, 2000) : null,
    };

    // ── Atomic duplicate check + create in a single transaction ────────
    try {
      db.triggers.runTransaction(() => {
        const innerDb = db._getDb();

        // Check for duplicate inside the transaction to prevent TOCTOU
        // H-11 FIX: Add size guard and early exit for duplicate check
        const countResult = innerDb.exec('SELECT COUNT(*) FROM "triggers"');
        const totalTriggers = countResult.length > 0 ? countResult[0].values[0][0] : 0;
        if (totalTriggers > 10000) {
          console.warn('[trigger/initiate] Warning: trigger table exceeds 10K records, duplicate check may be slow');
        }
        const results = innerDb.exec('SELECT data FROM "triggers"');
        if (results.length > 0) {
          for (const row of results[0].values) {
            const t = JSON.parse(row[0]);
            if (
              t.authority_id === authorityId &&
              t.wallet_id === wallet_id &&
              t.recipient_index === recipient_index &&
              (t.status === 'pending' || t.status === 'cooldown')
            ) {
              throw new Error('DUPLICATE_TRIGGER');
            }
          }
        }

        // Create trigger
        innerDb.run('INSERT OR REPLACE INTO "triggers" (id, data) VALUES (?, ?)',
          [triggerId, JSON.stringify(record)]);
      });
    } catch (txErr) {
      if (txErr.message === 'DUPLICATE_TRIGGER') {
        return res.status(409).json({
          error: 'Duplicate trigger',
          detail: 'An active trigger already exists for this recipient path.',
        });
      }
      throw txErr;
    }

    // ── Audit log ───────────────────────────────────────────────────────

    const auditRecord = {
      type: 'TRIGGER_INITIATED',
      trigger_id: triggerId,
      wallet_id,
      authority_id: authorityId,
      recipient_index,
      reason_code,
      matter_id: record.matter_id,
      evidence_hash,
      initiated_at: now,
    };

    try {
      await db.auditLog.create(`initiate_${triggerId}`, auditRecord);
    } catch {
      // Audit log failure is non-fatal
    }

    // ── Notification ────────────────────────────────────────────────────

    let notified = false;
    try {
      const authority = await db.authorities.findById(authorityId);
      if (authority && authority.email) {
        await sendTriggerNotification(
          authority.email,
          wallet_id,
          recipient_index
        );
        notified = true;
      }
    } catch (emailErr) {
      console.error('[trigger/initiate] Email notification failed:', emailErr.message);
    }

    // ── Response ────────────────────────────────────────────────────────

    return res.status(201).json({
      trigger_id: triggerId,
      status: 'pending',
      trigger_type: 'legal_event',
      reason_code,
      matter_id: record.matter_id,
      notified,
      message: 'Trigger created. Proceed to POST /api/trigger/:id/decision to submit release decision.',
    });
  } catch (err) {
    console.error('[trigger/initiate] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
