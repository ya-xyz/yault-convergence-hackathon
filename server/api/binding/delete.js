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

    // Backend-agnostic terminate + decrement (SQLite + Postgres adapters)
    const updatedBinding = {
      ...binding,
      status: 'terminated',
      terminated_at: Date.now(),
    };
    await db.bindings.update(id, updatedBinding);
    if (binding.authority_id) {
      const authority = await db.authorities.findById(binding.authority_id);
      if (authority) {
        await db.authorities.update(binding.authority_id, {
          ...authority,
          active_bindings: Math.max((authority.active_bindings || 1) - 1, 0),
        });
      }
    }

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
