/**
 * server/api/path-claim/index.js — YaultPathClaim contract API
 *
 * When PATH_CLAIM_ADDRESS is set:
 *   GET  /config       — Path claim contract config for frontend.
 *   GET  /remaining    — Remaining claimable for (walletIdHash, pathIndex).
 *   GET  /claim-params — Nonce and EIP-712 digest for claim (amount from blob, no amount input on page).
 *   POST /parse-blob   — Parse blob (40 bytes: AF 32 + amount 8 BE) → { admin_factor_hex, amount }.
 */

'use strict';

const { Router } = require('express');
const config = require('../../config');
const pathClaimContract = require('../../services/pathClaimContract');
const { dualAuthMiddleware } = require('../../middleware/auth');

const router = Router();
router.use('/remaining', dualAuthMiddleware);
router.use('/claim-params', dualAuthMiddleware);
router.use('/parse-blob', dualAuthMiddleware);

/** Blob format: 32 bytes AdminFactor + 8 bytes amount (u64 big-endian). */
function parseBlob(blobHex) {
  const hex = (blobHex || '').replace(/^0x/i, '').trim();
  if (hex.length !== 80) return null; // 40 bytes
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 40) return null;
  const adminFactorHex = buf.slice(0, 32).toString('hex');
  const amount = buf.readBigUInt64BE(32);
  return { admin_factor_hex: adminFactorHex, amount: amount.toString() };
}

function hasPathClaim() {
  return !!(config.pathClaim && config.pathClaim.address && config.pathClaim.address.trim());
}

/** GET /api/path-claim/config — Path claim contract config (for frontend) */
router.get('/config', (_req, res) => {
  if (!hasPathClaim()) {
    return res.json({
      pathClaimAddress: '',
      assetAddress: '',
      chainId: '',
      rpcUrl: '',
      enabled: false,
    });
  }
  res.json({
    pathClaimAddress: config.pathClaim.address.trim(),
    assetAddress: (config.pathClaim.assetAddress || '').trim(),
    chainId: String(config.pathClaim.chainId || '1'),
    rpcUrl: (config.pathClaim.rpcUrl || '').trim() || 'https://eth.llamarpc.com',
    enabled: true,
  });
});

/** GET /api/path-claim/remaining?walletIdHash=0x...&pathIndex=1 */
router.get('/remaining', async (req, res) => {
  if (!hasPathClaim()) {
    return res.status(503).json({ error: 'Path claim not configured' });
  }
  const walletIdHash = (req.query.walletIdHash || '').trim();
  const pathIndex = req.query.pathIndex != null ? String(req.query.pathIndex) : '';
  if (!walletIdHash || pathIndex === '') {
    return res.status(400).json({ error: 'walletIdHash and pathIndex required' });
  }
  try {
    const remaining = await pathClaimContract.getRemainingForPath(config, walletIdHash, pathIndex);
    if (remaining == null) {
      return res.status(502).json({ error: 'Failed to read remaining from chain' });
    }
    res.json({ remaining });
  } catch (err) {
    console.error('[path-claim/remaining]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/path-claim/claim-params?walletIdHash=0x...&pathIndex=1&amount=1000000&to=0x...&deadline=... */
router.get('/claim-params', async (req, res) => {
  if (!hasPathClaim()) {
    return res.status(503).json({ error: 'Path claim not configured' });
  }
  const walletIdHash = (req.query.walletIdHash || '').trim();
  const pathIndex = req.query.pathIndex != null ? String(req.query.pathIndex) : '';
  const amount = (req.query.amount || '').trim();
  const to = (req.query.to || '').trim();
  const deadline = (req.query.deadline || '').trim();
  if (!walletIdHash || pathIndex === '' || !amount || !to || !deadline) {
    return res.status(400).json({
      error: 'walletIdHash, pathIndex, amount, to, deadline required',
    });
  }
  try {
    const nonce = await pathClaimContract.getClaimNonce(config, walletIdHash, pathIndex);
    if (nonce == null) {
      return res.status(502).json({ error: 'Failed to read nonce from chain' });
    }
    const digest = await pathClaimContract.getClaimHash(
      config,
      walletIdHash,
      pathIndex,
      amount,
      to,
      nonce,
      deadline
    );
    if (digest == null) {
      return res.status(502).json({ error: 'Failed to compute claim hash' });
    }
    res.json({
      nonce,
      digest,
      chainId: String(config.pathClaim.chainId || '1'),
      pathClaimAddress: config.pathClaim.address.trim(),
    });
  } catch (err) {
    console.error('[path-claim/claim-params]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /api/path-claim/parse-blob — body: { blobHex }. Returns { admin_factor_hex, amount } (amount as string). */
router.post('/parse-blob', (req, res) => {
  const blobHex = (req.body && req.body.blobHex) || (req.query && req.query.blobHex) || '';
  const result = parseBlob(blobHex);
  if (!result) {
    return res.status(400).json({ error: 'Invalid blob: must be 80 hex chars (40 bytes: 32 AF + 8 amount BE)' });
  }
  res.json(result);
});

module.exports = router;
