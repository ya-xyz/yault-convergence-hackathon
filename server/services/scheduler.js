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
      const cooldownTriggers = allTriggers.filter(
        (t) => t.status === 'cooldown' && t.effective_at && t.effective_at <= now
      );
      let finalizedCount = 0;
      for (const trigger of cooldownTriggers) {
        try {
          const decisionRouter = require('../api/trigger/decision');
          if (typeof decisionRouter._maybeFinalizeDecision === 'function') {
            const updated = await decisionRouter._maybeFinalizeDecision(trigger.trigger_id, trigger);
            if (updated && updated.status === 'released') finalizedCount++;
          }
        } catch (tErr) {
          console.error(`[scheduler] Finalize trigger ${trigger.trigger_id} error:`, tErr.message);
        }
      }
      if (finalizedCount > 0) {
        console.log(`[scheduler] Finalized ${finalizedCount} cooldown trigger(s) → released`);
      }
    } catch (tErr) {
      console.error('[scheduler] Trigger finalization error:', tErr.message);
    }

    // ── Retry failed RWA deliveries ──
    try {
      const pendingDeliveries = await db.rwaDeliveryLog.findAll();
      const retryable = pendingDeliveries.filter(
        (d) => (d.status === 'failed' || d.status === 'pending') && (d.attempts || 0) < 5
      );
      if (retryable.length > 0) {
        let retrySucceeded = 0;
        let retryFailed = 0;
        for (const delivery of retryable) {
          try {
            const { deliverRwaPackageForRecipient } = require('./deliverRwaRelease');
            // Normalize: try both with and without 0x prefix
            const dwid = delivery.wallet_id;
            const dwidAlt = dwid.startsWith('0x') ? dwid.slice(2) : `0x${dwid}`;
            const walletBindings = [...(await db.bindings.findByWallet(dwid)), ...(await db.bindings.findByWallet(dwidAlt))];
            const binding = walletBindings.find(
              (b) => b.authority_id === delivery.authority_id && b.status === 'active'
            );
            if (binding) {
              const result = await deliverRwaPackageForRecipient(binding, delivery.recipient_index);
              if (result && result.delivered) {
                retrySucceeded++;
              } else {
                retryFailed++;
                if (result && result.error) {
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
        console.log(`[scheduler] Retried ${retryable.length} RWA deliveries: ${retrySucceeded} succeeded, ${retryFailed} failed`);
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
