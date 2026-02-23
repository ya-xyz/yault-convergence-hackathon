/**
 * insuranceProvider.js — DeFi Insurance Protocol Integration
 *
 * Provides a unified interface for querying cover quotes, purchasing
 * coverage, and checking claim status across DeFi insurance protocols.
 *
 * Supported protocols:
 *   - Nexus Mutual (primary) — smart contract cover on Ethereum
 *   - OpenCover (Nexus Mutual distributor) — multi-chain cover
 *
 * Coverage types relevant to Yault:
 *   - Smart contract exploit (YaultVault, Aave V3)
 *   - Cross-chain bridge failure
 *   - Oracle/protocol failure
 *   - Custodian risk (authority key compromise)
 *
 * Environment variables:
 *   - NEXUS_MUTUAL_API_URL     (default: https://api.nexusmutual.io/v2)
 *   - OPENCOVER_API_URL        (default: https://api.opencover.com/v1)
 *   - INSURANCE_ENABLED        (default: true)
 */

'use strict';

const { CHAINS, ChainType } = require('../config/chains');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NEXUS_API = process.env.NEXUS_MUTUAL_API_URL || 'https://api.nexusmutual.io/v2';
const OPENCOVER_API = process.env.OPENCOVER_API_URL || 'https://api.opencover.com/v1';
const INSURANCE_ENABLED = process.env.INSURANCE_ENABLED !== 'false';

/**
 * Coverage types supported by the platform.
 */
const CoverageType = Object.freeze({
  SMART_CONTRACT:   'smart_contract',    // YaultVault or Aave exploit
  BRIDGE_FAILURE:   'bridge_failure',    // Cross-chain bridge hack
  PROTOCOL_FAILURE: 'protocol_failure',  // Aave V3, drand, Arweave failure
  CUSTODIAN_RISK:   'custodian_risk',    // Authority key compromise
});

/**
 * Known contract addresses for coverage (per chain).
 * Maps chain key → array of coverable protocols.
 */
