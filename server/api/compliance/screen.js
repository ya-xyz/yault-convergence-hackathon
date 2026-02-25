/**
 * GET /api/compliance/screen — External compliance screening endpoint.
 *
 * Called by the Chainlink CRE workflow as an external data source (Data Source C)
 * before submitting an oracle attestation. In production, this would proxy to a
 * real KYC/AML provider (Chainalysis, Elliptic, etc.). For the hackathon, it
 * performs basic on-chain heuristic checks and returns a deterministic result.
 *
 * Query params:
 *   wallet_id       — wallet address to screen
 *   recipient_index — recipient path index
 *
 * Response: { cleared, provider, check_id, risk_score, checks }
 */

'use strict';

const crypto = require('crypto');
const { Router } = require('express');

const router = Router();

const ORACLE_INTERNAL_API_KEY = process.env.ORACLE_INTERNAL_API_KEY || '';

// Guard: require oracle API key when set; block in production if unset.
function oracleKeyGuard(req, res, next) {
  if (ORACLE_INTERNAL_API_KEY && ORACLE_INTERNAL_API_KEY.length > 0) {
    const provided = req.headers['x-oracle-internal-key'] || '';
    const expectedBuf = Buffer.from(ORACLE_INTERNAL_API_KEY, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return res.status(401).json({ error: 'Unauthorized', detail: 'Invalid or missing X-Oracle-Internal-Key' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Compliance screening disabled', detail: 'Set ORACLE_INTERNAL_API_KEY' });
  }
  next();
}

// Sanctioned/blocked addresses for demo (OFAC-style blocklist).
// In production this would be fetched from a real sanctions oracle.
const BLOCKED_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
]);

/**
 * Deterministic check_id so the CRE workflow can verify consistency.
 */
function computeCheckId(walletId, recipientIndex) {
  const payload = `${walletId}:${recipientIndex}:${Math.floor(Date.now() / 60000)}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

router.get('/screen', oracleKeyGuard, (req, res) => {
  const { wallet_id, recipient_index } = req.query;

  if (!wallet_id) {
    return res.status(400).json({ error: 'wallet_id is required' });
  }

  const normalizedAddr = String(wallet_id).toLowerCase().trim();
  const recipIdx = parseInt(recipient_index, 10) || 0;

  // --- Screening checks ---
  const checks = [];
  let riskScore = 0;

  // 1. Sanctions list check
  const sanctioned = BLOCKED_ADDRESSES.has(normalizedAddr);
  checks.push({ name: 'sanctions_list', passed: !sanctioned });
  if (sanctioned) riskScore += 100;

  // 2. Zero-address check
  const isZeroAddr = /^0x0{40}$/i.test(normalizedAddr);
  checks.push({ name: 'zero_address', passed: !isZeroAddr });
  if (isZeroAddr) riskScore += 50;

  // 3. Valid format check
  const validFormat = /^0x[0-9a-f]{40}$/i.test(normalizedAddr);
  checks.push({ name: 'address_format', passed: validFormat });
  if (!validFormat) riskScore += 30;

  const cleared = riskScore === 0;
  const checkId = computeCheckId(normalizedAddr, recipIdx);

  res.json({
    cleared,
    provider: 'yault-compliance-v1',
    check_id: checkId,
    risk_score: riskScore,
    checks,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
