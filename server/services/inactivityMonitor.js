/**
 * Background service: detect inactivity for activity_drand wallets
 * and queue Oracle attestation requests.
 *
 * Flow:
 *   1. Wallet owner configures trigger_type='activity_drand' with tlock_duration_months
 *   2. This monitor checks periodically (every 60s) whether the inactivity threshold is reached
 *   3. When threshold exceeded and no active trigger exists:
 *      → Queue Oracle attestation request (same queue as /api/oracle/request-attestation)
 *      → Oracle (Chainlink CRE) independently verifies on-chain inactivity
 *      → Standard oracle flow: attestation → trigger → cooldown → finalization → delivery
 *
 * Design decisions:
 *   - In-memory Set tracks already-queued wallets to avoid duplicate submissions (cleared periodically)
 *   - Uses db.recipientPaths.findAll() — acceptable for current scale; optimize with index if needed
 *   - Only queues to Oracle; does NOT create triggers directly (Oracle is the trust anchor for automated triggers)
 */

'use strict';

const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

let _monitorTimer = null;
let _clearTimer = null;

// Track already-queued wallet+recipient combos to avoid re-queuing every cycle
const _queuedKeys = new Set();
const QUEUE_KEY_MAX_SIZE = 10000;
const QUEUE_KEY_CLEAR_INTERVAL_MS = 30 * 60 * 1000; // Clear set every 30 minutes

// Months → milliseconds (approximate: 30 days/month)
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Check all activity_drand wallet configs for inactivity threshold breach.
 * For each breached wallet, queue an Oracle attestation request if no active trigger exists.
 */
async function checkInactivity() {
  try {
    const oracleEnabled =
      config.oracle &&
      config.oracle.enabled &&
      config.oracle.releaseAttestationAddress;

    if (!oracleEnabled) {
      // Oracle not configured — cannot queue attestation requests
      return;
    }

    const allConfigs = await db.recipientPaths.findAll();
    const now = Date.now();

    for (const pathConfig of allConfigs) {
      if (pathConfig.trigger_type !== 'activity_drand') continue;
      if (!pathConfig.tlock_duration_months || !pathConfig.wallet_id) continue;

      const thresholdMs = pathConfig.tlock_duration_months * MONTH_MS;
      // Use last_activity_at (last on-chain interaction) if available, falling back to created_at.
      const lastActivity = pathConfig.last_activity_at || pathConfig.created_at || 0;

      // Check if inactivity threshold has been reached since last activity
      if (now - lastActivity < thresholdMs) continue;

      const walletId = String(pathConfig.wallet_id).trim();
      if (!walletId) continue;

      // Process each recipient path
      const paths = Array.isArray(pathConfig.paths) ? pathConfig.paths : [];
      for (const path of paths) {
        const recipientIndex = path.index;
        if (!Number.isInteger(recipientIndex) || recipientIndex < 1) continue;

        const queueKey = `${walletId}_${recipientIndex}`;

        // Skip if already queued this cycle
        if (_queuedKeys.has(queueKey)) continue;

        // Check for existing active trigger (pending, cooldown, or released)
        try {
          const existingTriggers = await db.triggers.findByWallet(walletId);
          const hasActive = existingTriggers?.some(
            (t) =>
              Number(t.recipient_index) === recipientIndex &&
              (t.status === 'pending' || t.status === 'cooldown' || t.status === 'released')
          );
          if (hasActive) {
            _queuedKeys.add(queueKey); // Don't re-check until set clears
            continue;
          }
        } catch (lookupErr) {
          console.warn('[inactivity-monitor] Trigger lookup failed for %s/%s: %s', walletId, recipientIndex, lookupErr.message);
          continue;
        }

        // Queue Oracle attestation request
        try {
          const evidenceHash = crypto.createHash('sha256')
            .update(`inactivity-${walletId}-${recipientIndex}-${now}`)
            .digest('hex');

          // Store the request in the audit log for traceability
          await db.auditLog.create(`inactivity_${walletId}_${recipientIndex}_${now}`, {
            type: 'INACTIVITY_THRESHOLD_REACHED',
            wallet_id: walletId,
            recipient_index: recipientIndex,
            trigger_type: 'activity_drand',
            tlock_duration_months: pathConfig.tlock_duration_months,
            last_activity: lastActivity,
            threshold_ms: thresholdMs,
            detected_at: now,
            evidence_hash: evidenceHash,
          });

          // Direct queue push — avoids fragile self-HTTP loopback
          const oracleModule = require('../api/trigger/oracle');
          const pendingQueue = oracleModule._pendingOracleRequests;
          if (pendingQueue && pendingQueue.length < 1000) {
            pendingQueue.push({
              wallet_id: walletId,
              recipient_index: recipientIndex,
              decision: 'release',
              evidence_hash: evidenceHash,
              requested_at: now,
            });
          } else {
            console.warn('[inactivity-monitor] Oracle queue full or unavailable, skipping %s/%s', walletId, recipientIndex);
            continue;
          }

          _queuedKeys.add(queueKey);
          console.log('[inactivity-monitor] Oracle attestation queued: wallet=%s recipient=%s (inactivity %d months exceeded)',
            walletId, recipientIndex, pathConfig.tlock_duration_months);
        } catch (queueErr) {
          console.error('[inactivity-monitor] Failed to queue Oracle request for %s/%s: %s',
            walletId, recipientIndex, queueErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[inactivity-monitor] Error:', err.message);
  }
}

/**
 * Start the background inactivity monitor.
 * Runs checkInactivity() at the configured interval (default 60s).
 */
function startInactivityMonitor() {
  if (_monitorTimer) return;

  const inactivityConfig = config.inactivity || {};
  if (inactivityConfig.enabled === false) {
    console.log('[inactivity-monitor] Disabled by config (INACTIVITY_MONITOR_ENABLED=false)');
    return;
  }

  const intervalMs = inactivityConfig.checkIntervalMs || 60000;

  _monitorTimer = setInterval(checkInactivity, intervalMs);
  if (_monitorTimer.unref) _monitorTimer.unref();

  // Periodically clear the queued-keys set to allow re-checking
  _clearTimer = setInterval(() => {
    if (_queuedKeys.size > 0) {
      console.log('[inactivity-monitor] Clearing queued-keys set (%d entries)', _queuedKeys.size);
      _queuedKeys.clear();
    }
  }, QUEUE_KEY_CLEAR_INTERVAL_MS);
  if (_clearTimer.unref) _clearTimer.unref();

  console.log('[inactivity-monitor] Started (interval=%dms)', intervalMs);
}

/**
 * Stop the inactivity monitor (for testing / graceful shutdown).
 */
function stopInactivityMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
  if (_clearTimer) {
    clearInterval(_clearTimer);
    _clearTimer = null;
  }
}

module.exports = {
  checkInactivity,
  startInactivityMonitor,
  stopInactivityMonitor,
};
