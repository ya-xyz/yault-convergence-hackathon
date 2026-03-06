'use strict';
/**
 * Backfill plan_id on all existing DB records.
 *
 * Logic:
 *   1. For each walletPlan: compute deterministic plan_id = SHA256(storageKey).slice(0,32)
 *   2. Identify the "current" plan (latest WETH plan — matches active binding's [1,2] recipients)
 *   3. Patch active binding with current plan_id
 *   4. Re-key recipientPaths from SHA256(wallet_id) → SHA256(wallet_id:plan_id), set plan_id on record
 *   5. Re-key recipientPathIndex and mnemonicHashIndex with plan_id suffix
 *   6. Re-key rwaDeliveryLog entries with plan_id suffix (only for recipients in current plan)
 *   7. Replaced bindings: backfill plan_id from the plan that existed at binding creation time
 *
 * Safe to run multiple times (idempotent — skips records that already have plan_id).
 */

const crypto = require('crypto');
const db = require('../server/db');

function ensurePlanId(storageKey) {
  return crypto.createHash('sha256').update(storageKey || '').digest('hex').slice(0, 32);
}

(async () => {
  await db.ensureReady();
  let changes = 0;

  // ── Step 1: Backfill plan_id on all walletPlans ──
  console.log('\n── Step 1: walletPlans ──');
  const planIds = await db.walletPlans.findAllIds();
  const planMap = {}; // storageKey → plan_id
  for (const key of planIds) {
    const plan = await db.walletPlans.findById(key);
    if (!plan) continue;
    if (plan.plan_id) {
      console.log('  [skip] %s already has plan_id=%s', key, plan.plan_id);
      planMap[key] = plan.plan_id;
      continue;
    }
    const planId = ensurePlanId(key);
    plan.plan_id = planId;
    await db.walletPlans.update(key, plan);
    planMap[key] = planId;
    changes++;
    console.log('  [set]  %s → plan_id=%s', key, planId);
  }

  // ── Identify the current plan ──
  // The active binding has recipient_indices [1,2] → matches the latest WETH plan (2 recipients)
  // Sort by createdAt descending to find the latest
  const allPlans = [];
  for (const key of planIds) {
    const plan = await db.walletPlans.findById(key);
    if (plan) allPlans.push({ key, plan });
  }
  allPlans.sort((a, b) => {
    const ta = new Date(a.plan.createdAt || 0).getTime();
    const tb = new Date(b.plan.createdAt || 0).getTime();
    return tb - ta;
  });
  const currentPlan = allPlans[0];
  const currentPlanId = currentPlan?.plan.plan_id;
  console.log('\n  Current plan: %s (plan_id=%s, %d recipients)',
    currentPlan?.key, currentPlanId, (currentPlan?.plan.recipients || []).length);

  // ── Step 2: Patch bindings ──
  console.log('\n── Step 2: bindings ──');
  const bindings = await db.bindings.findAll();
  for (const b of bindings) {
    if (b.plan_id) {
      console.log('  [skip] binding %s already has plan_id=%s', b.binding_id, b.plan_id);
      continue;
    }
    // Active binding → current plan
    // Replaced bindings: try to match by recipient count to a historical plan
    let assignPlanId;
    if (b.status === 'active') {
      assignPlanId = currentPlanId;
    } else {
      // Replaced binding with 3 recipients → find a 3-recipient plan
      const recipCount = (b.recipient_indices || []).length;
      const match = allPlans.find(p => (p.plan.recipients || []).length === recipCount);
      assignPlanId = match ? match.plan.plan_id : currentPlanId;
    }
    b.plan_id = assignPlanId;
    await db.bindings.update(b.binding_id, b);
    changes++;
    console.log('  [set]  binding %s (status=%s) → plan_id=%s', b.binding_id, b.status, assignPlanId);
  }

  // ── Step 3: Re-key recipientPaths ──
  console.log('\n── Step 3: recipientPaths ──');
  const rpAllIds = await db.recipientPaths.findAllIds();
  for (const oldId of rpAllIds) {
    const rp = await db.recipientPaths.findById(oldId);
    if (!rp) continue;
    if (rp.plan_id) {
      console.log('  [skip] recipientPaths %s already has plan_id=%s', oldId.slice(0, 16), rp.plan_id);
      continue;
    }
    // Assign current plan_id
    rp.plan_id = currentPlanId;
    // Compute new key: SHA256(wallet_id:plan_id)
    const newStorageInput = rp.wallet_id + ':' + currentPlanId;
    const newId = crypto.createHash('sha256').update(newStorageInput).digest('hex');
    if (newId !== oldId) {
      // Create at new key, delete old key
      await db.recipientPaths.create(newId, rp);
      await db.recipientPaths.delete(oldId);
      console.log('  [rekey] %s → %s (plan_id=%s)', oldId.slice(0, 16), newId.slice(0, 16), currentPlanId);
    } else {
      await db.recipientPaths.update(oldId, rp);
      console.log('  [set]  %s → plan_id=%s', oldId.slice(0, 16), currentPlanId);
    }
    changes++;
  }

  // ── Step 4: Re-key recipientPathIndex ──
  console.log('\n── Step 4: recipientPathIndex ──');
  const rpIdxIds = await db.recipientPathIndex.findAllIds();
  for (const oldId of rpIdxIds) {
    const r = await db.recipientPathIndex.findById(oldId);
    if (!r) continue;
    if (r.plan_id) {
      console.log('  [skip] %s already has plan_id', oldId.slice(0, 20));
      continue;
    }
    r.plan_id = currentPlanId;
    const newId = oldId + '_' + currentPlanId;
    await db.recipientPathIndex.create(newId, r);
    await db.recipientPathIndex.delete(oldId);
    changes++;
    console.log('  [rekey] %s → %s', oldId.slice(0, 20), newId.slice(0, 20));
  }

  // ── Step 5: Re-key mnemonicHashIndex ──
  console.log('\n── Step 5: mnemonicHashIndex ──');
  const mhIdxIds = await db.mnemonicHashIndex.findAllIds();
  for (const oldId of mhIdxIds) {
    const m = await db.mnemonicHashIndex.findById(oldId);
    if (!m) continue;
    if (m.plan_id) {
      console.log('  [skip] %s already has plan_id', oldId.slice(0, 20));
      continue;
    }
    m.plan_id = currentPlanId;
    const newId = oldId + '_' + currentPlanId;
    await db.mnemonicHashIndex.create(newId, m);
    await db.mnemonicHashIndex.delete(oldId);
    changes++;
    console.log('  [rekey] %s → %s', oldId.slice(0, 20), newId.slice(0, 20));
  }

  // ── Step 6: Re-key rwaDeliveryLog ──
  console.log('\n── Step 6: rwaDeliveryLog ──');
  const dlIds = await db.rwaDeliveryLog.findAllIds();
  const currentRecipientIndices = (currentPlan?.plan.recipients || []).map((_, i) => i + 1);
  for (const oldId of dlIds) {
    const d = await db.rwaDeliveryLog.findById(oldId);
    if (!d) continue;
    if (d.plan_id) {
      console.log('  [skip] %s already has plan_id', oldId.slice(0, 20));
      continue;
    }
    const recipIdx = d.recipient_index;
    // Only re-key for recipients that exist in the current plan
    if (!currentRecipientIndices.includes(recipIdx)) {
      console.log('  [del]  %s (recipient_index=%d not in current plan, removing stale entry)', oldId.slice(0, 20), recipIdx);
      await db.rwaDeliveryLog.delete(oldId);
      changes++;
      continue;
    }
    d.plan_id = currentPlanId;
    const newId = oldId + '_' + currentPlanId;
    await db.rwaDeliveryLog.create(newId, d);
    await db.rwaDeliveryLog.delete(oldId);
    changes++;
    console.log('  [rekey] %s → %s', oldId.slice(0, 20), newId.slice(0, 20));
  }

  // ── Step 7: Backfill plan_id on triggers ──
  console.log('\n── Step 7: triggers ──');
  const triggers = await db.triggers.findAll();
  for (const t of triggers) {
    if (t.plan_id) {
      console.log('  [skip] trigger %s already has plan_id', t.trigger_id.slice(0, 14));
      continue;
    }
    // All triggers are for the same wallet. Assign based on recipient count:
    // Triggers with recipient_index <= 2 → current plan (2 recipients)
    // Triggers with recipient_index = 3 → must be from an older 3-recipient plan
    const recipIdx = t.recipient_index;
    let assignPlanId;
    if (recipIdx <= currentRecipientIndices.length) {
      assignPlanId = currentPlanId;
    } else {
      // Find the first 3-recipient plan
      const match = allPlans.find(p => (p.plan.recipients || []).length >= recipIdx);
      assignPlanId = match ? match.plan.plan_id : currentPlanId;
    }
    t.plan_id = assignPlanId;
    await db.triggers.update(t.trigger_id, t);
    changes++;
    console.log('  [set]  trigger %s (status=%s, recipient=%d) → plan_id=%s',
      t.trigger_id.slice(0, 14), t.status, recipIdx, assignPlanId);
  }

  console.log('\n✅ Done. %d records updated.', changes);

  // Force save to disk
  if (typeof db._saveToDisk === 'function') {
    await db._saveToDisk();
    console.log('Database saved to disk.');
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
