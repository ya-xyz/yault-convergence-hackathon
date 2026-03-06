/**
 * GET /api/release/redeliver-candidates
 *
 * Returns a list of recipients for released plans under the authenticated authority,
 * with delivery status, so the authority can redeliver from the UI without knowing
 * wallet_id or recipient index. Used by the Authority Dashboard "Redeliver NFT" page.
 *
 * Requires: authority auth.
 * Returns: { candidates: Array<{ wallet_id, recipient_index, delivery_status, trigger_id }> }
 */

'use strict';

const { Router } = require('express');
const db = require('../../db');

function deliveryLogId(walletId, authorityId, recipientIndex, planId) {
  const base = `${String(walletId).trim().toLowerCase()}_${String(authorityId).trim()}_${recipientIndex}`;
  return planId ? `${base}_${String(planId).trim()}` : base;
}

const router = Router();

router.get('/', async (req, res) => {
  try {
    const authorityId = req.auth?.authority_id;
    if (!authorityId) {
      return res.status(401).json({ error: 'Unauthorized', detail: 'Authority session required' });
    }

    const [triggers, bindings] = await Promise.all([
      db.triggers.findByAuthority(authorityId),
      db.bindings.findByAuthority(authorityId),
    ]);

    const released = triggers.filter((t) => t.status === 'released');
    const bindingByWallet = new Map();
    for (const b of bindings) {
      if (b.status !== 'active') continue;
      const key = `${(b.wallet_id || '').toLowerCase()}|${b.plan_id || ''}`;
      bindingByWallet.set(key, b);
    }

    const candidates = [];
    const seen = new Set();
    for (const trigger of released) {
      const walletId = trigger.wallet_id;
      if (!walletId) continue;
      const triggerPlanId = trigger.plan_id || null;
      if (!triggerPlanId) continue;
      const binding = bindingByWallet.get(`${walletId.toLowerCase()}|${triggerPlanId || ''}`);
      if (!binding || !Array.isArray(binding.recipient_indices)) continue;

      for (const recipientIndex of binding.recipient_indices) {
        const idx = Number(recipientIndex);
        if (Number.isNaN(idx) || idx < 0) continue;
        const dedupeKey = `${walletId.toLowerCase()}|${authorityId}|${triggerPlanId}|${idx}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const logId = deliveryLogId(walletId, authorityId, idx, triggerPlanId);
        const log = await db.rwaDeliveryLog.findById(logId).catch(() => null);
        candidates.push({
          wallet_id: walletId,
          plan_id: triggerPlanId,
          recipient_index: idx,
          delivery_status: log?.status ?? null,
          trigger_id: trigger.trigger_id,
        });
      }
    }

    return res.json({ candidates });
  } catch (err) {
    console.error('[release/redeliver-candidates] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
