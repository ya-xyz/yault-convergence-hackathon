/**
 * server/api/insurance/index.js — Insurance API
 *
 * Provides endpoints for DeFi insurance integration:
 *   GET  /quote          → Get coverage quotes for user's portfolio
 *   POST /purchase       → Purchase insurance coverage
 *   GET  /policies       → List user's insurance policies
 *   GET  /policies/:id   → Get specific policy status
 *   POST /claim          → File an insurance claim
 *
 * All endpoints require wallet authentication.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../../middleware/auth');
const db = require('../../db');
const {
  getCoverageOptions,
  purchaseCoverage,
  getPolicyStatus,
  fileClaim,
  CoverageType,
  INSURANCE_ENABLED,
} = require('../../services/insuranceProvider');
const { getEnabledChains } = require('../../config/chains');

const router = Router();

// ─── GET /quote — Get coverage quotes ───

router.get('/quote', authMiddleware, async (req, res) => {
  try {
    if (!INSURANCE_ENABLED) {
      return res.json({
        available: false,
        message: 'Insurance integration is not yet enabled',
      });
    }

    const totalValueUsd = parseFloat(req.query.value_usd) || 0;
    if (totalValueUsd <= 0) {
      return res.status(400).json({ error: 'value_usd must be a positive number' });
    }

    const periodDays = parseInt(req.query.period_days, 10) || 90;
    if (periodDays < 28 || periodDays > 365) {
      return res.status(400).json({ error: 'period_days must be between 28 and 365' });
    }

    // Determine which chains to cover
    const chainsParam = req.query.chains;
    let chains;
    if (chainsParam) {
      chains = chainsParam.split(',').map((c) => c.trim());
    } else {
      // Default: all enabled EVM chains
      chains = getEnabledChains()
        .filter((c) => c.type === 'evm')
        .map((c) => c.key);
    }

    const options = await getCoverageOptions({
      chains,
      totalValueUsd,
      periodDays,
    });

    res.json(options);
  } catch (err) {
    console.error('[insurance/quote] Error:', err.message);
    res.status(500).json({ error: 'Failed to get insurance quotes' });
  }
});

// ─── POST /purchase — Purchase coverage ───

router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const { quote_id, provider, payment_tx_hash } = req.body || {};

    if (!quote_id) {
      return res.status(400).json({ error: 'quote_id is required' });
    }
    if (!provider || !['nexus', 'opencover'].includes(provider)) {
      return res.status(400).json({ error: 'provider must be "nexus" or "opencover"' });
    }

    const walletAddress = req.auth.pubkey;

    // Call insurance provider
    const result = await purchaseCoverage({
      quoteId: quote_id,
      provider,
      walletAddress,
      paymentTxHash: payment_tx_hash || null,
    });

    // Store policy record locally
    const policyId = result.policyId || result.coverId || crypto.randomBytes(16).toString('hex');
    const policyRecord = {
      policy_id: policyId,
      provider,
      wallet_address: walletAddress,
      quote_id: quote_id,
      payment_tx_hash: payment_tx_hash || null,
      status: result.status || 'active',
      cover_amount: result.coverAmount || null,
      premium_paid: result.premiumPaid || null,
      currency: result.currency || 'USDC',
      period_days: result.periodDays || null,
      starts_at: Date.now(),
      expires_at: result.expiresAt || null,
      created_at: Date.now(),
      provider_response: result,
    };

    await db.insurancePolicies.create(policyId, policyRecord);

    // Audit log
    await db.auditLog.create(`insurance_purchase_${policyId}`, {
      type: 'INSURANCE_PURCHASED',
      policy_id: policyId,
      provider,
      wallet_address: walletAddress,
      created_at: Date.now(),
    }).catch(() => {});

    res.status(201).json({
      policy_id: policyId,
      provider,
      status: policyRecord.status,
      message: 'Insurance policy created',
    });
  } catch (err) {
    console.error('[insurance/purchase] Error:', err.message);
    res.status(500).json({ error: 'Failed to purchase insurance coverage' });
  }
});

// ─── GET /policies — List user's policies ───

router.get('/policies', authMiddleware, async (req, res) => {
  try {
    const walletAddress = req.auth.pubkey;
    const policies = await db.insurancePolicies.findWhere(
      (p) => p.wallet_address === walletAddress
    );

    res.json({
      policies: policies.map((p) => ({
        policy_id: p.policy_id,
        provider: p.provider,
        status: p.status,
        cover_amount: p.cover_amount,
        premium_paid: p.premium_paid,
        currency: p.currency,
        starts_at: p.starts_at,
        expires_at: p.expires_at,
        is_active: p.status === 'active' && (!p.expires_at || p.expires_at > Date.now()),
      })),
      total: policies.length,
    });
  } catch (err) {
    console.error('[insurance/policies] Error:', err.message);
    res.status(500).json({ error: 'Failed to list insurance policies' });
  }
});

// ─── GET /policies/:id — Get policy status ───

router.get('/policies/:id', authMiddleware, async (req, res) => {
  try {
    const policy = await db.insurancePolicies.findById(req.params.id);
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Verify ownership
    if (policy.wallet_address !== req.auth.pubkey) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Optionally refresh status from provider
    let providerStatus = null;
    if (req.query.refresh === 'true') {
      try {
        providerStatus = await getPolicyStatus(policy.policy_id, policy.provider);
        // Update local status
        if (providerStatus.status) {
          policy.status = providerStatus.status;
          await db.insurancePolicies.update(policy.policy_id, policy);
        }
      } catch {
        // Provider query failure is non-fatal
      }
    }

    res.json({
      ...policy,
      is_active: policy.status === 'active' && (!policy.expires_at || policy.expires_at > Date.now()),
      provider_status: providerStatus,
    });
  } catch (err) {
    console.error('[insurance/policies/:id] Error:', err.message);
    res.status(500).json({ error: 'Failed to get policy status' });
  }
});

// ─── POST /claim — File insurance claim ───

router.post('/claim', authMiddleware, async (req, res) => {
  try {
    const { policy_id, description, evidence_hash, claim_amount } = req.body || {};

    if (!policy_id) {
      return res.status(400).json({ error: 'policy_id is required' });
    }
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return res.status(400).json({ error: 'description is required (min 10 characters)' });
    }
    if (!evidence_hash || !/^[0-9a-fA-F]{64}$/.test(evidence_hash)) {
      return res.status(400).json({ error: 'evidence_hash must be a 64-character SHA-256 hex' });
    }
    if (!claim_amount || typeof claim_amount !== 'number' || claim_amount <= 0) {
      return res.status(400).json({ error: 'claim_amount must be a positive number' });
    }

    // Verify policy exists and is owned by caller
    const policy = await db.insurancePolicies.findById(policy_id);
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    if (policy.wallet_address !== req.auth.pubkey) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (policy.status !== 'active') {
      return res.status(400).json({ error: `Policy is not active (status: ${policy.status})` });
    }

    // File claim with provider
    const result = await fileClaim({
      policyId: policy_id,
      provider: policy.provider,
      incidentDescription: description.trim(),
      evidenceHash: evidence_hash,
      claimAmount: claim_amount,
    });

    // Store claim record
    const claimId = result.claimId || crypto.randomBytes(16).toString('hex');
    const claimRecord = {
      claim_id: claimId,
      policy_id,
      provider: policy.provider,
      wallet_address: req.auth.pubkey,
      description: description.trim(),
      evidence_hash,
      claim_amount,
      status: result.status || 'submitted',
      provider_response: result,
      created_at: Date.now(),
    };

    await db.insurancePolicies.create(`claim_${claimId}`, claimRecord);

    // Audit log
    await db.auditLog.create(`insurance_claim_${claimId}`, {
      type: 'INSURANCE_CLAIM_FILED',
      claim_id: claimId,
      policy_id,
      wallet_address: req.auth.pubkey,
      claim_amount,
      created_at: Date.now(),
    }).catch(() => {});

    res.status(201).json({
      claim_id: claimId,
      policy_id,
      status: claimRecord.status,
      provider_info: result,
      message: 'Claim submitted successfully',
    });
  } catch (err) {
    console.error('[insurance/claim] Error:', err.message);
    res.status(500).json({ error: 'Failed to file insurance claim' });
  }
});

// ─── GET /coverage-types — List available coverage types ───

router.get('/coverage-types', (_req, res) => {
  res.json({
    types: Object.entries(CoverageType).map(([key, value]) => ({
      key: value,
      name: key.replace(/_/g, ' ').toLowerCase(),
    })),
    providers: [
      { key: 'nexus', name: 'Nexus Mutual', url: 'https://nexusmutual.io' },
      { key: 'opencover', name: 'OpenCover', url: 'https://opencover.com' },
    ],
    enabled: INSURANCE_ENABLED,
  });
});

module.exports = router;
