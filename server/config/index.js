/**
 * Server configuration
 *
 * Network rule: npm run dev (NODE_ENV=development) → testnet (Sepolia, etc.);
 * otherwise → mainnet. Override with VAULT_CHAIN_ID / CHAIN_ID / EVM_RPC_URL.
 *
 * Environment variables:
 * - NODE_ENV=development  // Set by "npm run dev"; enables testnet defaults
 * - VAULT_CHAIN_ID        // Override chain (e.g. 11155111 Sepolia, 1 mainnet)
 * - CHAIN_ID              // Alias for VAULT_CHAIN_ID
 * - EVM_RPC_URL           // Override RPC
 * - DRAND_CHAIN_HASH      // drand mainnet chain hash
 * - ARWEAVE_GATEWAY       // Arweave gateway URL
 * - ARWEAVE_WALLET_JWK    // Arweave wallet for uploads
 * - DATABASE_URL          // D1 / Postgres connection
 * - EMAIL_API_KEY         // SendGrid / Resend API key
 * - JWT_SECRET            // Session token signing
 */

const chains = require('./chains');

// When vault is on a testnet, wallet balance queries use testnet RPCs (Sepolia, etc.).
const TESTNET_CHAIN_IDS = new Set([
  '11155111',   // Ethereum Sepolia
  '421614',     // Arbitrum Sepolia
  '11155420',   // OP Sepolia
  '84532',      // Base Sepolia
  '80002',      // Polygon Amoy
  '97',         // BSC testnet
  '43113',      // Avalanche Fuji
]);
function isTestnetChainId(chainId) {
  return TESTNET_CHAIN_IDS.has(String(chainId));
}

// npm run dev → NODE_ENV=development → testnet; otherwise default mainnet (env can override).
const isDev = process.env.NODE_ENV === 'development';
const defaultChainId = isDev ? '11155111' : '1';
const effectiveChainId = process.env.VAULT_CHAIN_ID || process.env.CHAIN_ID || defaultChainId;

