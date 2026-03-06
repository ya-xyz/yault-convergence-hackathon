/**
 * Wallet Plan API — persist client-portal saved asset plan (per wallet + chain + token).
 *
 * GET /          - Get saved plan for authenticated wallet + chain + token
 *                  Query: ?chain=ethereum&token=WETH
 * GET /all       - Get all plans for authenticated wallet (any chain/token)
 * PUT /          - Save plan (body: { triggerTypes, recipients, triggerConfig, chain_key, token_symbol })
 *
 * Table: walletPlans. id = wallet_chain_token (lowercase), data = plan JSON.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../middleware/auth');
const db = require('../db');
const { encryptAdminFactorForXidentity } = require('../services/xidentityAdminFactor');

const router = Router();

// ---------------------------------------------------------------------------
// Encryption helper for admin_factor_hex at rest (shared module)
// ---------------------------------------------------------------------------
const { encryptAdminFactor } = require('../services/adminFactorCrypto');

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

/**
 * Build composite plan key: walletId_chainKey_tokenSymbol
 * Falls back to walletId alone for backward compatibility when chain/token missing.
 */
/**
 * Build composite plan prefix: walletId_chainKey_tokenSymbol
 * Used to query all plans for a given wallet+chain+token combo.
 */
function planPrefix(walletId, chainKey, tokenSymbol) {
  const c = (chainKey || 'ethereum').toLowerCase().trim();
  const t = (tokenSymbol || '').toUpperCase().trim();
  return `${walletId}_${c}_${t}`;
}

/**
 * Build unique plan key by appending a timestamp suffix.
 * Format: walletId_chain_token_ts (e.g. abc123_ethereum_ETH_1709500000000)
 */
function newPlanKey(walletId, chainKey, tokenSymbol) {
  return `${planPrefix(walletId, chainKey, tokenSymbol)}_${Date.now()}`;
}

/**
 * Ensure a plan record has a plan_id. Legacy plans without one get a
 * deterministic id derived from their storage key so downstream code
 * can always rely on plan.plan_id being present.
 */
function ensurePlanId(plan, storageKey) {
  if (plan && !plan.plan_id) {
    plan.plan_id = crypto.createHash('sha256').update(storageKey || '').digest('hex').slice(0, 32);
  }
  return plan;
}

function stripAdminFactorFromLink(link) {
  if (!link || typeof link !== 'string') return '';
  try {
    const u = new URL(link, 'http://localhost');
    u.searchParams.delete('AdminFactor');
    u.searchParams.delete('admin_factor');
    const out = u.pathname + (u.search || '');
    return /^[a-z]+:\/\//i.test(link) ? (u.origin + out) : out;
  } catch (_) {
    return link
      .replace(/([?&])(AdminFactor|admin_factor)=[^&]*/g, '$1')
      .replace(/[?&]$/, '');
  }
}

