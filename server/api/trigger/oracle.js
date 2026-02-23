/**
 * Oracle authority integration: read chain attestation, create trigger from oracle.
 *
 * GET /api/trigger/attestation?wallet_id=&recipient_index=
 *   Returns attestation from ReleaseAttestation contract (oracle or fallback), if any.
 *
 * POST /api/trigger/from-oracle
 *   Body: { wallet_id, recipient_index }
 *   If chain has oracle attestation with decision=release, creates a trigger record with
 *   authority_id = oracle (and optionally enters cooldown). Otherwise 404.
 *   No auth required; rate-limit recommended. Used by platform/cron after CRE writes to chain.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const config = require('../../config');
const db =require('../../db');
const { getAttestation } = require('../../services/attestationClient');
const { evaluateReleaseAttestationGate } = require('../../services/attestationGate');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const { TriggerEvent, ReleaseDecision } = require('../../models/schemas');
// Note: RWA delivery for oracle triggers happens in decision.js maybeFinalizeDecision() when cooldown expires.

const router = Router();

/** When set, POST /from-oracle requires X-Oracle-Internal-Key header to match (for cron/CRE only). */
const ORACLE_INTERNAL_API_KEY = process.env.ORACLE_INTERNAL_API_KEY || '';

// Deterministic authority_id for "oracle" (used when creating triggers from chain attestation).
const ORACLE_AUTHORITY_ID =
  config.oracle?.oracleAuthorityId ||
  crypto.createHash('sha256').update('yault-chainlink-oracle', 'utf8').digest('hex');

