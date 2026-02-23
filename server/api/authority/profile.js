/**
 * GET /api/authority/:id
 *
 * Public authority profile retrieval.
 * Returns only public-safe fields (no internal state).
 *
 * Params: :id - authority_id
 * Returns: AuthorityProfile (public fields only)
 */

'use strict';

const { Router } = require('express');
const db = require('../../db');
const { authorityAuthMiddleware } = require('../../middleware/auth');

const router = Router();

/** Fields from authority record. solana_address/xidentity are resolved from walletAddresses. */
const PUBLIC_FIELDS = [
  'authority_id',
  'name',
  'bar_number',
  'jurisdiction',
  'region',
  'address',
  'contact',
  'specialization',
  'languages',
  'fee_structure',
  'email',
  'website',
  'verified',
  'rating',
  'rating_count',
  'active_bindings',
  'max_capacity',
  'created_at',
];

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/**
 * @route GET /:id
 * @description Get an authority's public profile. solana_address and xidentity come from walletAddresses (same as any logged-in user).
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const authority = await db.authorities.findById(id);
    if (!authority) {
      return res.status(404).json({
        error: 'Not found',
        detail: `Authority with id ${id} not found`,
      });
    }

    const publicProfile = {};
    for (const field of PUBLIC_FIELDS) {
      if (authority[field] !== undefined) {
        publicProfile[field] = authority[field];
      }
    }

    // Resolve solana_address and xidentity from walletAddresses (id = normalized evm_address / pubkey)
    const walletId = normalizeAddr(authority.pubkey);
    if (walletId) {
      const addrRecord = await db.walletAddresses.findById(walletId);
      if (addrRecord) {
        publicProfile.solana_address = addrRecord.solana_address || null;
        publicProfile.xidentity = addrRecord.xidentity || null;
      }
    }

    return res.json(publicProfile);
  } catch (err) {
    console.error('[authority/profile] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Allowed fields when authority updates their own profile. solana_address/xidentity are read from walletAddresses only (no edit here). */
const SELF_UPDATE_FIELDS = ['name', 'bar_number', 'jurisdiction', 'region', 'email', 'website', 'address', 'contact'];

/**
 * @route PATCH /:id
 * @description Authority updates their own profile (requires X-Authority-Session).
 */
router.patch('/:id', authorityAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.auth.authority_id !== id) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }
    const authority = await db.authorities.findById(id);
    if (!authority) {
      return res.status(404).json({ error: 'Not found' });
    }
    const body = req.body || {};
    const updated = { ...authority };
    for (const key of SELF_UPDATE_FIELDS) {
      if (body[key] !== undefined) {
        updated[key] = body[key] === '' ? null : body[key];
      }
    }
    await db.authorities.update(id, updated);
    const out = {};
    for (const field of PUBLIC_FIELDS) {
      if (updated[field] !== undefined) out[field] = updated[field];
    }
    return res.json(out);
  } catch (err) {
    console.error('[authority/profile] PATCH Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
