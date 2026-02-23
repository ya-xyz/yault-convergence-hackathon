/**
 * POST /api/trigger/attestation/fallback
 *
 * Submit a fallback attestation to the ReleaseAttestation contract (relayer sends tx).
 * Authority must be authenticated; relayer key is in config.
 * Body: { wallet_id, recipient_index, decision, reason_code?, evidence_hash }
 */

'use strict';

const { Router } = require('express');
const { authorityAuthMiddleware } = require('../../middleware/auth');
const config = require('../../config');
const db = require('../../db');
const { submitFallbackAttestation } = require('../../services/attestationSubmitter');
const { deliverRwaPackageForRecipient } = require('../../services/deliverRwaRelease');

const router = Router();

router.post('/', authorityAuthMiddleware, async (req, res) => {
  try {
    const { wallet_id, recipient_index, decision, reason_code, evidence_hash } = req.body || {};

    if (!wallet_id || recipient_index == null) {
      return res.status(400).json({ error: 'wallet_id and recipient_index are required' });
    }
    if (!['release', 'hold', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be release, hold, or reject' });
    }
    if (!evidence_hash || typeof evidence_hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(evidence_hash)) {
      return res.status(400).json({ error: 'evidence_hash must be a 64-character hex string (SHA-256)' });
    }

    // Security: verify authority has active binding with this wallet and recipient_index
    const authorityId = req.auth?.authority_id;
    const recIndex = Number(recipient_index);
    const bindings = await db.bindings.findByWallet(wallet_id);
    const activeBinding = bindings.find(
      (b) =>
        b.authority_id === authorityId &&
        b.status === 'active' &&
        Array.isArray(b.recipient_indices) &&
        b.recipient_indices.some((idx) => Number(idx) === recIndex)
    );
    if (!activeBinding) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'No active binding between this authority and wallet/recipient. Cannot submit attestation.',
      });
    }

    if (!config.oracle?.releaseAttestationAddress || !config.oracle?.releaseAttestationRelayerPrivateKey) {
      return res.status(503).json({
        error: 'Fallback attestation not configured',
        detail: 'Set RELEASE_ATTESTATION_ADDRESS and RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY.',
      });
    }

    const result = await submitFallbackAttestation(config, {
      walletId: wallet_id,
      recipientIndex: Number(recipient_index),
      decision,
      reasonCode: reason_code,
      evidenceHash: evidence_hash,
    });

    // When decision is release, deliver the stored RWA credential NFT to the recipient (POST rwa_upload_body to upload-and-mint). Only then can the recipient see the NFT in Yallet.
    let delivery = null;
    if (decision === 'release') {
      delivery = await deliverRwaPackageForRecipient(activeBinding, recIndex);
      if (delivery.delivered && delivery.txId) {
        console.log('[trigger/attestation-fallback] RWA NFT delivered for wallet=%s recipient_index=%s txId=%s', wallet_id, recipient_index, delivery.txId);
      } else if (!delivery.delivered && delivery.error) {
        console.warn('[trigger/attestation-fallback] RWA delivery failed for wallet=%s recipient_index=%s: %s', wallet_id, recipient_index, delivery.error);
      }
    }

    return res.json({
      status: 'submitted',
      tx_hash: result.txHash,
      block_number: result.blockNumber,
      message: 'Fallback attestation submitted on-chain.',
      ...(delivery && { delivery: { delivered: delivery.delivered, txId: delivery.txId, error: delivery.error } }),
    });
  } catch (err) {
    console.error('[trigger/attestation-fallback] Error:', err);
    if (err.message && err.message.includes('RELEASE_ATTESTATION')) {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

module.exports = router;
