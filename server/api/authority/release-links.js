/**
 * GET /api/authority/release-links
 *
 * List release-link messages for the authenticated authority.
 * These are AdminFactor release links sent by clients when creating asset plans.
 *
 * Returns: { items: [ { id, release_link, recipient_id, evm_address, created_at } ] }
 */

'use strict';

const { Router } = require('express');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

function sanitizeReleaseLink(rawLink) {
  if (!rawLink || typeof rawLink !== 'string') return null;
  try {
    const u = new URL(rawLink, 'http://localhost');
    u.searchParams.delete('AdminFactor');
    u.searchParams.delete('admin_factor');
    const out = u.pathname + (u.search || '');
    // Preserve absolute URL only if input was absolute.
    return /^[a-z]+:\/\//i.test(rawLink) ? (u.origin + out) : out;
  } catch (_) {
    return rawLink
      .replace(/([?&])(AdminFactor|admin_factor)=[^&]*/g, '$1')
      .replace(/[?&]$/, '');
  }
}

router.get('/', authorityAuthMiddleware, async (req, res) => {
  try {
    const authorityId = req.auth.authority_id;
    if (!authorityId) {
      return res.status(401).json({ error: 'Authority not identified' });
    }
    const rows = await db.authorityReleaseLinks.findByAuthority(authorityId);
    const items = (rows || []).map((r) => ({
      id: r.id,
      release_link: sanitizeReleaseLink(r.release_link),
      recipient_id: r.recipient_id,
      evm_address: r.evm_address || null,
      created_at: r.created_at,
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[authority/release-links] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
