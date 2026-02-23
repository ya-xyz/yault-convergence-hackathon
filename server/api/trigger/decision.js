/**
 * POST /api/trigger/:id/decision
 * POST /api/trigger/:id/cancel
 *
 * Authority submits a release/hold/reject decision for a trigger event.
 * The decision is signed with the authority's Ed25519 key for auditability.
 *
 * Release decisions enter a cooldown period (default 24h) before taking effect.
 * During the cooldown, the decision can be cancelled via POST /:id/cancel.
 * After cooldown expires, the decision is finalized and an immutable audit
 * record is uploaded to Arweave.
 *
 * Params: :id - trigger_id
 *
 * Decision body:
 *   { decision, reason?, reason_code?, evidence_hash, signature, matter_id?, cooldown_hours? }
 *
 * Cancel body:
 *   { reason, signature }
 *
 * Returns: { trigger_id, decision, status, effective_at?, cooldown_remaining_ms? }
 */

'use strict';

const { Router } = require('express');
const { ReleaseDecision } = require('../../models/schemas');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');
const config = require('../../config');
const { evaluateReleaseAttestationGate } = require('../../services/attestationGate');
const { deliverRwaPackageForRecipient } = require('../../services/deliverRwaRelease');

const router = Router();

// #5 FIX: Cancel cooldown period — prevents cancel+resubmit bypass
const CANCEL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour after cancellation

