/**
 * DELETE /api/binding/:id
 *
 * Terminate a user-authority binding.
 * Marks binding as terminated and notifies the authority to destroy
 * any stored factor material.
 *
 * Params: :id - binding_id
 * Returns: { binding_id, status: "terminated" }
 */

'use strict';

const { Router } = require('express');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

/**
 * @route DELETE /:id
 * @description Terminate an existing user-authority binding.
 */
router.delete('/:id', authorityAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const binding = await db.bindings.findById(id);
    if (!binding) {
      return res.status(404).json({
        error: 'Not found',
        detail: `Binding with id ${id} not found`,
      });
    }

    if (binding.status === 'terminated') {
      return res.status(200).json({
        binding_id: id,
        status: 'terminated',
        detail: 'Binding was already terminated',
      });
    }

    // Verify the caller owns this binding (authority who created it)
    if (req.auth.authority_id !== binding.authority_id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You do not have permission to terminate this binding',
      });
    }

    // Atomic: terminate binding + decrement counter in a single SQLite transaction
    // Use prepare/bind/step for parameterized SELECT (sql.js exec does not bind params)
    db.bindings.runTransaction(() => {
      const innerDb = db._getDb();

      let stmt = innerDb.prepare('SELECT data FROM "bindings" WHERE id = ?');
      stmt.bind([id]);
      let bindingData = null;
      if (stmt.step()) bindingData = stmt.get()[0];
      stmt.free();
      if (!bindingData) return;

      const currentBinding = JSON.parse(bindingData);
      if (currentBinding.status === 'terminated') return;

      // Mark as terminated
      currentBinding.status = 'terminated';
      currentBinding.terminated_at = Date.now();
      innerDb.run('UPDATE "bindings" SET data = ? WHERE id = ?',
        [JSON.stringify(currentBinding), id]);

      // Decrement authority's active binding count (parameterized SELECT)
      stmt = innerDb.prepare('SELECT data FROM "authorities" WHERE id = ?');
      stmt.bind([currentBinding.authority_id]);
      let authorityData = null;
      if (stmt.step()) authorityData = stmt.get()[0];
      stmt.free();
      if (authorityData) {
        const currentAuthority = JSON.parse(authorityData);
        currentAuthority.active_bindings = Math.max((currentAuthority.active_bindings || 1) - 1, 0);
        innerDb.run('UPDATE "authorities" SET data = ? WHERE id = ?',
          [JSON.stringify(currentAuthority), currentBinding.authority_id]);
      }
    });

    return res.json({
      binding_id: id,
      status: 'terminated',
    });
  } catch (err) {
    console.error('[binding/delete] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
