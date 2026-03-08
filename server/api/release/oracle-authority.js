/**
 * GET /api/release/oracle-authority
 *
 * Returns the platform-configured Oracle authority when Oracle trigger is enabled.
 * Used by the client to run configure + distribute automatically on "Submit & Create Plan"
 * for Oracle-only plans (no separate Protection step needed).
 *
 * Returns 200: { id, name, public_key_hex } when ORACLE_AUTHORITY_ID is set.
 * DB authority profile is optional for oracle-only trigger flow.
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
    return res.json({
      id: oracleId,
      name: (authority && authority.name) || 'Oracle Authority',
      public_key_hex: (authority && (authority.public_key_hex || authority.pubkey)) || '',
    });
  } catch (err) {
    console.error('[release/oracle-authority] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
