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
const { submitFallbackAttestation, submitOracleAttestation } = require('../../services/attestationSubmitter');
const { dualAuthMiddleware, authorityAuthMiddleware } = require('../../middleware/auth');
const { TriggerEvent, ReleaseDecision } = require('../../models/schemas');
const { sendCooldownNotification } = require('../../services/email');
// Note: RWA delivery for oracle triggers happens in decision.js maybeFinalizeDecision() when cooldown expires.

const router = Router();

// Lock map to prevent TOCTOU race in trigger creation
const _triggerCreationLocks = new Map();
function acquireTriggerLock(key) {
  if (_triggerCreationLocks.has(key)) return false;
  _triggerCreationLocks.set(key, Date.now());
  return true;
}
function releaseTriggerLock(key) {
  _triggerCreationLocks.delete(key);
}
// Clean stale locks every 60s (in case of crash mid-flow)
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _triggerCreationLocks) {
    if (now - ts > 30000) _triggerCreationLocks.delete(k);
  }
}, 60000).unref();

function getDefaultCooldownMs() {
  const mins = config.cooldown && config.cooldown.defaultMinutes != null ? config.cooldown.defaultMinutes : null;
  if (mins != null) return mins * 60 * 1000;
  const h = config.cooldown && config.cooldown.defaultHours != null ? config.cooldown.defaultHours : 168;
  // Enforce maxHours cap to prevent misconfiguration
  const maxH = config.cooldown && config.cooldown.maxHours != null ? config.cooldown.maxHours : 168;
  const capped = Math.min(h, maxH);
  return capped * 60 * 60 * 1000;
}

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
router.get('/attestation', dualAuthMiddleware, async (req, res) => {
  try {
    const { wallet_id, recipient_index, plan_id } = req.query;
    const queryPlanId = plan_id ? String(plan_id).trim() : null;
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
      planId: queryPlanId,
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
    const { wallet_id, recipient_index, plan_id } = req.query || {};
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
    const checkPlanId = plan_id ? String(plan_id).trim() : null;

    const gate = await evaluateReleaseAttestationGate({
      walletId: String(wallet_id).trim(),
      recipientIndex: idx,
      planId: checkPlanId,
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
    // SECURITY: ORACLE_INTERNAL_API_KEY is always required (all environments).
    if (!ORACLE_INTERNAL_API_KEY || ORACLE_INTERNAL_API_KEY.length === 0) {
      return res.status(503).json({
        error: 'Service unavailable',
        detail: 'from-oracle is disabled: set ORACLE_INTERNAL_API_KEY (cron/CRE only).',
      });
    }
    // Require valid X-Oracle-Internal-Key (constant-time compare).
    const key = req.headers['x-oracle-internal-key'];
    const keyBuf = Buffer.from(key || '', 'utf8');
    const expectedBuf = Buffer.from(ORACLE_INTERNAL_API_KEY, 'utf8');
    if (keyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'from-oracle requires valid X-Oracle-Internal-Key.',
      });
    }

    const oracleEnabled =
      config.oracle?.enabled && config.oracle?.releaseAttestationAddress;
    if (!oracleEnabled) {
      return res.status(503).json({
        error: 'Oracle attestation not enabled',
        detail: 'Set ORACLE_ATTESTATION_ENABLED=true and RELEASE_ATTESTATION_ADDRESS',
      });
    }

    const { wallet_id, recipient_index, plan_id } = req.body || {};
    if (!wallet_id || recipient_index === undefined) {
      return res.status(400).json({
        error: 'Missing body fields',
        detail: 'wallet_id and recipient_index are required',
      });
    }
    if (!plan_id || !String(plan_id).trim()) {
      return res.status(400).json({ error: 'plan_id is required' });
    }
    const walletIdTrimmed = String(wallet_id).trim();
    const planId = plan_id ? String(plan_id).trim() : null;
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
      planId,
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

    // Acquire lock to prevent TOCTOU race condition on concurrent trigger creation
    const lockKey = planId ? `${walletIdTrimmed}_${recipientIndex}_${planId}` : `${walletIdTrimmed}_${recipientIndex}`;
    if (!acquireTriggerLock(lockKey)) {
      return res.status(409).json({
        error: 'Concurrent request',
        detail: 'Another trigger creation is in progress for this wallet/recipient. Please retry.',
      });
    }

    // Duplicate check: same wallet/recipient/plan with pending or cooldown (use trimmed wallet_id)
    let triggerId, cooldownMs, effectiveAt, now;
    try {
      const existing = await db.triggers.findByWallet(walletIdTrimmed);
      const duplicate = existing?.find(
        (t) =>
          t.recipient_index === recipientIndex &&
          (t.status === 'pending' || t.status === 'cooldown') &&
          t.plan_id === planId
      );
      if (duplicate) {
        return res.status(409).json({
          error: 'Duplicate trigger',
          detail: 'An active trigger already exists for this recipient path.',
          trigger_id: duplicate.trigger_id,
        });
      }

      triggerId = crypto.randomBytes(16).toString('hex');
      now = Date.now();
      cooldownMs = getDefaultCooldownMs();
      effectiveAt = now + cooldownMs;

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
        plan_id: planId,
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
    } finally {
      releaseTriggerLock(lockKey);
    }

    try {
      await db.auditLog.create(`from_oracle_${triggerId}`, {
        type: 'TRIGGER_FROM_ORACLE',
        trigger_id: triggerId,
        plan_id: planId,
        wallet_id: walletIdTrimmed,
        authority_id: ORACLE_AUTHORITY_ID,
        recipient_index: recipientIndex,
        attestation_source: attestation.source,
        attestation_timestamp: attestation.timestamp,
        created_at: now,
      });
    } catch (auditErr) {
      console.warn('[trigger/oracle] Non-fatal: audit log write failed:', auditErr.message);
    }

    try {
      const bindings = await db.bindings.findByWallet(walletIdTrimmed);
      const binding = bindings.find(
        (b) => b.status === 'active' && b.plan_id === planId
      );
      const emails = [];
      if (binding && binding.authority_id) {
        const authority = await db.authorities.findById(binding.authority_id);
        if (authority && authority.email) emails.push(authority.email);
      }
      if (process.env.COOLDOWN_NOTIFY_EMAIL) emails.push(process.env.COOLDOWN_NOTIFY_EMAIL);
      if (emails.length > 0) {
        await sendCooldownNotification(emails, {
          triggerId,
          walletId: walletIdTrimmed,
          recipientIndex,
          effectiveAt,
        });
      }
    } catch (emailErr) {
      console.warn('[trigger/oracle] Cooldown notification failed:', emailErr.message);
    }

    return res.status(201).json({
      trigger_id: triggerId,
      plan_id: planId,
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
 * POST /api/trigger/simulate-chainlink
 * HACKATHON DEMO: Simulate a Chainlink oracle event that triggers release for all recipients.
 * 1. Finds active binding for the authenticated wallet
 * 2. Submits fallback attestation on-chain for each recipient (simulating CRE)
 * 3. Creates cooldown triggers
 * Auth: wallet session required.
 */
router.post('/simulate-chainlink', dualAuthMiddleware, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      return res.status(403).json({ error: 'Simulate endpoints disabled in production/staging' });
    }

    const oracleEnabled = config.oracle?.enabled && config.oracle?.releaseAttestationAddress;
    if (!oracleEnabled) {
      return res.status(503).json({ error: 'Oracle not configured' });
    }

    const { plan_id: reqPlanId } = req.body || {};
    const simPlanId = reqPlanId ? String(reqPlanId).trim() : null;
    if (!simPlanId) {
      return res.status(400).json({ error: 'plan_id is required' });
    }
    const pubkey = (req.auth.pubkey || '').replace(/^0x/i, '').toLowerCase();
    const walletId = '0x' + pubkey;

    // Find active binding — match by plan_id when present
    let walletBindings = await db.bindings.findByWallet(walletId);
    if (walletBindings.length === 0) {
      try {
        const { ethers } = require('ethers');
        const checksummed = ethers.getAddress(walletId);
        if (checksummed !== walletId) {
          walletBindings = await db.bindings.findByWallet(checksummed);
        }
      } catch (_) {}
    }
    const binding = walletBindings.find((b) =>
      b.status === 'active' &&
      b.plan_id === simPlanId
    );
    if (!binding || !Array.isArray(binding.recipient_indices) || binding.recipient_indices.length === 0) {
      return res.status(404).json({ error: 'No active binding with recipient indices found for this wallet' });
    }

    const indices = binding.recipient_indices.map(Number);
    const cooldownMs = getDefaultCooldownMs();
    const cooldownHours = cooldownMs / (60 * 60 * 1000);
    const cooldownMinutes = Math.round(cooldownMs / 60000);
    const now = Date.now();
    const effectiveAt = now + cooldownMs;
    const results = [];

    for (const recipientIndex of indices) {
      try {
        // 1. Submit fallback attestation on-chain (simulates what Chainlink CRE would do)
        const evidenceHash = crypto.createHash('sha256')
          .update(`simulate-chainlink-${walletId}-${recipientIndex}-${now}`)
          .digest('hex');

        let attestationTxHash = null;
        try {
          // Always write a fresh oracle attestation so the timestamp is current.
          // Old attestations may have expired (>7 days) and block the gate check.
          const atResult = await submitOracleAttestation(config, {
            walletId,
            recipientIndex,
            decision: 'release',
            reasonCode: null,
            evidenceHash,
            planId: simPlanId,
          });
          attestationTxHash = atResult.txHash;
          console.log(`[simulate-chainlink] Attestation submitted for ${walletId}/${recipientIndex}: ${attestationTxHash}`);
        } catch (atErr) {
          // Attestation write failed — check if a valid attestation already exists on-chain.
          // The contract doesn't allow overwriting, so the write will fail if one already exists.
          // If a valid (non-expired, decision=release) attestation exists, continue; otherwise FAIL LOUDLY.
          console.warn(`[simulate-chainlink] Attestation write failed for index ${recipientIndex}: ${atErr.message}. Checking for existing valid attestation...`);
          try {
            const existing = await getAttestation({
              rpcUrl: config.oracle.rpcUrl,
              contractAddress: config.oracle.releaseAttestationAddress,
              walletId,
              recipientIndex,
              planId: simPlanId,
            });
            if (existing && existing.decision === 'release') {
              const ts = Number(existing.timestamp || 0);
              const maxAgeMs = Math.max(1, parseInt(process.env.ATTESTATION_MAX_AGE_SEC || `${7 * 24 * 60 * 60}`, 10)) * 1000;
              const ageMs = ts > 0 ? Date.now() - ts * 1000 : Infinity;
              if (ageMs < maxAgeMs) {
                console.log(`[simulate-chainlink] Existing valid attestation found for index ${recipientIndex} (source=${existing.source}), continuing.`);
                attestationTxHash = 'existing-on-chain';
              } else {
                console.error(`[simulate-chainlink] FATAL: Existing attestation for index ${recipientIndex} is EXPIRED (age=${Math.floor(ageMs / 1000)}s). Cannot proceed.`);
                results.push({ recipientIndex, status: 'attestation_failed', error: `Attestation expired and write failed: ${atErr.message}` });
                continue;
              }
            } else {
              console.error(`[simulate-chainlink] FATAL: No valid release attestation on-chain for index ${recipientIndex}. Write failed: ${atErr.message}`);
              results.push({ recipientIndex, status: 'attestation_failed', error: `No valid attestation and write failed: ${atErr.message}` });
              continue;
            }
          } catch (checkErr) {
            console.error(`[simulate-chainlink] FATAL: Cannot verify attestation for index ${recipientIndex}: ${checkErr.message}`);
            results.push({ recipientIndex, status: 'attestation_failed', error: `Attestation write failed and check failed: ${atErr.message}` });
            continue;
          }
        }

        // 2. Check for duplicate trigger (plan-scoped)
        const existing = await db.triggers.findByWallet(walletId);
        const dup = existing?.find(
          (t) => t.recipient_index === recipientIndex &&
                 (t.status === 'pending' || t.status === 'cooldown') &&
                 t.plan_id === simPlanId
        );
        if (dup) {
          results.push({ recipientIndex, status: 'duplicate', trigger_id: dup.trigger_id });
          continue;
        }

        // 3. Create trigger with cooldown
        const triggerId = crypto.randomBytes(16).toString('hex');
        const triggerValidation = TriggerEvent.validate({
          wallet_id: walletId,
          authority_id: ORACLE_AUTHORITY_ID,
          recipient_index: recipientIndex,
          tlock_round: undefined,
          arweave_tx_id: null,
          release_request: null,
        });
        if (!triggerValidation.valid) {
          results.push({ recipientIndex, status: 'validation_error', errors: triggerValidation.errors });
          continue;
        }

        const record = {
          ...triggerValidation.data,
          trigger_id: triggerId,
          plan_id: simPlanId,
          trigger_type: 'oracle',
          reason_code: 'authorized_request',
          matter_id: null,
          evidence_hash: evidenceHash,
          initiation_signature: null,
          initiated_by: 'simulate-chainlink',
          initiated_at: now,
          notes: 'Simulated Chainlink oracle event (hackathon demo)',
          status: 'cooldown',
          decision: 'release',
          decision_reason: 'Simulated oracle attestation',
          decision_reason_code: 'authorized_request',
          decision_evidence_hash: evidenceHash,
          decision_signature: null,
          cooldown_ms: cooldownMs,
          decided_at: now,
          effective_at: effectiveAt,
          decided_by: 'oracle',
        };
        await db.triggers.create(triggerId, record);
        try {
          const emails = [];
          if (binding.authority_id) {
            const authority = await db.authorities.findById(binding.authority_id);
            if (authority && authority.email) emails.push(authority.email);
          }
          if (process.env.COOLDOWN_NOTIFY_EMAIL) emails.push(process.env.COOLDOWN_NOTIFY_EMAIL);
          if (emails.length > 0) {
            await sendCooldownNotification(emails, {
              triggerId,
              walletId,
              recipientIndex,
              effectiveAt,
            });
          }
        } catch (emailErr) {
          console.warn('[simulate-chainlink] Cooldown notification failed:', emailErr.message);
        }
        results.push({ recipientIndex, status: 'created', trigger_id: triggerId, attestation_tx: attestationTxHash });
      } catch (indexErr) {
        console.error(`[simulate-chainlink] Error for index ${recipientIndex}:`, indexErr);
        results.push({ recipientIndex, status: 'error', error: indexErr.message });
      }
    }

    return res.json({
      success: true,
      wallet_id: walletId,
      plan_id: simPlanId,
      triggers: results,
      cooldown_ms: cooldownMs,
      cooldown_minutes: cooldownMinutes,
      cooldown_hours: cooldownHours,
      effective_at: effectiveAt,
    });
  } catch (err) {
    console.error('[simulate-chainlink] Error:', err);
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
const MAX_ORACLE_QUEUE_SIZE = 1000;

/**
 * POST /api/oracle/request-attestation
 * Body: { wallet_id, recipient_index, decision }
 * Simulates a platform action that queues a task for the oracle workflow.
 */
function oracleKeyGuard(req, res, next) {
  if (ORACLE_INTERNAL_API_KEY && ORACLE_INTERNAL_API_KEY.length > 0) {
    const provided = req.headers['x-oracle-internal-key'] || '';
    const expectedBuf = Buffer.from(ORACLE_INTERNAL_API_KEY, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return res.status(401).json({ error: 'Unauthorized', detail: 'Invalid or missing X-Oracle-Internal-Key' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Oracle queue disabled', detail: 'Set ORACLE_INTERNAL_API_KEY in production' });
  }
  next();
}

oraclePendingRouter.post('/request-attestation', oracleKeyGuard, (req, res) => {
  const { wallet_id, recipient_index, decision, plan_id } = req.body;

  if (!wallet_id || recipient_index === undefined || !decision) {
    return res.status(400).json({ error: 'Missing wallet_id, recipient_index, or decision' });
  }
  if (!plan_id || !String(plan_id).trim()) {
    return res.status(400).json({ error: 'Missing plan_id' });
  }
  const validDecisions = ['release', 'hold', 'reject'];
  if (!validDecisions.includes(decision)) {
      return res.status(400).json({ error: `Invalid decision. Must be one of [${validDecisions.join(', ')}]` });
  }

  if (PENDING_ORACLE_REQUESTS.length >= MAX_ORACLE_QUEUE_SIZE) {
    return res.status(429).json({ error: 'Oracle request queue full. Please retry later.' });
  }

  const request = {
    wallet_id,
    plan_id: plan_id || null,
    recipient_index: parseInt(recipient_index, 10),
    decision,
    // The oracle workflow expects an evidence_hash. We'll generate a dummy one for the demo.
    evidence_hash: crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex'),
    requested_at: Date.now(),
  };

  PENDING_ORACLE_REQUESTS.push(request);
  console.log(`[trigger/oracle] Queued attestation request: ${wallet_id}/${request.recipient_index} plan=${request.plan_id || 'legacy'}`);

  res.status(202).json({ message: 'Oracle attestation requested.', request });
});


/**
 * GET /api/oracle/pending
 * Returns pending requests for the Chainlink oracle (CRE) workflow.
 */
oraclePendingRouter.get('/pending', oracleKeyGuard, (_req, res) => {
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

  console.log(`[trigger/oracle] Dequeued attestation request for CRE: ${request.wallet_id}/${request.recipient_index} plan=${request.plan_id || 'legacy'}`);
  // The oracle workflow expects an array of requests.
  return res.json({ requests: [request] });
});

module.exports = router;
module.exports.oraclePendingRouter = oraclePendingRouter;
module.exports._pendingOracleRequests = PENDING_ORACLE_REQUESTS;