// H-05 FIX: Retry helper for Arweave audit uploads
async function retryArweaveUpload(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[arweave-audit] Attempt ${attempt}/${maxRetries} failed:`, err.message);
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // exponential backoff: 2s, 4s, 8s
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('[arweave-audit] All retry attempts exhausted. Audit record NOT persisted.');
        // Store failed audit locally for manual retry
        try {
          const db = require('../../db');
          await db.auditLog.create(`failed_${Date.now()}`, {
            type: 'arweave_upload_failed',
            payload: JSON.stringify(fn.toString().slice(0, 200)),
            failed_at: Date.now(),
            error: err.message,
          });
        } catch (logErr) { console.warn('[arweave-audit] Failed to log failed upload:', logErr.message); }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Arweave audit upload + persistence
// ---------------------------------------------------------------------------

/**
 * Load Arweave JWK from env. Supports:
 * - ARWEAVE_WALLET_JWK = file path (absolute or relative) → read from disk.
 * - ARWEAVE_WALLET_JWK = JSON string (starts with '{') → parse directly (no path logged).
 * Never logs path or key material.
 *
 * @returns {Promise<object|null>} JWK object or null
 */
async function loadArweaveWallet() {
  const raw = process.env.ARWEAVE_WALLET_JWK;
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (parseErr) {
      console.warn('[audit] Failed to parse ARWEAVE_WALLET_JWK as JSON:', parseErr.message);
      return null;
    }
  }
  try {
    const { readFile } = require('fs').promises;
    return JSON.parse(await readFile(trimmed, 'utf-8'));
  } catch (fileErr) {
    console.warn('[audit] Failed to load Arweave wallet from file:', fileErr.message);
    return null;
  }
}

/**
 * Upload an immutable audit record to Arweave for a release decision.
 *
 * @param {object} auditPayload
 * @returns {Promise<string|null>} Arweave tx ID, or null on failure
 */
async function uploadAuditToArweave(auditPayload) {
  try {
    const wallet = await loadArweaveWallet();
    if (!wallet) {
      console.warn('[audit] ARWEAVE_WALLET_JWK not set or invalid, skipping Arweave audit upload');
      return null;
    }

    // Dynamic import so Arweave dependency is optional
    const Arweave = require('arweave');

    const arweave = Arweave.init({
      host: (config.arweave.gateway || 'https://arweave.net').replace('https://', ''),
      port: 443,
      protocol: 'https',
    });

    const dataStr = JSON.stringify(auditPayload);
    const tx = await arweave.createTransaction({ data: dataStr }, wallet);

    tx.addTag('Content-Type', 'application/json');
    tx.addTag('App-Name', config.arweave.appName || 'Yault');
    tx.addTag('Type', 'YALLET_DECISION_AUDIT');
    tx.addTag('Trigger-Id', auditPayload.trigger_id);
    tx.addTag('Wallet-Id', auditPayload.wallet_id);
    tx.addTag('Authority-Id', auditPayload.authority_id);
    tx.addTag('Decision', auditPayload.decision);
    tx.addTag('Reason-Code', auditPayload.reason_code || 'other');
    if (auditPayload.matter_id) {
      tx.addTag('Matter-Id', auditPayload.matter_id);
    }

    await arweave.transactions.sign(tx, wallet);
    const response = await arweave.transactions.post(tx);

    if (response.status === 200 || response.status === 202) {
      console.log(`[audit] Arweave audit uploaded: ${tx.id}`);
      return tx.id;
    } else {
      console.error(`[audit] Arweave upload failed: status ${response.status}`);
      return null;
    }
  } catch (err) {
    console.error('[audit] Arweave audit upload failed:', err.message);
    return null;
  }
}

/**
 * Persist decision audit metadata to trigger row + local audit log.
 * This helper is awaited by callers to avoid dangling async work after request completion.
 *
 * @param {string} triggerId
 * @param {object} triggerSnapshot
 * @param {object} auditPayload
 * @param {string} errorPrefix
 * @returns {Promise<string|null>} Arweave tx id (if uploaded), else null
 */
async function persistDecisionAudit(triggerId, triggerSnapshot, auditPayload, errorPrefix) {
  try {
    const txId = await retryArweaveUpload(() => uploadAuditToArweave(auditPayload));
    if (txId) {
      await db.triggers.update(triggerId, {
        ...triggerSnapshot,
        arweave_audit_tx: txId,
      });
    }
    await db.auditLog.create(`audit_${triggerId}`, {
      ...auditPayload,
      arweave_audit_tx: txId || null,
    });
    return txId || null;
  } catch (err) {
    console.error(errorPrefix, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cooldown finalizer: check if pending decisions have become effective
// ---------------------------------------------------------------------------

/**
 * Finalize a trigger whose cooldown period has expired.
 * Called lazily (on read) or can be run periodically.
 *
 * @param {string} triggerId
 * @param {object} trigger
 * @returns {Promise<object|null>} Updated trigger, or null if not yet effective
 */
async function maybeFinalizeDecision(triggerId, trigger) {
  if (trigger.status !== 'cooldown') return trigger;

  const now = Date.now();
  if (now < trigger.effective_at) {
    // Still in cooldown
    return trigger;
  }

  // Cooldown expired → finalize
  const finalizedTrigger = {
    ...trigger,
    status: trigger.decision === 'release' ? 'released' : trigger.decision,
    finalized_at: now,
  };

  await db.triggers.update(triggerId, finalizedTrigger);

  // When finalized as 'release', deliver stored RWA credential NFT (if binding has RWA packages).
  if (trigger.decision === 'release' && trigger.recipient_index != null) {
    try {
      // Normalize: try both with and without 0x prefix (trigger stores without, binding may store with)
      const wid = trigger.wallet_id;
      const widAlt = wid.startsWith('0x') ? wid.slice(2) : `0x${wid}`;
      const bindings = [...(await db.bindings.findByWallet(wid)), ...(await db.bindings.findByWallet(widAlt))];
      const activeBinding = bindings.find(
        (b) =>
          b.authority_id === trigger.authority_id &&
          b.status === 'active' &&
          Array.isArray(b.recipient_indices) &&
          b.recipient_indices.some((idx) => Number(idx) === Number(trigger.recipient_index)) &&
          (b.manifest_arweave_tx_id || (Array.isArray(b.encrypted_packages) && b.encrypted_packages.some(p => p.rwa_upload_body)))
      );
      if (activeBinding) {
        const delivery = await deliverRwaPackageForRecipient(activeBinding, trigger.recipient_index);
        if (delivery.delivered) {
          console.log('[trigger/decision] RWA NFT delivered on finalization: wallet=%s recipient=%s txId=%s', trigger.wallet_id, trigger.recipient_index, delivery.txId);
        } else if (delivery.error) {
          console.warn('[trigger/decision] RWA delivery failed on finalization: wallet=%s recipient=%s: %s', trigger.wallet_id, trigger.recipient_index, delivery.error);
        }
      }
    } catch (deliveryErr) {
      console.warn('[trigger/decision] Non-fatal: RWA delivery on finalization failed:', deliveryErr.message);
    }
  }

  // Upload audit record to Arweave + persist local references.
  const auditPayload = {
    version: 1,
    trigger_id: triggerId,
    wallet_id: trigger.wallet_id,
    authority_id: trigger.authority_id,
    recipient_index: trigger.recipient_index,
    decision: trigger.decision,
    reason: trigger.decision_reason,
    reason_code: trigger.decision_reason_code,
    matter_id: trigger.decision_matter_id,
    evidence_hash: trigger.decision_evidence_hash,
    signature: trigger.decision_signature,
    decided_by: trigger.decided_by,
    decided_at: trigger.decided_at,
    effective_at: trigger.effective_at,
    finalized_at: now,
  };

  await persistDecisionAudit(
    triggerId,
    finalizedTrigger,
    auditPayload,
    '[trigger/decision] Post-finalization audit failed:'
  );

  return finalizedTrigger;
}

// ---------------------------------------------------------------------------
// POST /:id/decision — Submit release/hold/reject
// ---------------------------------------------------------------------------

/**
 * @route POST /:id/decision
 * @description Submit a release/hold/reject decision for a trigger event.
 *              Release decisions enter cooldown; hold/reject are immediate.
 */
router.post('/:id/decision', authorityAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate the decision payload
    const validation = ReleaseDecision.validate(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
      });
    }

    const decisionData = validation.data;

    // Find the trigger event
    const trigger = await db.triggers.findById(id);
    if (!trigger) {
      return res.status(404).json({
        error: 'Not found',
        detail: `Trigger event with id ${id} not found`,
      });
    }

    // Verify the authenticated authority owns this trigger
    if (req.auth.authority_id !== trigger.authority_id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You are not the assigned authority for this trigger event',
      });
    }

    // Check trigger is still pending
    if (trigger.status !== 'pending') {
      return res.status(400).json({
        error: 'Invalid state',
        detail: `Trigger is already in "${trigger.status}" state`,
      });
    }

    // #5 FIX: Check cancel cooldown — prevent cancel+resubmit bypass
    if (trigger.cancel_cooldown_until && trigger.cancel_cooldown_until > Date.now()) {
      const remainingMs = trigger.cancel_cooldown_until - Date.now();
      return res.status(400).json({
        error: 'Cancel cooldown active',
        detail: `A decision was recently cancelled. Please wait ${Math.ceil(remainingMs / 60000)} minutes before submitting a new decision.`,
        cooldown_remaining_ms: remainingMs,
      });
    }

    // Determine status based on decision type and cooldown
    // Oracle gate only for triggers created from oracle; legal_event/activity_drand are not gated.
    const isOracleTrigger = trigger.trigger_type === 'oracle';
    let newStatus;
    if (decisionData.decision === 'release' && decisionData.cooldown_ms > 0) {
      if (isOracleTrigger) {
        const gate = await evaluateReleaseAttestationGate({
          walletId: trigger.wallet_id,
          recipientIndex: trigger.recipient_index,
        });
        if (!gate.valid) {
          return res.status(409).json({
            error: 'Release blocked by attestation policy',
            code: gate.code,
            detail: gate.detail,
          });
        }
      }
      // Release with cooldown → enter cooldown state
      newStatus = 'cooldown';
    } else if (decisionData.decision === 'release') {
      if (isOracleTrigger) {
        const gate = await evaluateReleaseAttestationGate({
          walletId: trigger.wallet_id,
          recipientIndex: trigger.recipient_index,
        });
        if (!gate.valid) {
          return res.status(409).json({
            error: 'Release blocked by attestation policy',
            code: gate.code,
            detail: gate.detail,
          });
        }
      }
      // Release with zero cooldown → immediate
      newStatus = 'released';
    } else {
      // hold / reject → immediate
      newStatus = decisionData.decision;
    }

    // Update the trigger with the decision
    const updatedTrigger = {
      ...trigger,
      status: newStatus,
      decision: decisionData.decision,
      decision_reason: decisionData.reason,
      decision_reason_code: decisionData.reason_code,
      decision_matter_id: decisionData.matter_id,
      decision_evidence_hash: decisionData.evidence_hash,
      decision_signature: decisionData.signature,
      cooldown_ms: decisionData.cooldown_ms,
      decided_at: decisionData.decided_at,
      effective_at: decisionData.effective_at,
      decided_by: req.auth.pubkey,
    };

    await db.triggers.update(id, updatedTrigger);

    // If release (immediate or after cooldown), deliver RWA NFT
    if (newStatus === 'released' && trigger.recipient_index != null) {
      try {
        // Normalize: try both with and without 0x prefix
        const wid = trigger.wallet_id;
        const widAlt = wid.startsWith('0x') ? wid.slice(2) : `0x${wid}`;
        const bindings = [...(await db.bindings.findByWallet(wid)), ...(await db.bindings.findByWallet(widAlt))];
        const activeBinding = bindings.find(
          (b) =>
            b.authority_id === trigger.authority_id &&
            b.status === 'active' &&
            Array.isArray(b.recipient_indices) &&
            b.recipient_indices.some((idx) => Number(idx) === Number(trigger.recipient_index)) &&
            (b.manifest_arweave_tx_id || (Array.isArray(b.encrypted_packages) && b.encrypted_packages.some(p => p.rwa_upload_body)))
        );
        if (activeBinding) {
          const delivery = await deliverRwaPackageForRecipient(activeBinding, trigger.recipient_index);
          if (delivery.delivered) {
            console.log('[trigger/decision] RWA NFT delivered (immediate release): wallet=%s recipient=%s txId=%s', trigger.wallet_id, trigger.recipient_index, delivery.txId);
          } else if (delivery.error) {
            console.warn('[trigger/decision] RWA delivery failed (immediate release): wallet=%s recipient=%s: %s', trigger.wallet_id, trigger.recipient_index, delivery.error);
          }
        }
      } catch (deliveryErr) {
        console.warn('[trigger/decision] Non-fatal: RWA delivery failed:', deliveryErr.message);
      }
    }

    // If no cooldown (immediate finalization), upload audit now
    if (newStatus !== 'cooldown') {
      const auditPayload = {
        version: 1,
        trigger_id: id,
        wallet_id: trigger.wallet_id,
        authority_id: trigger.authority_id,
        recipient_index: trigger.recipient_index,
        decision: decisionData.decision,
        reason: decisionData.reason,
        reason_code: decisionData.reason_code,
        matter_id: decisionData.matter_id,
        evidence_hash: decisionData.evidence_hash,
        signature: decisionData.signature,
        decided_by: req.auth.pubkey,
        decided_at: decisionData.decided_at,
        effective_at: decisionData.effective_at,
        finalized_at: decisionData.decided_at,
      };

      await persistDecisionAudit(
        id,
        updatedTrigger,
        auditPayload,
        '[trigger/decision] Audit log write failed:'
      );
    }

    // Build response
    const response = {
      trigger_id: id,
      decision: decisionData.decision,
      status: newStatus,
      matter_id: decisionData.matter_id,
      decided_at: decisionData.decided_at,
    };

    if (newStatus === 'cooldown') {
      response.effective_at = decisionData.effective_at;
      response.cooldown_remaining_ms = decisionData.effective_at - Date.now();
      response.cancel_before = new Date(decisionData.effective_at).toISOString();
    }

    return res.json(response);
  } catch (err) {
    console.error('[trigger/decision] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/cancel — Cancel a decision during cooldown
// ---------------------------------------------------------------------------

/**
 * @route POST /:id/cancel
 * @description Cancel a release decision while still in cooldown period.
 *              Returns the trigger to "pending" state so a new decision can be made.
 */
router.post('/:id/cancel', authorityAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const trigger = await db.triggers.findById(id);
    if (!trigger) {
      return res.status(404).json({
        error: 'Not found',
        detail: `Trigger event with id ${id} not found`,
      });
    }

    // Only the assigned authority (or admin in V2) can cancel
    if (req.auth.authority_id !== trigger.authority_id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You are not the assigned authority for this trigger event',
      });
    }

    // Can only cancel during cooldown
    if (trigger.status !== 'cooldown') {
      return res.status(400).json({
        error: 'Invalid state',
        detail: trigger.status === 'released'
          ? 'Decision has already been finalized (cooldown expired). Cannot cancel.'
          : `Trigger is in "${trigger.status}" state. Only "cooldown" state decisions can be cancelled.`,
      });
    }

    // Check cooldown hasn't already expired
    const now = Date.now();
    if (now >= trigger.effective_at) {
      // Finalize it instead
      await maybeFinalizeDecision(id, trigger);
      return res.status(400).json({
        error: 'Cooldown expired',
        detail: 'The cooldown period has already expired. Decision has been finalized.',
      });
    }

    // Cancel: revert to pending
    const cancelReason = (req.body && req.body.reason) || '';
    const cancelSignature = (req.body && req.body.signature) || '';

    const revertedTrigger = {
      ...trigger,
      status: 'pending',
      decision: null,
      decision_reason: null,
      decision_reason_code: null,
      decision_matter_id: null,
      decision_evidence_hash: null,
      decision_signature: null,
      cooldown_ms: null,
      decided_at: null,
      effective_at: null,
      decided_by: null,
      cancelled_at: now,
      cancel_reason: cancelReason,
      cancel_signature: cancelSignature,
      cancel_by: req.auth.pubkey,
      // #5 FIX: Set cancel cooldown to prevent immediate resubmit
      cancel_cooldown_until: now + CANCEL_COOLDOWN_MS,
    };

    await db.triggers.update(id, revertedTrigger);

    // Audit the cancellation (local only; Arweave audit for cancellations is optional)
    try {
      await db.auditLog.create(`cancel_${id}_${now}`, {
        version: 1,
        type: 'decision_cancelled',
        trigger_id: id,
        wallet_id: trigger.wallet_id,
        authority_id: trigger.authority_id,
        original_decision: trigger.decision,
        cancel_reason: cancelReason,
        cancel_signature: cancelSignature,
        cancelled_by: req.auth.pubkey,
        cancelled_at: now,
      });
    } catch (err) {
      console.error('[trigger/cancel] Audit log write failed:', err.message);
    }

    return res.json({
      trigger_id: id,
      status: 'pending',
      message: 'Decision cancelled. Trigger reverted to pending state.',
      cancelled_at: now,
    });
  } catch (err) {
    console.error('[trigger/cancel] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Export finalizer for use by other modules (e.g., pending.js, tlock-monitor)
// ---------------------------------------------------------------------------

router._maybeFinalizeDecision = maybeFinalizeDecision;

module.exports = router;
