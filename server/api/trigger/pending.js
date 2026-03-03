/**
 * GET /api/trigger/pending
 *
 * List pending trigger events for an authenticated authority.
 *
 * C-07 FIX: Cooldown finalization is now handled by a background scheduler
 * instead of lazily in GET requests. This ensures cooldowns finalize even
 * if nobody queries the endpoint.
 *
 * Query params:
 *   status    - Filter by status (default: "pending", supports "cooldown", "all", etc.)
 *   limit     - Max results (default 50, max 200)
 *   offset    - Pagination offset (default 0)
 *
 * Returns: { triggers: TriggerEvent[], total: number }
 */

'use strict';

const { Router } = require('express');
const { dualAuthMiddleware, authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');
const { isReleasePaused } = require('../../services/triggerPolicy');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

// ─── C-07 FIX: Background Cooldown Finalizer ───
// Runs every 30 seconds to finalize expired cooldowns independently of API calls.

let _cooldownTimer = null;

async function finalizeCooldowns() {
  try {
    if (isReleasePaused()) return;
    const now = Date.now();
    const allTriggers = await db.triggers.findAll();
    const decisionRouter = require('../trigger/decision');
    const maybeFinalize = decisionRouter._maybeFinalizeDecision;
    if (typeof maybeFinalize !== 'function') return;
    for (const trigger of allTriggers) {
      if (trigger.status === 'cooldown' && trigger.effective_at && now >= trigger.effective_at) {
        try {
          const updated = await maybeFinalize(trigger.trigger_id, trigger);
          if (updated && updated.status === 'released') {
            console.log(`[cooldown-finalizer] Trigger ${trigger.trigger_id} finalized → released`);
          }
        } catch (err) {
          console.error('[cooldown-finalizer] Trigger', trigger.trigger_id, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[cooldown-finalizer] Error:', err.message);
  }
}

function startCooldownFinalizer() {
  if (_cooldownTimer) return;
  _cooldownTimer = setInterval(finalizeCooldowns, 30_000);
  if (_cooldownTimer.unref) _cooldownTimer.unref();
}

// Start the background finalizer on module load
startCooldownFinalizer();

// Start the inactivity monitor for activity_drand wallets (queues Oracle requests when threshold exceeded)
const { startInactivityMonitor } = require('../../services/inactivityMonitor');
startInactivityMonitor();

/**
 * @route GET /
 * @description List pending trigger events.
 *   - Client-portal: pass wallet_id, auth via X-Client-Session.
 *   - Authority: no wallet_id, auth via X-Authority-Session or challenge.
 */
router.get('/', (req, res, next) => {
  if (req.headers['x-authority-session']) return authorityAuthMiddleware(req, res, next);
  return dualAuthMiddleware(req, res, next);
}, async (req, res) => {
  try {
    const statusFilter = req.query.status || 'pending';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let triggers;

    // Client-portal queries by wallet_id — must be owner (IDOR fix)
    if (req.query.wallet_id) {
      if (normalizeAddr(req.auth?.pubkey) !== normalizeAddr(req.query.wallet_id)) {
        return res.status(403).json({
          error: 'Forbidden',
          detail: 'You can only list triggers for your own wallet',
        });
      }
      triggers = await db.triggers.findByWallet(req.query.wallet_id);
    } else {
      // Authority queries by their authenticated authority_id
      const authorityId = req.auth.authority_id;
      if (!authorityId) {
        return res.status(400).json({
          error: 'Missing identifier',
          detail: 'Authenticated user has no associated authority_id',
        });
      }

      // Verify authority exists
      const authority = await db.authorities.findById(authorityId);
      if (!authority) {
        return res.status(404).json({
          error: 'Not found',
          detail: 'Authority not found',
        });
      }

      triggers = await db.triggers.findByAuthority(authorityId);
    }

    const now = Date.now();

    // Apply status filter
    if (statusFilter !== 'all') {
      triggers = triggers.filter((t) => t.status === statusFilter);
    }

    // Sort by triggered_at descending (most recent first)
    triggers.sort((a, b) => (b.triggered_at || 0) - (a.triggered_at || 0));

    const total = triggers.length;
    const page = triggers.slice(offset, offset + limit).map((t) => {
      const entry = {
        trigger_id: t.trigger_id,
        wallet_id: t.wallet_id,
        recipient_index: t.recipient_index,
        tlock_round: t.tlock_round,
        arweave_tx_id: t.arweave_tx_id,
        status: t.status,
        triggered_at: t.triggered_at,
        decided_at: t.decided_at,
        decision: t.decision,
        matter_id: t.decision_matter_id || null,
        reason_code: t.decision_reason_code || null,
      };

      // Include cooldown info if applicable
      if (t.status === 'cooldown') {
        entry.effective_at = t.effective_at;
        entry.cooldown_remaining_ms = Math.max(0, (t.effective_at || 0) - now);
        entry.can_cancel = now < (t.effective_at || 0);
      }
      if (t.status === 'attestation_blocked') {
        entry.blocked_at = t.blocked_at || null;
        entry.blocked_reason_code = t.blocked_reason_code || null;
        entry.blocked_reason_detail = t.blocked_reason_detail || null;
      }
      if (t.status === 'aborted') {
        entry.aborted_at = t.aborted_at || null;
        entry.aborted_by = t.aborted_by || null;
        entry.aborted_reason = t.aborted_reason || null;
        entry.remaining_cooldown_ms = typeof t.remaining_cooldown_ms === 'number' ? t.remaining_cooldown_ms : null;
      }

      // Include audit reference if finalized
      if (t.arweave_audit_tx) {
        entry.arweave_audit_tx = t.arweave_audit_tx;
      }

      return entry;
    });

    return res.json({ triggers: page, total, limit, offset });
  } catch (err) {
    console.error('[trigger/pending] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports._finalizeCooldowns = finalizeCooldowns;
