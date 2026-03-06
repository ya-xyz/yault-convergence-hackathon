'use strict';
const db = require('../server/db');

(async () => {
  await db.ensureReady();

  // 1. walletPlans
  const plans = await db.walletPlans.findAll();
  console.log('=== walletPlans (' + plans.length + ') ===');
  for (const p of plans) {
    const hasRecipients = !!(p.recipients && p.recipients.length);
    console.log(JSON.stringify({
      plan_id: p.plan_id || null,
      createdAt: p.createdAt,
      has_recipients: hasRecipients,
      recipient_count: (p.recipients || []).length,
      chain_key: p.chain_key,
      token_symbol: p.token_symbol,
    }));
  }

  // Also get the raw IDs for walletPlans
  const planIds = await db.walletPlans.findAllIds();
  console.log('\nwalletPlans IDs:', JSON.stringify(planIds));

  // 2. bindings
  const bindings = await db.bindings.findAll();
  console.log('\n=== bindings (' + bindings.length + ') ===');
  for (const b of bindings) {
    console.log(JSON.stringify({
      binding_id: b.binding_id,
      wallet_id: (b.wallet_id || '').slice(0, 14),
      authority_id: (b.authority_id || '').slice(0, 14),
      status: b.status,
      plan_id: b.plan_id || null,
      recipient_indices: b.recipient_indices,
      has_manifest: !!b.manifest_arweave_tx_id,
    }));
  }

  // 3. triggers
  const triggers = await db.triggers.findAll();
  console.log('\n=== triggers (' + triggers.length + ') ===');
  for (const t of triggers) {
    console.log(JSON.stringify({
      trigger_id: (t.trigger_id || '').slice(0, 14),
      wallet_id: (t.wallet_id || '').slice(0, 14),
      status: t.status,
      plan_id: t.plan_id || null,
      recipient_index: t.recipient_index,
      trigger_type: t.trigger_type,
    }));
  }

  // 4. rwaDeliveryLog
  const logs = await db.rwaDeliveryLog.findAll();
  console.log('\n=== rwaDeliveryLog (' + logs.length + ') ===');
  for (const l of logs) {
    console.log(JSON.stringify({
      wallet_id: (l.wallet_id || '').slice(0, 14),
      authority_id: (l.authority_id || '').slice(0, 14),
      recipient_index: l.recipient_index,
      status: l.status,
      plan_id: l.plan_id || null,
      txId: l.txId ? l.txId.slice(0, 20) : null,
    }));
  }

  // 5. recipientPaths
  const paths = await db.recipientPaths.findAll();
  console.log('\n=== recipientPaths (' + paths.length + ') ===');
  for (const rp of paths) {
    console.log(JSON.stringify({
      wallet_id: (rp.wallet_id || '').slice(0, 14),
      plan_id: rp.plan_id || null,
      paths_count: (rp.paths || []).length,
      trigger_type: rp.trigger_type,
    }));
  }

  // 5b. recipientPaths raw IDs
  const rpIds = await db.recipientPaths.findAllIds();
  console.log('\nrecipientPaths IDs:', JSON.stringify(rpIds));

  // 6. recipientPathIndex
  const rpIdx = await db.recipientPathIndex.findAll();
  console.log('\n=== recipientPathIndex (' + rpIdx.length + ') ===');
  for (const r of rpIdx) {
    console.log(JSON.stringify({
      recipient_address: (r.recipient_address || '').slice(0, 14),
      wallet_id: (r.wallet_id || '').slice(0, 14),
      plan_id: r.plan_id || null,
    }));
  }

  // 7. mnemonicHashIndex
  const mhIdx = await db.mnemonicHashIndex.findAll();
  console.log('\n=== mnemonicHashIndex (' + mhIdx.length + ') ===');
  for (const m of mhIdx) {
    console.log(JSON.stringify({
      mnemonic_hash: (m.mnemonic_hash || '').slice(0, 14),
      wallet_id: (m.wallet_id || '').slice(0, 14),
      plan_id: m.plan_id || null,
      path_index: m.path_index,
    }));
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
