/**
 * GET /api/claim/lookup/:wallet_id
 *
 * Recipient looks up released admin_factors for a wallet.
 * Returns all released factors + recipient path info.
 * The client matches the correct factor by trying each with their passphrase.
 *
 * Params: :wallet_id — the asset owner's wallet address
 * Returns: { wallet_id, released, factors[], vault_value }
 */

'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const db = require('../../db');
const config = require('../../config');
const escrowContract = require('../../services/escrowContract');

const router = Router();

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/** Mnemonic hash must be 64-char hex (e.g. SHA-256 of normalized mnemonic). */
function isValidMnemonicHash(h) {
  const s = String(h || '').replace(/^0x/i, '').trim();
  return s.length === 64 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Verify caller is authorized to view factors for this wallet_id.
 * Allowed: (1) wallet owner, or (2) a configured recipient (recipient_evm_address).
 */
function isAuthorized(callerPubkey, walletId, paths) {
  const callerNorm = normalizeAddr(callerPubkey);
  const walletNorm = normalizeAddr(walletId);
  if (callerNorm === walletNorm) return true;
  if (!paths || !Array.isArray(paths)) return false;
  return paths.some(p => {
    const recip = p.recipient_evm_address;
    return recip && normalizeAddr(recip) === callerNorm;
  });
}

/**
 * POST /api/claim/register-mnemonic-hash
 *
 * Recipient registers their mnemonic hash for a path so that release can be tied to "this blob is for this wallet (mnemonic-hash)".
 * Body: { wallet_id, path_index, mnemonic_hash } — mnemonic_hash = 64-char hex (e.g. SHA-256 of normalized mnemonic).
 * Caller must be the recipient_evm_address for that path. Authority can use this hash to know which blob goes to which recipient.
 */
router.post('/register-mnemonic-hash', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { wallet_id, path_index, mnemonic_hash } = req.body || {};
    if (!wallet_id || path_index == null) {
      return res.status(400).json({ error: 'wallet_id and path_index are required' });
    }
    if (!isValidMnemonicHash(mnemonic_hash)) {
      return res.status(400).json({ error: 'mnemonic_hash must be a 64-char hex string (e.g. SHA-256 of mnemonic)' });
    }
    const hashNorm = String(mnemonic_hash).replace(/^0x/i, '').trim().toLowerCase();

    const pathConfigs = await db.recipientPaths.findByWallet(wallet_id);
    if (pathConfigs.length === 0) {
      return res.status(404).json({ error: 'Wallet path config not found' });
    }
    const rec = pathConfigs[0];
    const paths = rec.paths || [];
    const pathIndex = Number(path_index);
    const pathEntry = paths.find(p => p.index === pathIndex);
    if (!pathEntry) {
      return res.status(404).json({ error: 'Path not found' });
    }
    const recipientAddr = pathEntry.recipient_evm_address;
    if (!recipientAddr || normalizeAddr(recipientAddr) !== normalizeAddr(req.auth.pubkey)) {
      return res.status(403).json({ error: 'Only the designated recipient for this path can register mnemonic hash' });
    }

    const id = crypto.createHash('sha256').update(wallet_id).digest('hex').slice(0, 32);
    const updatedPaths = paths.map(p => {
      if (p.index !== pathIndex) return p;
      return { ...p, recipient_mnemonic_hash: hashNorm };
    });
    await db.recipientPaths.update(id, { ...rec, paths: updatedPaths });

    return res.json({ registered: true, wallet_id, path_index: pathIndex });
  } catch (err) {
    console.error('[claim/register-mnemonic-hash] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/plan-releases
 *
 * Dev/test: query recipientMnemonicAdmin by current user's evm_address, return records where AdminFactor is not empty.
 * Returns: { items: [ { evm_address, mnemonic_hash, admin_factor, label, plan_wallet_id } ] }
 */
router.get('/plan-releases', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const rows = await db.recipientMnemonicAdmin.findByEvmAddressWithAdminFactor(callerNorm);
    const items = rows.map((r) => ({
      evm_address: r.evm_address,
      mnemonic_hash: r.mnemonic_hash,
      admin_factor: r.admin_factor,
      label: r.label || 'Release',
      plan_wallet_id: r.plan_wallet_id || null,
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[claim/plan-releases] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/claim/update-wallet-json
 *
 * Dev/test: locate recipientMnemonicAdmin record by evm_address + mnemonic_hash, and write wallet_json to that record.
 * Body: { evm_address, mnemonic_hash, wallet_json }
 */
router.post('/update-wallet-json', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { evm_address, mnemonic_hash, wallet_json } = req.body || {};
    const hashNorm = normalizeAddr(String(mnemonic_hash || '').replace(/^0x/i, '').trim().toLowerCase());
    if (hashNorm.length !== 64 || !/^[0-9a-f]+$/.test(hashNorm)) {
      return res.status(400).json({ error: 'mnemonic_hash must be 64-char hex' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const evmNorm = normalizeAddr(evm_address || req.auth.pubkey);
    if (callerNorm !== evmNorm) {
      return res.status(403).json({ error: 'evm_address must match logged-in wallet' });
    }
    const record = await db.recipientMnemonicAdmin.findById(hashNorm);
    if (!record || normalizeAddr(record.evm_address) !== callerNorm) {
      return res.status(404).json({ error: 'No matching record for this mnemonic hash and wallet' });
    }
    const updated = { ...record, wallet_json: wallet_json || null };
    await db.recipientMnemonicAdmin.update(hashNorm, updated);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[claim/update-wallet-json] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/claim/get-admin-factor
 *
 * Dev/test: look up by evm_address + mnemonic_hash, return admin_factor if matched (does not delete the server record).
 * Body: { evm_address, mnemonic_hash }
 */
router.post('/get-admin-factor', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { evm_address, mnemonic_hash } = req.body || {};
    const hashNorm = normalizeAddr(String(mnemonic_hash || '').replace(/^0x/i, '').trim().toLowerCase());
    if (hashNorm.length !== 64 || !/^[0-9a-f]+$/.test(hashNorm)) {
      return res.status(400).json({ error: 'mnemonic_hash must be 64-char hex' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const evmNorm = normalizeAddr(evm_address || req.auth.pubkey);
    if (callerNorm !== evmNorm) {
      return res.status(403).json({ error: 'evm_address must match logged-in wallet' });
    }
    const record = await db.recipientMnemonicAdmin.findById(hashNorm);
    if (!record || normalizeAddr(record.evm_address) !== callerNorm) {
      return res.status(404).json({ error: 'No matching record for this mnemonic hash and wallet' });
    }
    if (!record.admin_factor || !String(record.admin_factor).trim()) {
      return res.status(404).json({ error: 'AdminFactor not yet linked for this recipient' });
    }
    return res.json({ admin_factor_hex: record.admin_factor });
  } catch (err) {
    console.error('[claim/get-admin-factor] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/me
 *
 * Recipient-only: returns all released blobs/factors for the logged-in recipient.
 * Caller is identified by req.auth.pubkey (recipient_evm_address). No Wallet ID or Path index needed from user.
 *
 * Data from two sources:
 * 1) Trigger flow: recipientPaths + triggers + releasedFactors (authority submitted release-factors).
 * 2) Plan flow: recipientMnemonicAdmin (authority linked AdminFactor via release link).
 *
 * Returns: { items: [ { wallet_id, path_index, label, admin_factor_hex, blob_hex?, recipient_mnemonic_hash?, source?: 'plan' } ] }
 */
router.get('/me', async (req, res) => {
  try {
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const callerNorm = normalizeAddr(req.auth.pubkey);
    const myEntries = [];

    // 1) Trigger flow: recipientPaths → triggers (released) → releasedFactors
    const allPathConfigs = await db.recipientPaths.findAll();
    for (const rec of allPathConfigs) {
      const walletId = rec.wallet_id;
      const paths = rec.paths || [];
      const myPaths = paths.filter(p => {
        const r = p.recipient_evm_address;
        return r && normalizeAddr(r) === callerNorm;
      });
      if (myPaths.length === 0) continue;

      const triggers = await db.triggers.findByWallet(walletId);
      const releasedTrigger = triggers.find(t => t.status === 'released');
      if (!releasedTrigger) continue;

      const releasedRecords = await db.releasedFactors.findByWallet(walletId);
      if (releasedRecords.length === 0) continue;

      const latestRelease = releasedRecords[releasedRecords.length - 1];
      for (const mp of myPaths) {
        const factor = latestRelease.factors.find(f => f.index === mp.index);
        if (!factor) continue;
        myEntries.push({
          wallet_id: walletId,
          path_index: mp.index,
          label: mp.label || `Recipient #${mp.index}`,
          admin_factor_hex: factor.admin_factor_hex,
          blob_hex: factor.blob_hex || null,
          recipient_mnemonic_hash: mp.recipient_mnemonic_hash || null,
          created_at: latestRelease.created_at || releasedTrigger.decided_at || null,
        });
      }
    }

    // 2) Plan flow: recipientMnemonicAdmin (AdminFactor linked via release link)
    //    Deduplicate: keep only the latest record per (plan_wallet_id, label).
    const planRows = await db.recipientMnemonicAdmin.findByEvmAddressWithAdminFactor(callerNorm);
    const planLatest = new Map(); // key = "walletId|label" → latest row
    for (const r of planRows) {
      const dedupeKey = (r.plan_wallet_id || '') + '|' + (r.label || 'Release');
      const existing = planLatest.get(dedupeKey);
      if (!existing || (r.created_at && (!existing.created_at || r.created_at > existing.created_at))) {
        planLatest.set(dedupeKey, r);
      }
    }
    for (const r of planLatest.values()) {
      // Look up the correct recipient index from recipientPaths
      let pathIndex = null;
      const planWalletNorm = normalizeAddr(r.plan_wallet_id || '');
      const recipientNorm = normalizeAddr(r.evm_address || '');
      if (planWalletNorm && recipientNorm) {
        for (const pc of allPathConfigs) {
          if (normalizeAddr(pc.wallet_id) === planWalletNorm && Array.isArray(pc.paths)) {
            const match = pc.paths.find(p =>
              p.recipient_evm_address && normalizeAddr(p.recipient_evm_address) === recipientNorm
            );
            if (match) { pathIndex = match.index; break; }
          }
        }
      }
      myEntries.push({
        wallet_id: r.plan_wallet_id || null,
        path_index: pathIndex,
        label: r.label || 'Release',
        admin_factor_hex: r.admin_factor,
        blob_hex: null,
        recipient_mnemonic_hash: r.mnemonic_hash || null,
        evm_address: r.evm_address || null,
        source: 'plan',
        created_at: r.created_at || null,
      });
    }

    return res.json({ items: myEntries });
  } catch (err) {
    console.error('[claim/me] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/escrow-config
 *
 * Return VaultShareEscrow + Vault addresses and chain info for frontend tx building.
 */
router.get('/escrow-config', (req, res) => {
  const escrowAddr = (config.escrow?.address || '').trim();
  const vaultAddr = (process.env.VAULT_ADDRESS || '').trim();
  const chainId = config.escrow?.chainId || '11155111';
  const rpcUrl = config.escrow?.rpcUrl || 'https://ethereum-sepolia-rpc.publicnode.com';
  const enabled = !!(escrowAddr && vaultAddr);
  return res.json({
    escrowAddress: escrowAddr,
    vaultAddress: vaultAddr,
    chainId,
    rpcUrl,
    enabled,
  });
});

/**
 * GET /api/claim/escrow-balance?walletId=...&recipientIndex=...
 *
 * Query VaultShareEscrow for a recipient's claimable balance.
 * Returns allocated shares, remaining shares, and underlying asset values.
 */
router.get('/escrow-balance', async (req, res) => {
  try {
    let walletId = (req.query.walletId || req.query.wallet_id || '').trim();
    const recipientIndex = parseInt(req.query.recipientIndex || req.query.recipient_index, 10);
    if (!walletId) {
      return res.status(400).json({ error: 'walletId is required' });
    }
    if (isNaN(recipientIndex) || recipientIndex < 0) {
      return res.status(400).json({ error: 'recipientIndex must be a non-negative integer' });
    }
    // Ensure 0x prefix for EVM addresses — plan_wallet_id may be stored without it,
    // but the escrow contract hashes the 0x-prefixed address.
    if (/^[0-9a-fA-F]{40}$/.test(walletId)) {
      walletId = '0x' + walletId;
    }
    const wHash = escrowContract.walletIdHash(walletId);
    const balance = await escrowContract.getRecipientBalance(config, wHash, recipientIndex);
    if (!balance) {
      return res.json({
        walletIdHash: wHash,
        recipientIndex,
        configured: false,
        error: 'VaultShareEscrow not configured or query failed',
      });
    }
    return res.json({
      walletIdHash: wHash,
      recipientIndex,
      configured: true,
      ...balance,
    });
  } catch (err) {
    console.error('[claim/escrow-balance] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/claim/by-mnemonic-hash?hash=...
 *
 * Look up released blobs by recipient mnemonic hash (no login). So mnemonic-hash and blob are tied:
 * recipient registers hash; at release, blob is stored with that hash; recipient can fetch blob by sending hash(mnemonic).
 * Returns: { items: [ { wallet_id, path_index, label, admin_factor_hex, blob_hex? } ] }
 */
router.get('/by-mnemonic-hash', async (req, res) => {
  try {
    const hashParam = (req.query.hash || req.query.mnemonic_hash || '').trim().replace(/^0x/i, '');
    if (!isValidMnemonicHash(hashParam)) {
      return res.status(400).json({ error: 'hash must be a 64-char hex string (mnemonic hash)' });
    }
    const hashNorm = hashParam.toLowerCase();

    const allPathConfigs = await db.recipientPaths.findAll();
    const myEntries = [];
    for (const rec of allPathConfigs) {
      const walletId = rec.wallet_id;
      const paths = rec.paths || [];
      const matchingPaths = paths.filter(p => p.recipient_mnemonic_hash && p.recipient_mnemonic_hash === hashNorm);
      if (matchingPaths.length === 0) continue;

      const triggers = await db.triggers.findByWallet(walletId);
      const releasedTrigger = triggers.find(t => t.status === 'released');
      if (!releasedTrigger) continue;

      const releasedRecords = await db.releasedFactors.findByWallet(walletId);
      if (releasedRecords.length === 0) continue;

      const latestRelease = releasedRecords[releasedRecords.length - 1];
      for (const mp of matchingPaths) {
        const factor = latestRelease.factors.find(f => f.index === mp.index);
        if (!factor) continue;
        myEntries.push({
          wallet_id: walletId,
          path_index: mp.index,
          label: mp.label || `Recipient #${mp.index}`,
          admin_factor_hex: factor.admin_factor_hex,
          blob_hex: factor.blob_hex || null,
        });
      }
    }

    return res.json({ items: myEntries });
  } catch (err) {
    console.error('[claim/by-mnemonic-hash] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:wallet_id', async (req, res) => {
  try {
    const { wallet_id } = req.params;
    if (!wallet_id) {
      return res.status(400).json({ error: 'wallet_id is required' });
    }

    // Security: verify caller is wallet owner or an authorized recipient
    const pathConfigs = await db.recipientPaths.findByWallet(wallet_id);
    const paths = pathConfigs.length > 0 ? pathConfigs[0].paths : [];
    if (!req.auth || !req.auth.pubkey) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!isAuthorized(req.auth.pubkey, wallet_id, paths)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'You can only view released factors for your own wallet or as an authorized recipient',
      });
    }

    // Check if there are released triggers for this wallet
    const triggers = await db.triggers.findByWallet(wallet_id);
    const releasedTrigger = triggers.find(t => t.status === 'released');

    if (!releasedTrigger) {
      return res.json({
        wallet_id,
        released: false,
        message: 'No released triggers found for this wallet. Contact the managing authority.',
        factors: [],
      });
    }

    // Get released factors
    const releasedRecords = await db.releasedFactors.findByWallet(wallet_id);
    if (releasedRecords.length === 0) {
      return res.json({
        wallet_id,
        released: true,
        message: 'Trigger is released but admin factors have not been submitted yet. Contact the managing authority.',
        factors: [],
      });
    }

    // Reuse path config from auth check for labels/weights
    const totalWeight = pathConfigs.length > 0 ? pathConfigs[0].total_weight : 0;

    // Merge released factors with path config (include blob_hex when stored)
    const latestRelease = releasedRecords[releasedRecords.length - 1];
    const factors = latestRelease.factors.map(f => {
      const pathInfo = paths.find(p => p.index === f.index);
      const out = {
        index: f.index,
        admin_factor_hex: f.admin_factor_hex,
        fingerprint: f.fingerprint,
        label: pathInfo ? pathInfo.label : `Recipient #${f.index}`,
        weight: pathInfo ? pathInfo.weight : 0,
        percentage: pathInfo ? pathInfo.percentage : '0.00',
        recipient_evm_address: pathInfo ? (pathInfo.recipient_evm_address || null) : null,
      };
      if (f.blob_hex) out.blob_hex = f.blob_hex;
      if (f.recipient_mnemonic_hash) out.recipient_mnemonic_hash = f.recipient_mnemonic_hash;
      return out;
    });

    // Try to get vault value from config (optional, best-effort)
    let vaultValue = null;
    try {
      const config = require('../../config');
      const vaultAddr = config.contracts?.vaultAddress;
      if (vaultAddr) {
        const vaultContract = require('../../services/vaultContract');
        const bal = await vaultContract.getVaultBalance(config, wallet_id.startsWith('0x') ? wallet_id : '0x' + wallet_id);
        if (bal && parseFloat(bal.assets) > 0) vaultValue = bal.assets;
      }
      if (vaultValue == null) vaultValue = '0.00';
    } catch {
      vaultValue = '0.00';
    }

    return res.json({
      wallet_id,
      released: true,
      trigger_id: releasedTrigger.trigger_id,
      factors,
      total_weight: totalWeight,
      vault_value: vaultValue,
    });
  } catch (err) {
    console.error('[claim/lookup] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