/** GET / — get all plans for wallet + chain + token (newest first) */
router.get('/', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const chainKey = (req.query.chain || '').trim();
    const tokenSymbol = (req.query.token || '').trim();
    const prefix = planPrefix(walletId, chainKey || 'ethereum', tokenSymbol || 'ETH');

    // Find all plan IDs that match the prefix (including legacy exact-match key)
    const allIds = await db.walletPlans.findAllIds();
    const matchingIds = allIds.filter(
      (id) => id === prefix || id.startsWith(prefix + '_')
    );

    // Legacy migration: if no plans found under new format, check legacy walletId-only key
    if (matchingIds.length === 0 && chainKey && tokenSymbol) {
      const legacy = await db.walletPlans.findById(walletId);
      if (legacy && !legacy._migrated) {
        const migrated = { ...legacy };
        migrated.chain_key = (chainKey || 'ethereum').toLowerCase();
        migrated.token_symbol = (tokenSymbol || 'ETH').toUpperCase();
        migrated.updatedAt = new Date().toISOString();
        const newKey = newPlanKey(walletId, chainKey, tokenSymbol);
        await db.walletPlans.create(newKey, migrated);
        // Mark legacy record
        legacy._migrated = true;
        await db.walletPlans.create(walletId, legacy);
        return res.json({ plan: migrated, plans: [migrated] });
      }
    }

    // Also check if old exact-match key exists (pre-multi-plan) and migrate it
    if (matchingIds.length === 1 && matchingIds[0] === prefix) {
      const oldPlan = await db.walletPlans.findById(prefix);
      if (oldPlan && !oldPlan._migratedToMulti) {
        // Copy to timestamped key, mark old one
        const ts = oldPlan.createdAt ? new Date(oldPlan.createdAt).getTime() : Date.now();
        const migratedKey = `${prefix}_${ts}`;
        await db.walletPlans.create(migratedKey, { ...oldPlan });
        oldPlan._migratedToMulti = true;
        await db.walletPlans.create(prefix, oldPlan);
        matchingIds.push(migratedKey);
      }
    }

    // Fetch all matching plans, filter out migration markers, ensure plan_id
    const plans = (await Promise.all(
      matchingIds.map(async (id) => {
        const p = await db.walletPlans.findById(id);
        return p ? ensurePlanId(p, id) : null;
      })
    )).filter((p) => p != null && !p._migratedToMulti);

    // Sort by createdAt descending (newest first)
    plans.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    // Return latest plan as `plan` for backward compat, plus full `plans` array
    const latest = plans.length > 0 ? plans[0] : null;
    return res.json({ plan: latest, plans });
  } catch (err) {
    console.error('[wallet-plan] GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /all — get all plans for wallet (any chain/token), sorted newest first */
router.get('/all', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const allIds = await db.walletPlans.findAllIds();
    const matchingIds = allIds.filter(
      (id) => id === walletId || id.startsWith(walletId + '_')
    );
    const plans = (await Promise.all(
      matchingIds.map(async (id) => {
        const p = await db.walletPlans.findById(id);
        return p ? ensurePlanId(p, id) : null;
      })
    )).filter((p) => p != null && !p._migrated && !p._migratedToMulti);

    plans.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    return res.json({ plans });
  } catch (err) {
    console.error('[wallet-plan] GET /all error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT / — create a new plan (always appends, never overwrites) */
router.put('/', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });

    const { triggerTypes, recipients, triggerConfig, chain_key, token_symbol } = req.body || {};
    const chainKey = (chain_key || '').trim().toLowerCase() || 'ethereum';
    const tokenSym = (token_symbol || '').trim().toUpperCase() || 'ETH';
    const key = newPlanKey(walletId, chainKey, tokenSym);

    const planId = crypto.randomBytes(16).toString('hex');
    const data = {
      plan_id: planId,
      triggerTypes: triggerTypes || {},
      recipients: Array.isArray(recipients) ? recipients : [],
      triggerConfig: triggerConfig || {},
      chain_key: chainKey,
      token_symbol: tokenSym,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await db.walletPlans.create(key, data);
    return res.json({ plan: data, plan_id: planId });
  } catch (err) {
    console.error('[wallet-plan] PUT error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /admin-factor — Receive AdminFactor, encrypt and persist for later authority retrieval */
router.post('/admin-factor', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });
    const { recipientIndex, label, admin_factor_hex } = req.body || {};

    if (!admin_factor_hex || typeof admin_factor_hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(admin_factor_hex)) {
      return res.status(400).json({ error: 'admin_factor_hex must be a 64-char hex string (32 bytes)' });
    }
    if (!Number.isInteger(recipientIndex) || recipientIndex < 1) {
      return res.status(400).json({ error: 'recipientIndex must be a positive integer' });
    }

    console.log('[wallet-plan] AdminFactor stored (for authority):', {
      walletId,
      recipientIndex,
      label,
      admin_factor_hex: '[REDACTED]',
    });

    // Compute fingerprint for verification
    const fingerprint = crypto.createHash('sha256')
      .update(Buffer.from(admin_factor_hex, 'hex'))
      .digest('hex');

    // Store encrypted AdminFactor keyed by walletId + recipientIndex
    const storageKey = `${walletId}_af_${recipientIndex}`;
    await db.walletAdminFactors.create(storageKey, {
      wallet_id: walletId,
      recipient_index: recipientIndex,
      label: label || `Recipient ${recipientIndex}`,
      admin_factor_hex: encryptAdminFactor(admin_factor_hex.toLowerCase()),
      fingerprint,
      created_at: new Date().toISOString(),
    });

    return res.json({ ok: true, fingerprint });
  } catch (err) {
    console.error('[wallet-plan] admin-factor error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /path-credentials — Dev only: logs mnemonic+passphrase; stores mnemonic_hash keyed by evm_address */
router.post('/path-credentials', dualAuthMiddleware, async (req, res) => {
  try {
    const walletId = normalizeAddr(req.auth.pubkey);
    if (!walletId) return res.status(401).json({ error: 'Authentication required' });
    const { recipientIndex, label, mnemonic, passphrase, mnemonic_hash: mnemonicHash, evm_address: evmAddress, admin_factor_hex: adminFactorHex } = req.body || {};
    console.log('[wallet-plan] path-credentials (dev only):', {
      walletId,
      recipientIndex,
      label,
      mnemonic: '[REDACTED]',
      passphrase: '[REDACTED]',
    });
    if (mnemonicHash && evmAddress) {
      const hashNorm = String(mnemonicHash).replace(/^0x/i, '').trim().toLowerCase();
      if (hashNorm.length === 64 && /^[0-9a-f]+$/.test(hashNorm)) {
        const recipientNorm = normalizeAddr(evmAddress);
        const recipientAddr = recipientNorm ? await db.walletAddresses.findById(recipientNorm) : null;
        const recipientXidentity = recipientAddr && recipientAddr.xidentity ? String(recipientAddr.xidentity).trim() : '';
        let encryptedAdminFactor = null;
        if (adminFactorHex && /^[0-9a-fA-F]{64}$/.test(adminFactorHex)) {
          if (!recipientXidentity) {
            return res.status(409).json({
              error: 'Recipient xidentity not found',
              detail: 'Recipient must save xidentity in profile before storing path credentials',
            });
          }
          encryptedAdminFactor = await encryptAdminFactorForXidentity(adminFactorHex, recipientXidentity);
        }
        await db.recipientMnemonicAdmin.create(hashNorm, {
          evm_address: evmAddress.startsWith('0x') ? evmAddress : '0x' + evmAddress,
          mnemonic_hash: hashNorm,
          admin_factor: null,
          encrypted_admin_factor: encryptedAdminFactor,
          encrypted_for_xidentity: recipientXidentity || null,
          label: label || `Recipient ${recipientIndex}`,
          plan_wallet_id: walletId,
          created_at: new Date().toISOString(),
        });
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[wallet-plan] path-credentials error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /send-release-link — Send AdminFactor release link as an “NFT message” to authority (stored in DB, authority can pull or open directly) */
router.post('/send-release-link', dualAuthMiddleware, async (req, res) => {
  try {
    const { authority_id, release_link, recipient_id, evm_address } = req.body || {};
    if (!authority_id || !release_link || !recipient_id) {
      return res.status(400).json({ error: 'authority_id, release_link, recipient_id are required' });
    }
    const sanitizedLink = stripAdminFactorFromLink(release_link);
    const id = require('crypto').randomBytes(16).toString('hex');
    await db.authorityReleaseLinks.create(id, {
      authority_id,
      release_link: sanitizedLink,
      recipient_id,
      evm_address: evm_address || null,
      created_at: new Date().toISOString(),
    });
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('[wallet-plan] send-release-link error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /recipient-addresses
 * Query: wallets=0x1,0x2 (EVM addresses) OR invite_ids=uuid1,uuid2 (invite record IDs).
 * Returns multi-chain addresses for those recipients (only current user's related accounts).
 * When using invite_ids, also returns inviteIdToEvm so client can map invite id -> evm -> addresses.
 */
router.get('/recipient-addresses', dualAuthMiddleware, async (req, res) => {
  try {
    const owner = normalizeAddr(req.auth.pubkey);
    if (!owner) return res.status(401).json({ error: 'Authentication required' });

    const walletsParam = (req.query.wallets || '').trim();
    const inviteIdsParam = (req.query.invite_ids || '').trim();
    if (!walletsParam && !inviteIdsParam) {
      return res.status(400).json({ error: 'wallets or invite_ids query is required (comma-separated)' });
    }

    const invites = await db.accountInvites.findByOwner(owner);
    const acceptedByEvm = new Map(); // normalized evm -> invite
    const acceptedById = new Map();  // invite id -> invite
    for (const i of invites) {
      if ((i.status || '') !== 'accepted') continue;
      const evm = normalizeAddr(i.linked_wallet_address || i.linkedWalletAddress);
      if (!evm) continue;
      acceptedByEvm.set(evm, i);
      acceptedById.set(i.id, i);
    }
    const allowed = new Set(acceptedByEvm.keys());

    let requested = [];
    const inviteIdToEvm = {};
    if (walletsParam) {
      requested = walletsParam.split(/[,\s]+/).map((w) => normalizeAddr(w.trim())).filter(Boolean);
    }
    if (inviteIdsParam) {
      const ids = inviteIdsParam.split(',').map((s) => s.trim()).filter(Boolean);
      for (const id of ids) {
        const inv = acceptedById.get(id);
        if (inv) {
          const evm = normalizeAddr(inv.linked_wallet_address || inv.linkedWalletAddress);
          if (evm) {
            requested.push(evm);
            inviteIdToEvm[id] = evm;
          }
        }
      }
    }
    requested = [...new Set(requested)];
    if (requested.length === 0) return res.status(400).json({ error: 'No valid wallets or invite_ids' });

    const addresses = {};
    for (const w of requested) {
      if (!allowed.has(w)) continue;
      const record = await db.walletAddresses.findById(w);
      const evmFormatted = w.startsWith('0x') ? w : '0x' + w;
      if (record && typeof record === 'object') {
        addresses[w] = {
          evm_address: record.evm_address || evmFormatted,
          solana_address: (record.solana_address && String(record.solana_address).trim()) || null,
          bitcoin_address: record.bitcoin_address || null,
          cosmos_address: record.cosmos_address || null,
          polkadot_address: record.polkadot_address || null,
          xidentity: (record.xidentity && String(record.xidentity).trim()) || null,
        };
      } else {
        addresses[w] = {
          evm_address: evmFormatted,
          solana_address: null,
          bitcoin_address: null,
          cosmos_address: null,
          polkadot_address: null,
          xidentity: null,
        };
      }
    }

    const payload = { addresses };
    if (Object.keys(inviteIdToEvm).length > 0) payload.inviteIdToEvm = inviteIdToEvm;
    return res.json(payload);
  } catch (err) {
    console.error('[wallet-plan] recipient-addresses error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
