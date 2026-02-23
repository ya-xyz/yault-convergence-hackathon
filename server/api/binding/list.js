/**
 * GET /api/binding/my
 *
 * List all bindings for the authenticated user.
 * Supports filtering by status.
 *
 * Query params:
 *   wallet_id - Required if not authenticated via Ed25519 (for user queries)
 *   status    - Filter: "active" | "terminated" | "all" (default: "active")
 *
 * Returns: { bindings: AuthorityUserBinding[] }
 */

'use strict';

const { Router } = require('express');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

/**
 * @route GET /
 * @description List bindings for the authenticated caller.
 */
router.get('/', authorityAuthMiddleware, async (req, res) => {
  try {
    const statusFilter = req.query.status || 'active';

    // Determine identity: either authenticated authority or wallet_id from query
    let bindings = [];

    // Authenticated authority queries their own bindings
    // (optionally filtered by wallet_id query param)
    bindings = await db.bindings.findByAuthority(req.auth.authority_id);
    if (req.query.wallet_id) {
      bindings = bindings.filter((b) => b.wallet_id === req.query.wallet_id);
    }

    // Apply status filter
    if (statusFilter !== 'all') {
      bindings = bindings.filter((b) => b.status === statusFilter);
    }

    // Sort by created_at descending
    bindings.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    // Security: do not expose encrypted_packages to API — only the release delivery job (server-side) may read them. Prevents recipient from scanning or mapping payloads to mnemonic before attestation.
    const safeBindings = bindings.map((b) => {
      const { encrypted_packages, ...rest } = b;
      return rest;
    });

    return res.json({ bindings: safeBindings });
  } catch (err) {
    console.error('[binding/list] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
