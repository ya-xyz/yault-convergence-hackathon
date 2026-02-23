/**
 * GET  /api/me/tokens?chain=ethereum — Get custom token list for the current user on a given chain (used for Redeem Token dropdown)
 * POST /api/me/tokens — Add a custom token, body: { chain_key, chain_id?, token_name, contract_address }
 * Stored by evm_address as key; each token contains chain_key, chain_id, token_name, contract_address
 */

'use strict';

const { Router } = require('express');
const { dualAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/** GET /?chain= — tokens for selected chain */
router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    const evmAddress = normalizeAddr(req.auth.pubkey);
    if (!evmAddress) return res.status(401).json({ error: 'Authentication required' });

    const chainKey = (req.query.chain || '').trim();
    const record = await db.userCustomTokens.findById(evmAddress);
    const tokens = (record && record.tokens && Array.isArray(record.tokens)) ? record.tokens : [];
    const filtered = chainKey ? tokens.filter((t) => (t.chain_key || t.chainKey) === chainKey) : tokens;
    return res.json({ tokens: filtered });
  } catch (err) {
    console.error('[me/tokens] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST / — add custom token */
router.post('/', dualAuthMiddleware, async (req, res) => {
  try {
    const evmAddress = normalizeAddr(req.auth.pubkey);
    if (!evmAddress) return res.status(401).json({ error: 'Authentication required' });

    const { chain_key, chain_id, token_name, contract_address } = req.body || {};
    const chainKey = (chain_key || req.body?.chainKey || '').trim();
    const tokenName = (token_name || req.body?.tokenName || '').trim();
    const contractAddress = (contract_address || req.body?.contract_address || '').trim();

    if (!chainKey || !tokenName || !contractAddress) {
      return res.status(400).json({ error: 'chain_key, token_name, contract_address are required' });
    }

    const record = await db.userCustomTokens.findById(evmAddress);
    const tokens = (record && record.tokens && Array.isArray(record.tokens)) ? record.tokens : [];
    tokens.push({
      chain_key: chainKey,
      chain_id: chain_id != null ? chain_id : null,
      token_name: tokenName,
      contract_address: contractAddress,
    });
    await db.userCustomTokens.create(evmAddress, { evm_address: evmAddress.startsWith('0x') ? evmAddress : '0x' + evmAddress, tokens });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[me/tokens] POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
