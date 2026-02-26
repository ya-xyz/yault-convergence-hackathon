/**
 * POST /api/release/deliver-from-registry
 *
 * Recovery delivery when platform DB is lost. Uses only the global Arweave registry
 * (RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID) to resolve manifest and payload, then POSTs to upload-and-mint.
 * Set force_redeliver: true to re-send even when log already says delivered (redelivery).
 *
 * Body: { wallet_id, authority_id, recipient_index [, force_redeliver ] }. force_redeliver: re-send even if log says delivered.
 * Requires: authority auth; caller must be the given authority_id.
 *
 * Use after setting RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID to the last known registry tx id.
 */

'use strict';

const { Router } = require('express');
const { deliverByRegistry } = require('../../services/deliverRwaRelease');

const router = Router();

// Auth is applied at mount level (dualAuthMiddleware in index.js).
router.post('/', async (req, res) => {
  try {
    const { wallet_id, authority_id, recipient_index, force_redeliver } = req.body || {};

    if (!wallet_id || !authority_id || recipient_index == null) {
      return res.status(400).json({
        error: 'wallet_id, authority_id, and recipient_index are required',
      });
    }
    if (req.auth?.authority_id !== authority_id) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only deliver for your own authority',
      });
    }

    const result = await deliverByRegistry(wallet_id, authority_id, Number(recipient_index), {
      forceRedeliver: !!force_redeliver,
    });

    if (result.delivered) {
      return res.json({
        delivered: true,
        txId: result.txId,
        message: force_redeliver
          ? 'RWA NFT redelivered successfully.'
          : 'RWA NFT delivered from registry (recovery path).',
      });
    }
    return res.status(502).json({
      delivered: false,
      error: result.error || 'Delivery failed',
      detail: 'Ensure RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID is set to the current registry tx id.',
    });
  } catch (err) {
    console.error('[release/deliver-from-registry] Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

module.exports = router;
