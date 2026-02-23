/**
 * GET /api/release/oracle-authority
 *
 * Returns the platform-configured Oracle authority when Oracle trigger is enabled.
 * Used by the client to run configure + distribute automatically on "Submit & Create Plan"
 * for Oracle-only plans (no separate Protection step needed).
 *
 * Returns 200: { id, name, public_key_hex } when ORACLE_AUTHORITY_ID is set and authority exists.
 * Returns 404 when Oracle authority is not configured.
 */

'use strict';

const { Router } = require('express');
const config = require('../../config');
const db = require('../../db');
const { dualAuthMiddleware } = require('../../middleware/auth');

const router = Router();

router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    const oracleId = config.oracle?.oracleAuthorityId;
    if (!oracleId || !config.oracle?.enabled) {
      return res.status(404).json({
        error: 'Oracle authority not configured',
        detail: 'Set ORACLE_ATTESTATION_ENABLED=true and ORACLE_AUTHORITY_ID in server config.',
      });
    }
    const authority = await db.authorities.findById(oracleId);
    if (!authority || !authority.verified) {
      return res.status(404).json({
        error: 'Oracle authority not found or not verified',
        detail: 'Ensure the authority exists and is verified.',
      });
    }
    return res.json({
      id: authority.authority_id || oracleId,
      name: authority.name || authority.authority_id || oracleId,
      public_key_hex: authority.public_key_hex || authority.pubkey || '',
    });
  } catch (err) {
    console.error('[release/oracle-authority] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
