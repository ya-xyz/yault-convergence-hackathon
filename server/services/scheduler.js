/**
 * scheduler.js — Recurring Allowance Scheduler
 *
 * Periodically checks for recurring allowances whose next_execution has passed,
 * executes them (creates a new allowance record for the period), and advances
 * next_execution to the next interval.
 *
 * Frequencies:
 *   - daily:   every 24 hours
 *   - weekly:  every 7 days
 *   - monthly: every ~30 days (calendar month)
 *
 * In production, the "execution" step would trigger an on-chain transfer.
 * For now, it records the transfer in the allowances table and audit log.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { checkLimit } = require('./withdrawalLimits');

/** Default poll interval: 60 seconds */
const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_MS, 10) || 60 * 1000;

/** Interval handle */
let _timer = null;

/** Guard against concurrent tick execution */
let _processing = false;

/** Frequency → milliseconds offset */
const FREQUENCY_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Advance next_execution to the next interval.
 * For monthly, we use calendar-month advancement for accuracy.
 */
function advanceNextExecution(currentNext, frequency) {
  if (frequency === 'monthly') {
    const d = new Date(currentNext);
    d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }
  return currentNext + (FREQUENCY_MS[frequency] || FREQUENCY_MS.monthly);
}

/**
 * Process all due recurring allowances.
 * Called on each tick of the scheduler.
 */
