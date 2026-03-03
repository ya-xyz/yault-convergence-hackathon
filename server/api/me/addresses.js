/**
 * GET  /api/me/addresses — Get saved Yallet multi-chain addresses for the current user
 * PUT  /api/me/addresses — Save the current user's Yallet multi-chain addresses (reported by frontend after Yallet login)
 *
 * Body (PUT): { addresses: { evm_address?, bitcoin_address?, cosmos_address?, polkadot_address?, solana_address?, xaddress?, xidentity? } }
 * Stored by evm_address as key (matches auth.pubkey).
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

/** GET / — Get saved multi-chain addresses for current user */
router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const record = await db.walletAddresses.findById(walletId);
    if (!record) return res.json({ addresses: null });
    return res.json({ addresses: record });
  } catch (err) {
    console.error('[me/addresses] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT / — Save current user's Yallet multi-chain addresses */
router.put('/', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const { addresses } = req.body || {};
    if (!addresses || typeof addresses !== 'object') {
      return res.status(400).json({ error: 'body.addresses object is required' });
    }

    const evm = (addresses.evm_address && String(addresses.evm_address).trim()) || null;
    if (evm && normalizeAddr(evm) !== walletId) {
      return res.status(400).json({ error: 'addresses.evm_address must match the authenticated wallet' });
    }

    const data = {
      evm_address: evm || (walletId.startsWith('0x') ? walletId : '0x' + walletId),
      bitcoin_address: (addresses.bitcoin_address && String(addresses.bitcoin_address).trim()) || null,
      cosmos_address: (addresses.cosmos_address && String(addresses.cosmos_address).trim()) || null,
      polkadot_address: (addresses.polkadot_address && String(addresses.polkadot_address).trim()) || null,
      solana_address: (addresses.solana_address && String(addresses.solana_address).trim()) || null,
      xaddress: (addresses.xaddress && String(addresses.xaddress).trim()) || null,
      xidentity: (addresses.xidentity && String(addresses.xidentity).trim()) || null,
      updated_at: new Date().toISOString(),
    };
    if (data.evm_address && !data.evm_address.startsWith('0x')) data.evm_address = '0x' + data.evm_address;

    console.log('[me/addresses] PUT saved addresses for wallet:', walletId);

    await db.walletAddresses.create(walletId, data);
    return res.json({ ok: true, addresses: data });
  } catch (err) {
    console.error('[me/addresses] PUT error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