function parseRecipientIndexStrict(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * GET /api/trigger/attestation
 * Query: wallet_id (required), recipient_index (required)
 * Returns: { attestation: { source, decision, ... } | null, oracle_enabled }
 */
router.get('/attestation', async (req, res) => {
  try {
    const { wallet_id, recipient_index } = req.query;
    const oracleEnabled =
      config.oracle?.enabled && config.oracle?.releaseAttestationAddress;

    if (!wallet_id || recipient_index === undefined) {
      return res.status(400).json({
        error: 'Missing query parameters',
        detail: 'wallet_id and recipient_index are required',
      });
    }
    const recipientIndex = parseRecipientIndexStrict(recipient_index);
    if (!Number.isInteger(recipientIndex) || recipientIndex < 0) {
      return res.status(400).json({
        error: 'Invalid recipient_index',
        detail: 'recipient_index must be a non-negative integer',
      });
    }

    if (!oracleEnabled) {
      return res.json({ attestation: null, oracle_enabled: false });
    }

    const attestation = await getAttestation({
      rpcUrl: config.oracle.rpcUrl,
      contractAddress: config.oracle.releaseAttestationAddress,
      walletId: String(wallet_id).trim(),
      recipientIndex,
    });

    return res.json({
      attestation,
      oracle_enabled: true,
    });
  } catch (err) {
    console.error('[trigger/oracle] GET attestation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/trigger/attestation-check
 * Query: wallet_id, recipient_index
 * Auth: authority session/signature required.
 * Returns policy gate result used before/after release decision handling.
 */
router.get('/attestation-check', authorityAuthMiddleware, async (req, res) => {
  try {
    const { wallet_id, recipient_index } = req.query || {};
    if (!wallet_id || recipient_index === undefined) {
      return res.status(400).json({
        error: 'Missing query parameters',
        detail: 'wallet_id and recipient_index are required',
      });
    }
    const idx = parseRecipientIndexStrict(recipient_index);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({
        error: 'Invalid recipient_index',
        detail: 'recipient_index must be a non-negative integer',
      });
    }

    const gate = await evaluateReleaseAttestationGate({
      walletId: String(wallet_id).trim(),
      recipientIndex: idx,
    });
    return res.json({
      valid: gate.valid,
      code: gate.code,
      detail: gate.detail,
      attestation: gate.attestation,
    });
  } catch (err) {
    console.error('[trigger/oracle] GET attestation-check error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/trigger/from-oracle
 * Body: { wallet_id, recipient_index }
 * Creates a trigger from chain oracle attestation when decision is release.
 * Fallback: when no oracle attestation, client should use POST /api/trigger/initiate with entity authority.
 */
router.post('/from-oracle', async (req, res) => {
  try {
    // In production, ORACLE_INTERNAL_API_KEY is required (SECURITY: prevent open from-oracle abuse).
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && (!ORACLE_INTERNAL_API_KEY || ORACLE_INTERNAL_API_KEY.length === 0)) {
      return res.status(503).json({
        error: 'Service unavailable',
        detail: 'from-oracle is disabled: set ORACLE_INTERNAL_API_KEY in production (cron/CRE only).',
      });
    }
    // When key is set, require valid X-Oracle-Internal-Key (constant-time compare).
    if (ORACLE_INTERNAL_API_KEY && ORACLE_INTERNAL_API_KEY.length > 0) {
      const key = req.headers['x-oracle-internal-key'];
      const keyBuf = Buffer.from(key || '', 'utf8');
      const expectedBuf = Buffer.from(ORACLE_INTERNAL_API_KEY, 'utf8');
      if (keyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
        return res.status(403).json({
          error: 'Forbidden',
          detail: 'from-oracle requires valid X-Oracle-Internal-Key (set ORACLE_INTERNAL_API_KEY for cron/CRE).',
        });
      }
    }

    const oracleEnabled =
      config.oracle?.enabled && config.oracle?.releaseAttestationAddress;
    if (!oracleEnabled) {
      return res.status(503).json({
        error: 'Oracle attestation not enabled',
        detail: 'Set ORACLE_ATTESTATION_ENABLED=true and RELEASE_ATTESTATION_ADDRESS',
      });
    }

    const { wallet_id, recipient_index } = req.body || {};
    if (!wallet_id || recipient_index === undefined) {
      return res.status(400).json({
        error: 'Missing body fields',
        detail: 'wallet_id and recipient_index are required',
      });
    }
    const walletIdTrimmed = String(wallet_id).trim();
    if (!walletIdTrimmed) {
      return res.status(400).json({
        error: 'Invalid wallet_id',
        detail: 'wallet_id must be a non-empty string after trim',
      });
    }
    const recipientIndex = parseRecipientIndexStrict(recipient_index);
    if (!Number.isInteger(recipientIndex) || recipientIndex < 0) {
      return res.status(400).json({
        error: 'Invalid recipient_index',
        detail: 'recipient_index must be a non-negative integer',
      });
    }

    const attestation = await getAttestation({
      rpcUrl: config.oracle.rpcUrl,
      contractAddress: config.oracle.releaseAttestationAddress,
      walletId: walletIdTrimmed,
      recipientIndex,
    });

    if (!attestation || attestation.source !== 'oracle') {
      return res.status(404).json({
        error: 'No oracle attestation',
        detail:
          'No oracle attestation found for this wallet/recipient. Use entity authority as fallback (POST /api/trigger/initiate).',
      });
    }

    if (attestation.decision !== 'release') {
      return res.status(400).json({
        error: 'Oracle attestation is not release',
        detail: `Oracle decision is "${attestation.decision}". Only release can create a trigger.`,
      });
    }

    // Duplicate check: same wallet/recipient with pending or cooldown (use trimmed wallet_id)
    const existing = await db.triggers.findByWallet(walletIdTrimmed);
    const duplicate = existing?.find(
      (t) =>
        t.recipient_index === recipientIndex &&
        (t.status === 'pending' || t.status === 'cooldown')
    );
    if (duplicate) {
      return res.status(409).json({
        error: 'Duplicate trigger',
        detail: 'An active trigger already exists for this recipient path.',
        trigger_id: duplicate.trigger_id,
      });
    }

    const triggerId = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const cooldownMs = ReleaseDecision.DEFAULT_COOLDOWN_MS;
    const effectiveAt = now + cooldownMs;

    const triggerValidation = TriggerEvent.validate({
      wallet_id: walletIdTrimmed,
      authority_id: ORACLE_AUTHORITY_ID,
      recipient_index: recipientIndex,
      tlock_round: undefined,
      arweave_tx_id: null,
      release_request: null,
    });
    if (!triggerValidation.valid) {
      return res.status(400).json({
        error: 'Internal validation failed',
        details: triggerValidation.errors,
      });
    }

    const record = {
      ...triggerValidation.data,
      trigger_id: triggerId,
      trigger_type: 'oracle',
      reason_code: 'authorized_request',
      matter_id: null,
      evidence_hash: attestation.evidenceHash,
      initiation_signature: null,
      initiated_by: 'oracle',
      initiated_at: now,
      notes: 'Created from Chainlink oracle attestation',
      status: 'cooldown',
      decision: 'release',
      decision_reason: 'Oracle attestation',
      decision_reason_code: 'authorized_request',
      decision_evidence_hash: attestation.evidenceHash,
      decision_signature: null,
      cooldown_ms: cooldownMs,
      decided_at: now,
      effective_at: effectiveAt,
      decided_by: 'oracle',
    };

    await db.triggers.create(triggerId, record);

    try {
      await db.auditLog.create(`from_oracle_${triggerId}`, {
        type: 'TRIGGER_FROM_ORACLE',
        trigger_id: triggerId,
        wallet_id: walletIdTrimmed,
        authority_id: ORACLE_AUTHORITY_ID,
        recipient_index: recipientIndex,
        attestation_source: attestation.source,
        attestation_timestamp: attestation.timestamp,
        created_at: now,
      });
    } catch (auditErr) {
      // #19 FIX: Log non-fatal errors instead of silently swallowing
      console.warn('[trigger/oracle] Non-fatal: audit log write failed:', auditErr.message);
    }

    return res.status(201).json({
      trigger_id: triggerId,
      status: 'cooldown',
      trigger_type: 'oracle',
      decision: 'release',
      effective_at: effectiveAt,
      cooldown_remaining_ms: cooldownMs,
      message:
        'Trigger created from oracle attestation. Cooldown applies; after cooldown, decision will be finalized.',
    });
  } catch (err) {
    console.error('[trigger/oracle] POST from-oracle error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Router for /api/oracle/* (CRE workflow polls GET /api/oracle/pending).
 * HACKATHON: Simple in-memory queue to simulate pending requests for the oracle cron workflow.
 */
const oraclePendingRouter = new Router();

// In-memory store for pending requests. In production, this would be a persistent DB table.
const PENDING_ORACLE_REQUESTS = [];

/**
 * POST /api/oracle/request-attestation
 * Body: { wallet_id, recipient_index, decision }
 * Simulates a platform action that queues a task for the oracle workflow.
 */
oraclePendingRouter.post('/request-attestation', (req, res) => {
  const { wallet_id, recipient_index, decision } = req.body;

  if (!wallet_id || recipient_index === undefined || !decision) {
    return res.status(400).json({ error: 'Missing wallet_id, recipient_index, or decision' });
  }
  const validDecisions = ['release', 'hold', 'reject'];
  if (!validDecisions.includes(decision)) {
      return res.status(400).json({ error: `Invalid decision. Must be one of [${validDecisions.join(', ')}]` });
  }

  const request = {
    wallet_id,
    recipient_index: parseInt(recipient_index, 10),
    decision,
    // The oracle workflow expects an evidence_hash. We'll generate a dummy one for the demo.
    evidence_hash: crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex'),
    requested_at: Date.now(),
  };

  PENDING_ORACLE_REQUESTS.push(request);
  console.log(`[trigger/oracle] Queued attestation request: ${wallet_id}/${request.recipient_index}`);

  res.status(202).json({ message: 'Oracle attestation requested.', request });
});


/**
 * GET /api/oracle/pending
 * Returns pending requests for the Chainlink oracle (CRE) workflow.
 */
oraclePendingRouter.get('/pending', (_req, res) => {
  const oracleEnabled =
    config.oracle?.enabled && config.oracle?.releaseAttestationAddress;
  if (!oracleEnabled) {
    return res.json({ requests: [] });
  }

  // Dequeue the oldest request (FIFO) for the CRE workflow to process.
  const request = PENDING_ORACLE_REQUESTS.shift();
  if (!request) {
    return res.json({ requests: [] });
  }

  console.log(`[trigger/oracle] Dequeued attestation request for CRE: ${request.wallet_id}/${request.recipient_index}`);
  // The oracle workflow expects an array of requests.
  return res.json({ requests: [request] });
});

module.exports = router;
module.exports.oraclePendingRouter = oraclePendingRouter;
