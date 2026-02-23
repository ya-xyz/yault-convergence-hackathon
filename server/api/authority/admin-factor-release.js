/**
 * Authority AdminFactor linking endpoint.
 *
 * Security model:
 * - Write operation requires authority authentication.
 * - AdminFactor must be submitted in POST body (never in URL query).
 * - Authority can only link recipient_id entries that were sent to this authority.
 */

'use strict';

const { Router } = require('express');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

function normalizeHash(h) {
  if (!h || typeof h !== 'string') return '';
  return h.replace(/^0x/i, '').trim().toLowerCase();
}

function isHex64(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

// Legacy UX entrypoint: show instructions only. No write via GET.
router.get('/release', async (req, res) => {
  try {
    const recipientId = normalizeHash(req.query.recipient_id || req.query.recipientId);
    if (!isHex64(recipientId)) {
      return res.status(400).send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invalid</title></head><body><p>Missing or invalid recipient_id (must be 64-char hex mnemonic hash).</p></body></html>'
      );
    }

    return res.send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Use Authority Portal</title></head><body><p>recipient_id is valid.</p><p>For security, submit AdminFactor via Authority Portal (authenticated POST), not URL query.</p></body></html>'
    );
  } catch (err) {
    console.error('[authority/AdminFactor/release] Error:', err);
    return res.status(500).send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><p>Internal server error.</p></body></html>'
    );
  }
});

router.post('/release', authorityAuthMiddleware, async (req, res) => {
  try {
    const authorityId = req.auth && req.auth.authority_id;
    if (!authorityId) {
      return res.status(401).json({ error: 'Authority authentication required' });
    }

    const recipientId = normalizeHash(req.body?.recipient_id || req.body?.recipientId);
    const adminFactor = normalizeHash(req.body?.admin_factor || req.body?.adminFactor);

    if (!isHex64(recipientId)) {
      return res.status(400).json({ error: 'recipient_id must be a 64-char hex mnemonic hash' });
    }
    if (!isHex64(adminFactor)) {
      return res.status(400).json({ error: 'admin_factor must be a 64-char hex string' });
    }

    const links = await db.authorityReleaseLinks.findByAuthority(authorityId);
    const allowed = (links || []).some((r) => normalizeHash(r.recipient_id) === recipientId);
    if (!allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'recipient_id is not linked to this authority',
      });
    }

    const record = await db.recipientMnemonicAdmin.findById(recipientId);
    if (!record) {
      return res.status(404).json({ error: 'No record for this recipient_id' });
    }

    const updated = {
      ...record,
      admin_factor: adminFactor,
      linked_by_authority_id: authorityId,
      linked_at: new Date().toISOString(),
    };
    await db.recipientMnemonicAdmin.update(recipientId, updated);

    // Mark related authority release-link messages as processed by removing them.
    const processedLinkIds = [];
    for (const l of links || []) {
      if (normalizeHash(l.recipient_id) !== recipientId) continue;
      if (!l.id) continue;
      processedLinkIds.push(l.id);
      await db.authorityReleaseLinks.delete(l.id);
    }

    return res.json({
      ok: true,
      recipient_id: recipientId,
      evm_address: record.evm_address || null,
      processed_link_ids: processedLinkIds,
    });
  } catch (err) {
    console.error('[authority/AdminFactor/release] POST Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
