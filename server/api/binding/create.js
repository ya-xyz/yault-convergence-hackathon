/**
 * POST /api/binding/create
 *
 * Establish a pseudonymous user-authority binding.
 * The wallet_id is the only user identifier (no PII).
 *
 * Body: { wallet_id, authority_id, recipient_indices[] }
 * Returns: { binding_id, status: "active" }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const { AuthorityUserBinding } = require('../../models/schemas');
const db = require('../../db');

const router = Router();

/**
 * @route POST /
 * @description Create a new user-authority binding.
 */
router.post('/', authorityAuthMiddleware, async (req, res) => {
  try {
    const validation = AuthorityUserBinding.validate(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
      });
    }

    const bindingData = validation.data;

    // Verify the authenticated authority matches the binding request
    if (req.auth.authority_id !== bindingData.authority_id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'Authenticated identity does not match authority_id in request',
      });
    }

    // Verify the authority exists
    const authority = await db.authorities.findById(bindingData.authority_id);
    if (!authority) {
      return res.status(404).json({
        error: 'Authority not found',
        detail: `No authority registered with id ${bindingData.authority_id}`,
      });
    }

    // Check authority is verified
    if (!authority.verified) {
      return res.status(400).json({
        error: 'Authority not verified',
        detail: 'Cannot create binding with an unverified authority',
      });
    }

    // Check for duplicate binding (same wallet + same authority)
    const existingBindings = await db.bindings.findByWallet(bindingData.wallet_id);
    const duplicate = existingBindings.find(
      (b) => b.authority_id === bindingData.authority_id && b.status === 'active'
    );
    if (duplicate) {
      return res.status(409).json({
        error: 'Duplicate binding',
        detail: 'An active binding already exists between this wallet and authority',
      });
    }

    // Generate binding ID
    const bindingId = crypto.randomBytes(16).toString('hex');
    const record = {
      ...bindingData,
      binding_id: bindingId,
    };

    // Atomic: create binding + increment counter in a single SQLite transaction
    // to prevent race conditions on active_bindings count.
    try {
      db.bindings.runTransaction(() => {
        const innerDb = db._getDb();

        // Re-read the authority inside the transaction for consistency
        const rows = innerDb.exec('SELECT data FROM "authorities" WHERE id = ?', [bindingData.authority_id]);
        if (rows.length === 0 || rows[0].values.length === 0) throw new Error('AUTHORITY_NOT_FOUND');

        const currentAuthority = JSON.parse(rows[0].values[0][0]);
        if (currentAuthority.active_bindings >= currentAuthority.max_capacity) {
          throw new Error('CAPACITY_EXCEEDED');
        }

        // Create binding
        innerDb.run('INSERT OR REPLACE INTO "bindings" (id, data) VALUES (?, ?)',
          [bindingId, JSON.stringify(record)]);

        // Increment count
        currentAuthority.active_bindings = (currentAuthority.active_bindings || 0) + 1;
        innerDb.run('UPDATE "authorities" SET data = ? WHERE id = ?',
          [JSON.stringify(currentAuthority), bindingData.authority_id]);
      });
    } catch (txErr) {
      if (txErr.message === 'CAPACITY_EXCEEDED') {
        return res.status(400).json({
          error: 'Capacity exceeded',
          detail: 'This authority has reached maximum client capacity',
        });
      }
      throw txErr;
    }

    return res.status(201).json({
      binding_id: bindingId,
      status: 'active',
    });
  } catch (err) {
    console.error('[binding/create] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
