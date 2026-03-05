/**
 * POST /api/release/replace-path-payload
 *
 * Replace a single recipient path's encrypted payload (e.g. after fixing wrong x25519 encryption).
 * Only the wallet owner can call this. Updates Arweave manifest, registry, binding, and path config.
 *
 * Body: {
 *   wallet_id: string,
 *   authority_id: string,
 *   recipient_index: number,   // 1-based path index
 *   recipient_solana_address: string,
 *   rwa_upload_body: { data, leafOwner, ... },
 *   admin_factor_fingerprint: string  // 64-char hex (SHA-256 of new admin_factor)
 * }
 *
 * Returns: { ok: true, manifest_arweave_tx_id: string }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const db = require('../../db');
const {
  replacePathPayload,
  updateRegistryAndSave,
  getManifestTxIdFromRegistry,
} = require('../../services/arweaveReleaseStorage');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

router.post('/', async (req, res) => {
    try {
      const {
        wallet_id,
        authority_id,
        recipient_index,
        recipient_solana_address,
        rwa_upload_body,
        admin_factor_fingerprint,
      } = req.body || {};

      if (!req.auth || !req.auth.pubkey) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (normalizeAddr(req.auth.pubkey) !== normalizeAddr(wallet_id)) {
        return res.status(403).json({
          error: 'Forbidden',
          detail: 'You can only replace payload for your own wallet',
        });
      }

      const idx = Number(recipient_index);
      if (!Number.isInteger(idx) || idx < 1) {
        return res.status(400).json({ error: 'recipient_index must be a positive integer' });
      }
      if (!recipient_solana_address || typeof recipient_solana_address !== 'string' || !recipient_solana_address.trim()) {
        return res.status(400).json({ error: 'recipient_solana_address is required' });
      }
      if (!rwa_upload_body || typeof rwa_upload_body !== 'object' || !rwa_upload_body.data || !rwa_upload_body.leafOwner) {
        return res.status(400).json({ error: 'rwa_upload_body with data and leafOwner is required' });
      }
      if (!admin_factor_fingerprint || typeof admin_factor_fingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(admin_factor_fingerprint)) {
        return res.status(400).json({ error: 'admin_factor_fingerprint must be 64-char hex' });
      }

      const walletBindings = await db.bindings.findByWallet(wallet_id);
      const binding = walletBindings.find(
        (b) => b.status === 'active' && (b.authority_id || '') === String(authority_id || '')
      );
      if (!binding) {
        return res.status(404).json({ error: 'Active binding not found for this wallet and authority' });
      }
      const indices = (binding.recipient_indices || []).map(Number);
      if (!indices.includes(idx)) {
        return res.status(400).json({ error: 'recipient_index is not in this binding' });
      }

      let currentManifestTxId = binding.manifest_arweave_tx_id || null;
      if (!currentManifestTxId) {
        currentManifestTxId = await getManifestTxIdFromRegistry(wallet_id, authority_id);
      }
      if (!currentManifestTxId) {
        return res.status(503).json({
          error: 'Could not resolve current manifest',
          detail: 'Binding has no manifest_arweave_tx_id and registry lookup failed.',
        });
      }

      const result = await replacePathPayload(
        wallet_id,
        authority_id,
        idx,
        rwa_upload_body,
        currentManifestTxId
      );
      if (result.error || !result.manifest_arweave_tx_id) {
        return res.status(503).json({
          error: result.error || 'Replace path payload failed',
        });
      }

      const newManifestTxId = result.manifest_arweave_tx_id;
      await updateRegistryAndSave(wallet_id, authority_id, newManifestTxId);

      // Reset delivery log for this recipient so the new payload can be delivered
      // without being blocked by stale "delivered" records from the old payload.
      const logId = `${String(wallet_id).trim().toLowerCase()}_${String(authority_id).trim()}_${idx}`;
      try {
        const existingLog = await db.rwaDeliveryLog.findById(logId);
        if (existingLog) {
          await db.rwaDeliveryLog.create(logId, {
            ...existingLog,
            status: 'superseded',
            superseded_at: Date.now(),
            previous_txId: existingLog.txId || null,
            txId: null,
            error: null,
            attempts: 0,
            updated_at: Date.now(),
          });
          console.log('[release/replace-path-payload] Reset delivery log for replaced payload: wallet=%s recipient=%s', wallet_id, idx);
        }
      } catch (logErr) {
        console.warn('[release/replace-path-payload] Non-fatal: failed to reset delivery log:', logErr.message);
      }

      const fingerprints = (binding.admin_factor_fingerprints || []).slice();
      const pos = indices.indexOf(idx);
      if (pos >= 0) {
        fingerprints[pos] = admin_factor_fingerprint.toLowerCase();
      }
      await db.bindings.update(binding.binding_id, {
        ...binding,
        manifest_arweave_tx_id: newManifestTxId,
        admin_factor_fingerprints: fingerprints,
      });

      const pathConfigId = crypto.createHash('sha256').update(String(wallet_id)).digest('hex').slice(0, 32);
      const pathRecord = await db.recipientPaths.findById(pathConfigId);
      if (pathRecord && Array.isArray(pathRecord.paths)) {
        const paths = pathRecord.paths.map((p) => {
          if (p.index === idx) {
            return { ...p, admin_factor_fingerprint: admin_factor_fingerprint.toLowerCase() };
          }
          return p;
        });
        await db.recipientPaths.update(pathConfigId, { ...pathRecord, paths });
      }

      return res.json({ ok: true, manifest_arweave_tx_id: newManifestTxId });
    } catch (err) {
      console.error('[release/replace-path-payload] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

module.exports = router;
