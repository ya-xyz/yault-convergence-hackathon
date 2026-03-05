/**
 * POST /api/release/distribute
 *
 * Record that encrypted admin_factors were distributed to an authority.
 * Creates a binding between the wallet and the authority.
 *
 * Body: {
 *   wallet_id:  string,
 *   authority_id:  string,
 *   encrypted_packages: [
 *     // Legacy (authority-encrypted): { index, package_hex, ephemeral_pubkey_hex }
 *     // Oracle RWA (store on Arweave only): { index, recipient_solana_address, rwa_upload_body }
 *     ...
 *   ]
 * }
 *
 * For RWA packages: each rwa_upload_body is uploaded to Arweave; a manifest (key = H(wallet, authority, index))
 * is uploaded to Arweave. Only manifest_arweave_tx_id is stored in the binding (payloads not on platform).
 *
 * Returns: { binding_id, status: "active" }
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const db = require('../../db');
const { uploadPayloadsAndManifest } = require('../../services/arweaveReleaseStorage');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

async function updateRegistryAndSaveWithRetry(walletId, authorityId, manifestTxId, maxAttempts = 3) {
  const { updateRegistryAndSave } = require('../../services/arweaveReleaseStorage');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const txId = await updateRegistryAndSave(walletId, authorityId, manifestTxId);
    if (txId) return txId;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return null;
}

router.post('/', async (req, res) => {
  try {
    const { wallet_id, authority_id, encrypted_packages } = req.body || {};
    // Note: memo is embedded client-side into rwa_upload_body before sending; no server-side memo handling needed.

    // Validation
    const errors = [];
    if (!wallet_id || typeof wallet_id !== 'string') errors.push('wallet_id is required');
    if (!authority_id || typeof authority_id !== 'string') errors.push('authority_id is required');
    if (!Array.isArray(encrypted_packages) || encrypted_packages.length === 0) {
      errors.push('encrypted_packages must be a non-empty array');
    }
    if (Array.isArray(encrypted_packages)) {
      for (let i = 0; i < encrypted_packages.length; i++) {
        const p = encrypted_packages[i];
        if (p.rwa_upload_body != null && typeof p.rwa_upload_body === 'object') {
          if (!p.recipient_solana_address || typeof p.recipient_solana_address !== 'string' || !p.recipient_solana_address.trim()) {
            errors.push(`encrypted_packages[${i}]: recipient_solana_address is required when rwa_upload_body is provided`);
          }
          // Validate rwa_upload_body has required fields for upload-and-mint
          const body = p.rwa_upload_body;
          if (!body.data || !body.leafOwner) {
            errors.push(`encrypted_packages[${i}]: rwa_upload_body must contain 'data' and 'leafOwner' fields`);
          }
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // Security: only the wallet owner can distribute (create/replace binding) for that wallet_id
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (normalizeAddr(req.auth.pubkey) !== normalizeAddr(wallet_id)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only distribute for your own wallet',
      });
    }

    // Verify authority exists and is verified
    const authority = await db.authorities.findById(authority_id);
    if (!authority) {
      return res.status(404).json({ error: 'Authority not found' });
    }
    if (!authority.verified) {
      return res.status(400).json({ error: 'Authority not verified' });
    }

    // Look up recipient path config to get fingerprints
    const pathConfigs = await db.recipientPaths.findByWallet(wallet_id);
    const fingerprints = pathConfigs.length > 0
      ? pathConfigs[0].paths.map(p => p.admin_factor_fingerprint)
      : [];

    // #8 FIX: Use findByWallet instead of findAll() + filter for better performance
    const walletBindings = await db.bindings.findByWallet(wallet_id);

    // Replace any existing active bindings for this wallet (both same and different authority).
    // This allows creating a new plan that supersedes the previous one.
    for (const old of walletBindings) {
      if (old.status === 'active') {
        await db.bindings.update(old.binding_id, { ...old, status: 'replaced', terminated_at: Date.now() });
        // Reset delivery log for all recipients of the replaced binding so the new binding
        // can deliver fresh NFTs without being blocked by stale "delivered" records.
        if (Array.isArray(old.recipient_indices) && old.authority_id) {
          for (const idx of old.recipient_indices) {
            const logId = `${String(old.wallet_id).trim().toLowerCase()}_${String(old.authority_id).trim()}_${idx}`;
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
                console.log('[release/distribute] Reset delivery log for replaced binding: wallet=%s recipient=%s', old.wallet_id, idx);
              }
            } catch (err) { console.warn('[release/distribute] Non-fatal: failed to reset delivery log for recipient %s: %s', idx, err.message); }
          }
        }
        // Decrement old authority's active_bindings
        if (old.authority_id) {
          try {
            const oldAuthority = await db.authorities.findById(old.authority_id);
            if (oldAuthority && (oldAuthority.active_bindings || 0) > 0) {
              await db.authorities.update(old.authority_id, { ...oldAuthority, active_bindings: oldAuthority.active_bindings - 1 });
            }
          } catch (err) { console.warn('[release/distribute] Non-fatal: failed to update old authority bindings:', err.message); }
        }
      }
    }

    const rwaPackages = encrypted_packages.filter(
      (p) => p.rwa_upload_body != null && typeof p.rwa_upload_body === 'object'
    );
    const legacyPackages = encrypted_packages.filter(
      (p) => !p.rwa_upload_body && p.package_hex
    );
    const hasRwaPackages = rwaPackages.length > 0;
    const hasLegacyPackages = legacyPackages.length > 0;

    // Reject mixed RWA + Legacy packages in same request (prevents silent data loss)
    if (hasRwaPackages && hasLegacyPackages) {
      return res.status(400).json({
        error: 'Mixed package types not supported',
        detail: 'Cannot mix RWA (rwa_upload_body) and legacy (package_hex) packages in the same distribute request. Send them separately.',
      });
    }

    let bindingRecord;

    const bindingId = crypto.randomBytes(16).toString('hex');
    let registryTxId = null;

    if (hasRwaPackages) {
      // RWA path: store payloads on Arweave only; platform stores only manifest tx id (deterministic, untraceable mapping).
      const arweaveResult = await uploadPayloadsAndManifest(wallet_id, authority_id, rwaPackages);
      if (arweaveResult.error || !arweaveResult.manifest_arweave_tx_id) {
        return res.status(503).json({
          error: 'Arweave storage failed',
          detail: arweaveResult.error || 'Could not upload payloads or manifest. Ensure ARWEAVE_WALLET_JWK is set.',
        });
      }
      registryTxId = await updateRegistryAndSaveWithRetry(wallet_id, authority_id, arweaveResult.manifest_arweave_tx_id);
      if (!registryTxId) {
        return res.status(503).json({
          error: 'Registry update failed',
          detail: 'Could not update Arweave registry after retries. Delivery requires registry for recovery. Please retry or ensure ARWEAVE_WALLET_JWK is set.',
        });
      }
      bindingRecord = {
        binding_id: bindingId,
        wallet_id,
        authority_id,
        recipient_indices: encrypted_packages.map(p => p.index),
        release_model: 'per-path',
        admin_factor_fingerprints: fingerprints,
        manifest_arweave_tx_id: arweaveResult.manifest_arweave_tx_id,
        status: 'active',
        created_at: Date.now(),
        terminated_at: null,
      };
      // Do not store encrypted_packages or rwa_upload_body on the platform.
    } else {
      // Legacy path: store encrypted_packages in DB.
      bindingRecord = {
        binding_id: bindingId,
        wallet_id,
        authority_id,
        recipient_indices: encrypted_packages.map(p => p.index),
        release_model: 'per-path',
        admin_factor_fingerprints: fingerprints,
        encrypted_packages: encrypted_packages.map(p => ({
          index: p.index,
          package_hex: p.package_hex,
          ephemeral_pubkey_hex: p.ephemeral_pubkey_hex || '',
        })),
        status: 'active',
        created_at: Date.now(),
        terminated_at: null,
      };
    }

    await db.bindings.create(bindingRecord.binding_id, bindingRecord);

    // Increment authority's active_bindings
    const updated = { ...authority, active_bindings: (authority.active_bindings || 0) + 1 };
    await db.authorities.update(authority_id, updated);

    const responsePayload = {
      binding_id: bindingRecord.binding_id,
      status: 'active',
      packages_stored: encrypted_packages.length,
    };
    if (hasRwaPackages) {
      responsePayload.manifest_arweave_tx_id = bindingRecord.manifest_arweave_tx_id;
      if (registryTxId) {
        responsePayload.registry_arweave_tx_id = registryTxId;
        responsePayload.registry_backup_hint = 'Back up registry_arweave_tx_id to RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID so delivery can recover if DB is lost.';
      }
    }
    return res.status(201).json(responsePayload);
  } catch (err) {
    console.error('[release/distribute] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