async function processDueAllowances() {
  if (_processing) return; // previous tick still running
  _processing = true;
  try {
    const now = Date.now();
    const allAllowances = await db.allowances.findAll();

    // Find recurring allowances that are due
    const due = allAllowances.filter((a) =>
      a.type === 'recurring' &&
      a.status !== 'cancelled' &&
      a.recurring_config &&
      a.recurring_config.next_execution <= now &&
      (a.recurring_config.end_date === null || a.recurring_config.end_date > now)
    );

    for (const allowance of due) {
      try {
        // Verify the sub-account relationship still exists and is active
        const members = await db.subAccounts.findByParent(allowance.from_wallet_id);
        const member = members.find(
          (m) => m.member_wallet_id === allowance.to_wallet_id && m.status === 'active'
        );

        if (!member) {
          // Relationship removed or suspended — skip but don't cancel
          // (parent might reactivate later)
          console.log(`[scheduler] Skipping allowance ${allowance.allowance_id}: member inactive or removed`);
          continue;
        }

        // Check withdrawal limit via shared utility
        const limitCheck = await checkLimit(allowance.to_wallet_id, Number(allowance.amount));
        if (!limitCheck.allowed) {
          console.log(
            `[scheduler] Skipping allowance ${allowance.allowance_id}:` +
            ` would exceed ${limitCheck.period} limit (used ${limitCheck.used}/${limitCheck.limit})`
          );
          continue;
        }

        // Execute vault-level share transfer (reserve → sub-account)
        // In production this calls the ERC-20 transfer() on vault shares.
        // The stub vault API handles balance tracking in-memory.
        let vaultTransferOk = false;
        try {
          const vault = require('../api/vault');
          const fromPos = await vault._getPosition(allowance.from_wallet_id);

          if ((fromPos.deposited || 0) >= Number(allowance.amount)) {
            const amt = Number(allowance.amount);
            const shareRatio = (fromPos.shares || 0) > 0 ? amt / fromPos.deposited : 0;
            const sharesToMove = (fromPos.shares || 0) * shareRatio;

            fromPos.shares = (fromPos.shares || 0) - sharesToMove;
            fromPos.deposited = (fromPos.deposited || 0) - amt;
            await vault._setPosition(allowance.from_wallet_id, fromPos);

            const toPos = await vault._getPosition(allowance.to_wallet_id);
            toPos.shares = (toPos.shares || 0) + sharesToMove;
            toPos.deposited = (toPos.deposited || 0) + amt;
            await vault._setPosition(allowance.to_wallet_id, toPos);

            vaultTransferOk = true;
          } else {
            console.log(`[scheduler] Insufficient vault balance for ${allowance.allowance_id}: has ${fromPos.deposited || 0}, needs ${allowance.amount}`);
          }
        } catch (vaultErr) {
          console.error(`[scheduler] Vault transfer error for ${allowance.allowance_id}:`, vaultErr.message);
        }

        // Create a new execution record for this period
        const executionId = crypto.randomBytes(16).toString('hex');
        await db.allowances.create(executionId, {
          allowance_id: executionId,
          parent_allowance_id: allowance.allowance_id,
          from_wallet_id: allowance.from_wallet_id,
          to_wallet_id: allowance.to_wallet_id,
          amount: allowance.amount,
          currency: allowance.currency,
          type: 'recurring_execution',
          memo: allowance.memo ? `[Auto] ${allowance.memo}` : '[Auto] Recurring transfer',
          status: vaultTransferOk ? 'completed' : 'pending',
          vault_transfer: vaultTransferOk,
          created_at: now,
        });

        // Advance next_execution on the parent recurring allowance
        const nextExec = advanceNextExecution(
          allowance.recurring_config.next_execution,
          allowance.recurring_config.frequency
        );

        await db.allowances.update(allowance.allowance_id, {
          ...allowance,
          recurring_config: {
            ...allowance.recurring_config,
            next_execution: nextExec,
            last_executed: now,
          },
        });

        // Audit log
        await db.auditLog.create(crypto.randomBytes(8).toString('hex'), {
          type: 'recurring_allowance_executed',
          allowance_id: allowance.allowance_id,
          execution_id: executionId,
          from_wallet_id: allowance.from_wallet_id,
          to_wallet_id: allowance.to_wallet_id,
          amount: allowance.amount,
          currency: allowance.currency,
          frequency: allowance.recurring_config.frequency,
          next_execution: nextExec,
          vault_transfer: vaultTransferOk,
          source: 'vault_reserve',
          timestamp: now,
        });

        console.log(
          `[scheduler] Executed recurring allowance ${allowance.allowance_id}:` +
          ` ${allowance.amount} ${allowance.currency} → ${allowance.to_wallet_id.substring(0, 12)}...` +
          ` | next: ${new Date(nextExec).toISOString()}`
        );
      } catch (err) {
        console.error(`[scheduler] Error processing allowance ${allowance.allowance_id}:`, err.message);
      }
    }

    if (due.length > 0) {
      console.log(`[scheduler] Processed ${due.length} due recurring allowance(s)`);
    }

    // ── Finalize cooldown triggers ──
    try {
      const allTriggers = await db.triggers.findAll();

      // Retry attestation_blocked triggers: reset to cooldown so they can be re-evaluated.
      // This handles the case where attestation was expired/missing at first check but has
      // since been refreshed (e.g. simulate-chainlink re-submitted a fresh attestation).
      // Limit retries: don't infinitely reset — max 3 automatic resets, then leave blocked.
      const MAX_BLOCKED_RESETS = 3;
      const blockedTriggers = allTriggers.filter(
        (t) => t.status === 'attestation_blocked' && t.effective_at && t.effective_at <= now &&
               (t.blocked_reset_count || 0) < MAX_BLOCKED_RESETS
      );
      for (const trigger of blockedTriggers) {
        try {
          trigger.status = 'cooldown';
          trigger.blocked_reset_count = (trigger.blocked_reset_count || 0) + 1;
          trigger.blocked_reason_code = null;
          trigger.blocked_reason_detail = null;
          trigger.blocked_at = null;
          // Add a 2-minute delay before next retry (exponential backoff)
          trigger.effective_at = now + trigger.blocked_reset_count * 120000;
          await db.triggers.update(trigger.trigger_id, trigger);
          console.log(`[scheduler] Reset attestation_blocked trigger ${trigger.trigger_id} → cooldown for retry (attempt ${trigger.blocked_reset_count}/${MAX_BLOCKED_RESETS})`);
        } catch (rErr) {
          console.error(`[scheduler] Reset blocked trigger ${trigger.trigger_id} error:`, rErr.message);
        }
      }

      // NOTE: Cooldown trigger finalization is handled by the dedicated cooldown-finalizer
      // in pending.js (runs every 30s). Removed from scheduler to prevent duplicate
      // finalization causing duplicate NFT deliveries.
    } catch (tErr) {
      console.error('[scheduler] Trigger finalization error:', tErr.message);
    }

    // ── Retry failed RWA deliveries ──
    try {
      let pendingDeliveries = await db.rwaDeliveryLog.findAll();
      // Reset entries that failed due to now-handled errors
      // (e.g. Merkle tree unavailable, Arweave fetch, or Bubblegum tree mint capacity increased).
      let didReset = false;
      for (const d of pendingDeliveries) {
        if (
          d.status === 'failed' &&
          (d.attempts || 0) >= 5 &&
          /[Mm]erkle tree|fetch manifest|fetch payload|InsufficientMintCapacity|not enough unapproved mints left|Error Number:\s*6017/i.test(d.error || '')
        ) {
          const dPlanId = d.plan_id || null;
          const resetId = dPlanId
            ? `${String(d.wallet_id).trim().toLowerCase()}_${String(d.authority_id).trim()}_${d.recipient_index}_${dPlanId}`
            : `${String(d.wallet_id).trim().toLowerCase()}_${String(d.authority_id).trim()}_${d.recipient_index}`;
          await db.rwaDeliveryLog.create(resetId, { ...d, status: 'pending', attempts: 0, updated_at: Date.now() }).catch(() => {});
          console.log(`[scheduler] Reset failed delivery ${resetId} for retry (was: ${d.error})`);
          didReset = true;
        }
      }
      if (didReset) pendingDeliveries = await db.rwaDeliveryLog.findAll();
      const retryable = pendingDeliveries.filter(
        (d) => (d.status === 'failed' || d.status === 'pending') && (d.attempts || 0) < 5
      );
      // Skip entries that were recently rate-limited (wait at least 5 minutes)
      const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
      const retryNow = retryable.filter((d) => {
        if (/rate.?limit|Too many requests/i.test(d.error || '')) {
          return (d.updated_at || 0) + RATE_LIMIT_COOLDOWN_MS < now;
        }
        return true;
      });
      if (retryNow.length > 0) {
        let retrySucceeded = 0;
        let retryFailed = 0;
        let rateLimited = false;
        for (const delivery of retryNow) {
          // If a previous delivery in this batch was rate-limited, stop retrying this tick
          if (rateLimited) break;
          try {
            const { deliverRwaPackageForRecipient } = require('./deliverRwaRelease');
            // Normalize: try both with and without 0x prefix
            const dwid = delivery.wallet_id;
            const dwidAlt = dwid.startsWith('0x') ? dwid.slice(2) : `0x${dwid}`;
            const deliveryPlanId = delivery.plan_id || null;
            if (!deliveryPlanId) continue;
            const walletBindings = [...(await db.bindings.findByWallet(dwid)), ...(await db.bindings.findByWallet(dwidAlt))];
            const binding = walletBindings.find(
              (b) => b.authority_id === delivery.authority_id && b.status === 'active' &&
                     b.plan_id === deliveryPlanId
            );
            if (binding) {
              const result = await deliverRwaPackageForRecipient(binding, delivery.recipient_index);
              if (result && result.delivered) {
                retrySucceeded++;
              } else {
                retryFailed++;
                if (result && result.rateLimited) {
                  rateLimited = true;
                  console.warn(`[scheduler] Mint API rate limited — stopping delivery retries for this tick`);
                } else if (result && result.error) {
                  console.warn(
                    `[scheduler] RWA delivery retry failed for ${delivery.wallet_id}/${delivery.recipient_index}: ${result.error}`
                  );
                }
              }
            } else {
              retryFailed++;
              console.warn(
                `[scheduler] RWA delivery retry skipped for ${delivery.wallet_id}/${delivery.recipient_index}: no active binding`
              );
            }
          } catch (dErr) {
            retryFailed++;
            console.error(`[scheduler] RWA delivery retry error for ${delivery.wallet_id}/${delivery.recipient_index}:`, dErr.message);
          }
        }
        if (retryNow.length > 0) {
          console.log(`[scheduler] Retried ${retrySucceeded + retryFailed} RWA deliveries: ${retrySucceeded} succeeded, ${retryFailed} failed${rateLimited ? ' (stopped: rate limited)' : ''}`);
        }
      }
    } catch (dErr) {
      console.error('[scheduler] RWA retry error:', dErr.message);
    }

  } catch (err) {
    console.error('[scheduler] Tick error:', err.message);
  } finally {
    _processing = false;
  }
}

/**
 * Start the recurring allowance scheduler.
 * Idempotent — calling multiple times is safe.
 */
function start() {
  if (_timer) return;
  console.log(`[scheduler] Starting scheduler (allowances + triggers + RWA delivery retry, poll every ${POLL_INTERVAL_MS / 1000}s)`);

  // Run immediately on start, then on interval
  processDueAllowances();
  _timer = setInterval(processDueAllowances, POLL_INTERVAL_MS);
  if (_timer.unref) _timer.unref(); // don't block process exit
}

/**
 * Stop the scheduler.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[scheduler] Stopped');
  }
}

module.exports = { start, stop, processDueAllowances };