module.exports = {
  chains,
  // Wallet balance queries: testnet when npm run dev (NODE_ENV=development), else mainnet unless VAULT_CHAIN_ID is testnet.
  useTestnet: isDev || isTestnetChainId(effectiveChainId),
  drand: {
    chainHash: process.env.DRAND_CHAIN_HASH || 'dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493',
    urls: ['https://api.drand.sh', 'https://drand.cloudflare.com'],
  },
  arweave: {
    gateway: process.env.ARWEAVE_GATEWAY || 'https://arweave.net',
    appName: 'Yault',
  },
  revenue: {
    userShareBps: 8000,     // 80%
    platformShareBps: 1500, // 15%
    authorityShareBps: 500,   // 5%
  },
  vault: {
    reserveRatioBps: parseInt(process.env.VAULT_RESERVE_RATIO_BPS, 10) || 2000, // 20% idle reserve
  },
  // Contract addresses and RPC — dev defaults to Sepolia, production to mainnet (env overrides).
  contracts: {
    vaultAddress: process.env.VAULT_ADDRESS || '',
    vaultChainId: process.env.VAULT_CHAIN_ID || process.env.CHAIN_ID || defaultChainId,
    evmRpcUrl: process.env.EVM_RPC_URL || process.env.RPC_ETHEREUM || process.env.ORACLE_RPC_URL || (isDev ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://eth.llamarpc.com'),
    underlyingDecimals: parseInt(process.env.VAULT_UNDERLYING_DECIMALS, 10) || 6,
    underlyingSymbol: (process.env.VAULT_UNDERLYING_SYMBOL || '').trim() || 'USDC',
  },
  // Oracle authority: Chainlink CRE writes attestations to ReleaseAttestation contract.
  // When set, platform prefers oracle attestation; entity authority is fallback.
  oracle: {
    enabled: process.env.ORACLE_ATTESTATION_ENABLED === 'true',
    rpcUrl: process.env.ORACLE_RPC_URL || process.env.RPC_ETHEREUM || (isDev ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://eth.llamarpc.com'),
    releaseAttestationAddress: process.env.RELEASE_ATTESTATION_ADDRESS || '',
    // Relayer key for submitting fallback attestations (must be setFallbackSubmitter(relayer, true) on contract).
    releaseAttestationRelayerPrivateKey: process.env.RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY || '',
    oracleAuthorityId: process.env.ORACLE_AUTHORITY_ID || null,
  },
  // Path claim pool: YaultPathClaim contract (deposit / registerPath / claim).
  pathClaim: {
    address: process.env.PATH_CLAIM_ADDRESS || '',
    assetAddress: process.env.PATH_CLAIM_ASSET_ADDRESS || '',
    chainId: process.env.PATH_CLAIM_CHAIN_ID || process.env.VAULT_CHAIN_ID || process.env.CHAIN_ID || defaultChainId,
    rpcUrl: process.env.PATH_CLAIM_RPC_URL || process.env.EVM_RPC_URL || process.env.ORACLE_RPC_URL || (isDev ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://eth.llamarpc.com'),
  },
  // Vault share escrow: VaultShareEscrow contract (hold vault shares, release by attestation).
  escrow: {
    address: process.env.VAULT_SHARE_ESCROW_ADDRESS || '',
    rpcUrl: process.env.ESCROW_RPC_URL || process.env.EVM_RPC_URL || process.env.ORACLE_RPC_URL || (isDev ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://eth.llamarpc.com'),
    chainId: process.env.ESCROW_CHAIN_ID || process.env.VAULT_CHAIN_ID || process.env.CHAIN_ID || defaultChainId,
  },
  // Public base URL for invite links (e.g. http://localhost:3001 or https://app.yault.xyz).
  // Used when printing invite link in console; production should send link via email (TODO).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:3001',

  // RWA: upload-and-mint API for delivering stored credential NFT after attestation release.
  rwa: {
    uploadAndMintApiUrl: process.env.RWA_UPLOAD_AND_MINT_API_URL || (isDev ? 'https://api-dev.yallet.xyz/api/v1/storage/rwa/upload-and-mint' : 'https://api.yallet.xyz/api/v1/storage/rwa/upload-and-mint'),
  },

  // Note: heartbeat/activity-detection config removed.
  // Triggers are now initiated by authorities via legal-event API.
  cooldown: {
    // If set, cooldown = this many minutes (e.g. 10 for demo). Otherwise use defaultHours.
    defaultMinutes: (() => {
      const raw = process.env.COOLDOWN_DEFAULT_MINUTES;
      if (raw === undefined || raw === '') return null;
      const n = parseInt(raw, 10);
      return (Number.isInteger(n) && n >= 0) ? n : null;
    })(),
    // Allow explicit 0 (immediate); default 168 (1 week). Supports fractional hours (e.g. 10/60 for 10 min).
    defaultHours: (() => {
      const raw = process.env.COOLDOWN_DEFAULT_HOURS;
      if (raw === undefined || raw === '') return 168;
      const n = parseFloat(raw);
      return (typeof n === 'number' && !Number.isNaN(n) && n >= 0) ? n : 168;
    })(),
    maxHours: (() => {
      const raw = process.env.COOLDOWN_MAX_HOURS;
      if (raw === undefined || raw === '') return 168;
      const n = parseInt(raw, 10);
      return (Number.isInteger(n) && n >= 0) ? n : 168;
    })(),
    minHours: 0,
  },

  // Trigger release safety: global pause, high-value wallets (dual attestation), fallback = emergency only.
  trigger: {
    releasePaused: process.env.TRIGGER_RELEASE_PAUSED === 'true',  // when true, cooldown finalizer does not release
    highValueWalletIds: (process.env.HIGH_VALUE_WALLET_IDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  // Campaign / Rebate — placeholder config for future referral and fee-waiver incentives.
  // Values here are env-driven defaults; runtime overrides live in db.campaigns.
  campaign: {
    defaultRebateBps: parseInt(process.env.REBATE_DEFAULT_BPS, 10) || 0,               // 0 = no rebate
    maxPerUserBps: parseInt(process.env.REBATE_MAX_PER_USER_BPS, 10) || 500,           // 5% cap
    referralYieldBoostBps: parseInt(process.env.REBATE_REFERRAL_YIELD_BOOST_BPS, 10) || 0,
    inviteeFeeWaiverDays: parseInt(process.env.REBATE_INVITEE_FEE_WAIVER_DAYS, 10) || 0,
  },
};