const COVERABLE_PROTOCOLS = {
  ethereum: [
    { name: 'Aave V3',       address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', type: CoverageType.SMART_CONTRACT },
    { name: 'YaultVault',   address: null, type: CoverageType.SMART_CONTRACT }, // filled from chain config
  ],
  arbitrum: [
    { name: 'Aave V3',       address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', type: CoverageType.SMART_CONTRACT },
    { name: 'YaultVault',   address: null, type: CoverageType.SMART_CONTRACT },
  ],
  optimism: [
    { name: 'Aave V3',       address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', type: CoverageType.SMART_CONTRACT },
  ],
  base: [
    { name: 'Aave V3',       address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', type: CoverageType.SMART_CONTRACT },
  ],
  polygon: [
    { name: 'Aave V3',       address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', type: CoverageType.SMART_CONTRACT },
  ],
};

// ---------------------------------------------------------------------------
// Internal: HTTP helper
// ---------------------------------------------------------------------------

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Nexus Mutual Integration
// ---------------------------------------------------------------------------

/**
 * Get available cover products from Nexus Mutual.
 * @returns {Promise<object[]>} List of coverable products
 */
async function getNexusProducts() {
  return fetchJson(`${NEXUS_API}/cover-products`);
}

/**
 * Get a cover quote from Nexus Mutual.
 *
 * @param {object} params
 * @param {number} params.productId - Nexus Mutual product ID
 * @param {number} params.coverAmount - Amount to cover (in asset units)
 * @param {string} params.coverAsset - Asset symbol ('ETH', 'DAI', 'USDC')
 * @param {number} params.period - Coverage period in days (28-365)
 * @param {string} params.coverAddress - Address of the contract to cover
 * @returns {Promise<object>} Quote with premium and coverage details
 */
async function getNexusQuote({ productId, coverAmount, coverAsset, period, coverAddress }) {
  const params = new URLSearchParams({
    productId: String(productId),
    coverAmount: String(coverAmount),
    coverAsset: coverAsset || 'USDC',
    period: String(period || 90),
    coverAddress: coverAddress || '',
  });

  return fetchJson(`${NEXUS_API}/quote?${params}`);
}

/**
 * Get cover details for a specific cover ID.
 * @param {string} coverId
 * @returns {Promise<object>}
 */
async function getNexusCover(coverId) {
  return fetchJson(`${NEXUS_API}/covers/${coverId}`);
}

// ---------------------------------------------------------------------------
// OpenCover Integration (multi-chain, built on Nexus Mutual capital)
// ---------------------------------------------------------------------------

/**
 * Get a cover quote from OpenCover (supports more chains).
 *
 * @param {object} params
 * @param {string} params.protocol - Protocol name (e.g., 'aave-v3')
 * @param {string} params.chain - Chain name (e.g., 'ethereum', 'arbitrum')
 * @param {number} params.amount - Coverage amount in USD
 * @param {number} params.period - Coverage period in days
 * @returns {Promise<object>}
 */
async function getOpenCoverQuote({ protocol, chain, amount, period }) {
  return fetchJson(`${OPENCOVER_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol,
      chain,
      coverAmount: amount,
      coverPeriod: period || 90,
      coverCurrency: 'USDC',
    }),
  });
}

// ---------------------------------------------------------------------------
// Unified Insurance Interface
// ---------------------------------------------------------------------------

/**
 * Get coverage options for a user's portfolio.
 * Queries multiple insurance protocols and aggregates quotes.
 *
 * @param {object} params
 * @param {string[]} params.chains - Chain keys to cover (e.g., ['ethereum', 'arbitrum'])
 * @param {number} params.totalValueUsd - Total portfolio value in USD
 * @param {number} params.periodDays - Coverage period (default: 90)
 * @returns {Promise<{
 *   available: boolean,
 *   quotes: object[],
 *   coverageTypes: string[],
 *   estimatedPremiumUsd: number,
 * }>}
 */
async function getCoverageOptions({ chains, totalValueUsd, periodDays = 90 }) {
  if (!INSURANCE_ENABLED) {
    return {
      available: false,
      quotes: [],
      coverageTypes: [],
      estimatedPremiumUsd: 0,
      message: 'Insurance integration is disabled',
    };
  }

  const quotes = [];
  const errors = [];

  // Query Nexus Mutual for each chain's protocols
  for (const chainKey of chains) {
    const protocols = COVERABLE_PROTOCOLS[chainKey] || [];
    for (const protocol of protocols) {
      try {
        // Try OpenCover first (better multi-chain support)
        const quote = await getOpenCoverQuote({
          protocol: protocol.name.toLowerCase().replace(/\s+/g, '-'),
          chain: chainKey,
          amount: totalValueUsd,
          period: periodDays,
        });

        quotes.push({
          provider: 'opencover',
          chain: chainKey,
          protocol: protocol.name,
          coverageType: protocol.type,
          coverAmount: totalValueUsd,
          periodDays,
          premiumUsd: quote.premium || quote.price || 0,
          currency: 'USDC',
          quoteId: quote.quoteId || quote.id || null,
          expiresAt: quote.expiresAt || null,
        });
      } catch (err) {
        errors.push({ chain: chainKey, protocol: protocol.name, error: err.message });
      }
    }
  }

  // Calculate total estimated premium
  const estimatedPremiumUsd = quotes.reduce((sum, q) => sum + (q.premiumUsd || 0), 0);

  return {
    available: quotes.length > 0,
    quotes,
    coverageTypes: [...new Set(quotes.map((q) => q.coverageType))],
    estimatedPremiumUsd,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Purchase insurance coverage.
 *
 * @param {object} params
 * @param {string} params.quoteId - Quote ID from getCoverageOptions
 * @param {string} params.provider - Insurance provider ('nexus', 'opencover')
 * @param {string} params.walletAddress - User's wallet address
 * @param {string} params.paymentTxHash - On-chain payment transaction hash
 * @returns {Promise<object>} Purchase confirmation with policy ID
 */
async function purchaseCoverage({ quoteId, provider, walletAddress, paymentTxHash }) {
  if (!INSURANCE_ENABLED) {
    throw new Error('Insurance integration is disabled');
  }

  if (provider === 'opencover') {
    return fetchJson(`${OPENCOVER_API}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteId,
        buyer: walletAddress,
        paymentTx: paymentTxHash,
      }),
    });
  }

  if (provider === 'nexus') {
    // Nexus Mutual purchases happen on-chain directly
    // We just record the policy after the user buys on-chain
    return {
      provider: 'nexus',
      status: 'pending_onchain',
      message: 'Nexus Mutual cover must be purchased on-chain. Submit the cover ID after purchase.',
    };
  }

  throw new Error(`Unknown insurance provider: ${provider}`);
}

/**
 * Check the status of an insurance policy.
 *
 * @param {string} policyId - Policy/cover ID
 * @param {string} provider - Insurance provider
 * @returns {Promise<object>} Policy status
 */
async function getPolicyStatus(policyId, provider) {
  if (provider === 'opencover') {
    return fetchJson(`${OPENCOVER_API}/policies/${policyId}`);
  }

  if (provider === 'nexus') {
    return getNexusCover(policyId);
  }

  throw new Error(`Unknown insurance provider: ${provider}`);
}

/**
 * File an insurance claim.
 *
 * @param {object} params
 * @param {string} params.policyId - Policy/cover ID
 * @param {string} params.provider - Insurance provider
 * @param {string} params.incidentDescription - Description of the incident
 * @param {string} params.evidenceHash - SHA-256 hash of evidence
 * @param {number} params.claimAmount - Amount being claimed
 * @returns {Promise<object>} Claim submission result
 */
async function fileClaim({ policyId, provider, incidentDescription, evidenceHash, claimAmount }) {
  if (provider === 'opencover') {
    return fetchJson(`${OPENCOVER_API}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policyId,
        description: incidentDescription,
        evidenceHash,
        amount: claimAmount,
      }),
    });
  }

  if (provider === 'nexus') {
    // Nexus Mutual claims are on-chain governance votes
    return {
      provider: 'nexus',
      status: 'requires_onchain_submission',
      message: 'Nexus Mutual claims must be submitted on-chain through governance.',
      governanceUrl: 'https://app.nexusmutual.io/assessment',
    };
  }

  throw new Error(`Unknown insurance provider: ${provider}`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CoverageType,
  COVERABLE_PROTOCOLS,
  getCoverageOptions,
  purchaseCoverage,
  getPolicyStatus,
  fileClaim,
  getNexusProducts,
  getNexusQuote,
  getOpenCoverQuote,
  INSURANCE_ENABLED,
};
