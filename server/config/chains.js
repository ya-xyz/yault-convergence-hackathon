/**
 * chains.js — Multi-Chain Configuration Registry
 *
 * Central configuration for all supported blockchain networks.
 * Each chain entry provides RPC URLs, explorer APIs, native asset info,
 * and deployment addresses.
 *
 * Environment variable overrides:
 *   - RPC_<CHAIN_KEY>          e.g., RPC_ETHEREUM, RPC_ARBITRUM
 *   - EXPLORER_KEY_<CHAIN_KEY> e.g., EXPLORER_KEY_ETHEREUM
 *   - VAULT_<CHAIN_KEY>        e.g., VAULT_ETHEREUM (deployed vault address)
 *   - USDC_<CHAIN_KEY>         e.g., USDC_ETHEREUM (USDC token address)
 */

'use strict';

// ---------------------------------------------------------------------------
// Chain type enum
// ---------------------------------------------------------------------------

const ChainType = Object.freeze({
  EVM: 'evm',
  BITCOIN: 'bitcoin',
  SOLANA: 'solana',
});

// ---------------------------------------------------------------------------
// Chain definitions
// ---------------------------------------------------------------------------

const CHAINS = {
  // ─── EVM Chains ───────────────────────────────────────────────────────

  ethereum: {
    key: 'ethereum',
    name: 'Ethereum',
    type: ChainType.EVM,
    chainId: 1,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [
      process.env.RPC_ETHEREUM || 'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
      'https://ethereum.publicnode.com',
    ],
    explorerUrl: 'https://etherscan.io',
    explorerApi: 'https://api.etherscan.io/api',
    explorerApiKey: process.env.EXPLORER_KEY_ETHEREUM || '',
    usdc: process.env.USDC_ETHEREUM || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth: process.env.WETH_ETHEREUM || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc: process.env.WBTC_ETHEREUM || '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    vault: process.env.VAULT_ETHEREUM || null,
    testnet: {
      name: 'Sepolia',
      chainId: 11155111,
      // RPC: align with dev.yallet.proxy-api + dev.yallet.chrome-extension (ethereum.ts EVM_TESTNETS.sepolia)
      rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
      explorerUrl: 'https://sepolia.etherscan.io',
      explorerApi: 'https://api-sepolia.etherscan.io/api',
      // USDC: same as extension core/utils.ts TESTNET_TOKENS.sepolia.USDC (Circle Sepolia)
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      weth: process.env.WETH_SEPOLIA || '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
      wbtc: process.env.WBTC_SEPOLIA || null,
    },
    enabled: true,
  },

  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    type: ChainType.EVM,
    chainId: 42161,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [
      process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
      'https://rpc.ankr.com/arbitrum',
      'https://arbitrum-one.publicnode.com',
    ],
    explorerUrl: 'https://arbiscan.io',
    explorerApi: 'https://api.arbiscan.io/api',
    explorerApiKey: process.env.EXPLORER_KEY_ARBITRUM || '',
    usdc: process.env.USDC_ARBITRUM || '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    vault: process.env.VAULT_ARBITRUM || null,
    testnet: {
      name: 'Arbitrum Sepolia',
      chainId: 421614,
      rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
      explorerUrl: 'https://sepolia.arbiscan.io',
      explorerApi: 'https://api-sepolia.arbiscan.io/api',
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    },
    enabled: true,
  },

  optimism: {
    key: 'optimism',
    name: 'Optimism',
    type: ChainType.EVM,
    chainId: 10,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [
      process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
      'https://rpc.ankr.com/optimism',
      'https://optimism.publicnode.com',
    ],
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerApi: 'https://api-optimistic.etherscan.io/api',
    explorerApiKey: process.env.EXPLORER_KEY_OPTIMISM || '',
    usdc: process.env.USDC_OPTIMISM || '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    vault: process.env.VAULT_OPTIMISM || null,
    testnet: {
      name: 'OP Sepolia',
      chainId: 11155420,
      rpcUrls: ['https://sepolia.optimism.io'],
      explorerUrl: 'https://sepolia-optimistic.etherscan.io',
      explorerApi: 'https://api-sepolia-optimistic.etherscan.io/api',
      usdc: null,
    },
    enabled: true,
  },

  base: {
    key: 'base',
    name: 'Base',
    type: ChainType.EVM,
    chainId: 8453,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [
      process.env.RPC_BASE || 'https://mainnet.base.org',
      'https://rpc.ankr.com/base',
      'https://base.publicnode.com',
    ],
    explorerUrl: 'https://basescan.org',
    explorerApi: 'https://api.basescan.org/api',
    explorerApiKey: process.env.EXPLORER_KEY_BASE || '',
    usdc: process.env.USDC_BASE || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    vault: process.env.VAULT_BASE || null,
    testnet: {
      name: 'Base Sepolia',
      chainId: 84532,
      rpcUrls: ['https://sepolia.base.org'],
      explorerUrl: 'https://sepolia.basescan.org',
      explorerApi: 'https://api-sepolia.basescan.org/api',
      usdc: null,
    },
    enabled: true,
  },

  polygon: {
    key: 'polygon',
    name: 'Polygon',
    type: ChainType.EVM,
    chainId: 137,
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: [
      process.env.RPC_POLYGON || 'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon-bor.publicnode.com',
    ],
    explorerUrl: 'https://polygonscan.com',
    explorerApi: 'https://api.polygonscan.com/api',
    explorerApiKey: process.env.EXPLORER_KEY_POLYGON || '',
    usdc: process.env.USDC_POLYGON || '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    vault: process.env.VAULT_POLYGON || null,
    testnet: {
      name: 'Polygon Amoy',
      chainId: 80002,
      rpcUrls: ['https://rpc-amoy.polygon.technology'],
      explorerUrl: 'https://amoy.polygonscan.com',
      explorerApi: 'https://api-amoy.polygonscan.com/api',
      usdc: null,
    },
    enabled: true,
  },

  bsc: {
    key: 'bsc',
    name: 'BNB Smart Chain',
    type: ChainType.EVM,
    chainId: 56,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: [
      process.env.RPC_BSC || 'https://bsc-dataseed.binance.org',
      'https://rpc.ankr.com/bsc',
      'https://bsc.publicnode.com',
    ],
    explorerUrl: 'https://bscscan.com',
    explorerApi: 'https://api.bscscan.com/api',
    explorerApiKey: process.env.EXPLORER_KEY_BSC || '',
    usdc: process.env.USDC_BSC || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    vault: process.env.VAULT_BSC || null,
    testnet: {
      name: 'BSC Testnet',
      chainId: 97,
      rpcUrls: ['https://data-seed-prebsc-1-s1.binance.org:8545'],
      explorerUrl: 'https://testnet.bscscan.com',
      explorerApi: 'https://api-testnet.bscscan.com/api',
      usdc: null,
    },
    enabled: true,
  },

  avalanche: {
    key: 'avalanche',
    name: 'Avalanche C-Chain',
    type: ChainType.EVM,
    chainId: 43114,
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: [
      process.env.RPC_AVALANCHE || 'https://api.avax.network/ext/bc/C/rpc',
      'https://rpc.ankr.com/avalanche',
      'https://avalanche-c-chain.publicnode.com',
    ],
    explorerUrl: 'https://snowtrace.io',
    explorerApi: 'https://api.snowtrace.io/api',
    explorerApiKey: process.env.EXPLORER_KEY_AVALANCHE || '',
    usdc: process.env.USDC_AVALANCHE || '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    vault: process.env.VAULT_AVALANCHE || null,
    testnet: {
      name: 'Avalanche Fuji',
      chainId: 43113,
      rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc'],
      explorerUrl: 'https://testnet.snowtrace.io',
      explorerApi: 'https://api-testnet.snowtrace.io/api',
      usdc: null,
    },
    enabled: true,
  },

  // ─── Bitcoin ──────────────────────────────────────────────────────────

  bitcoin: {
    key: 'bitcoin',
    name: 'Bitcoin',
    type: ChainType.BITCOIN,
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 8 },
    apis: {
      mempool: process.env.MEMPOOL_API || 'https://mempool.space/api',
      blockstream: 'https://blockstream.info/api',
    },
    explorerUrl: 'https://mempool.space',
    testnet: {
      name: 'Bitcoin Testnet',
      apis: {
        mempool: 'https://mempool.space/testnet/api',
        blockstream: 'https://blockstream.info/testnet/api',
      },
      explorerUrl: 'https://mempool.space/testnet',
    },
    enabled: true,
  },

  // ─── Solana ───────────────────────────────────────────────────────────

  solana: {
    key: 'solana',
    name: 'Solana',
    type: ChainType.SOLANA,
    nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
    rpcUrls: [
      process.env.RPC_SOLANA || 'https://api.mainnet-beta.solana.com',
      'https://solana-mainnet.rpc.extrnode.com',
    ],
    explorerUrl: 'https://solscan.io',
    usdc: process.env.USDC_SOLANA || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    testnet: {
      name: 'Solana Devnet',
      rpcUrls: ['https://api.devnet.solana.com'],
      explorerUrl: 'https://solscan.io?cluster=devnet',
      usdc: null,
    },
    enabled: true,
  },
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Get chain config by key.
 * @param {string} chainKey - e.g., 'ethereum', 'arbitrum', 'bitcoin'
 * @returns {object|null}
 */
function getChain(chainKey) {
  return CHAINS[chainKey] || null;
}

/**
 * Get chain config by EVM chain ID.
 * @param {number} chainId
 * @returns {object|null}
 */
function getChainByChainId(chainId) {
  return Object.values(CHAINS).find(
    (c) => c.type === ChainType.EVM && c.chainId === chainId
  ) || null;
}

/**
 * Get all enabled chains.
 * @returns {object[]}
 */
function getEnabledChains() {
  return Object.values(CHAINS).filter((c) => c.enabled);
}

/**
 * Get all enabled EVM chains.
 * @returns {object[]}
 */
function getEVMChains() {
  return Object.values(CHAINS).filter(
    (c) => c.type === ChainType.EVM && c.enabled
  );
}

/**
 * Get the primary RPC URL for a chain (first in the list).
 * @param {string} chainKey
 * @param {boolean} [useTestnet=false]
 * @returns {string|null}
 */
function getRpcUrl(chainKey, useTestnet = false) {
  const chain = CHAINS[chainKey];
  if (!chain) return null;
  if (useTestnet && chain.testnet?.rpcUrls) {
    return chain.testnet.rpcUrls[0];
  }
  return chain.rpcUrls?.[0] || null;
}

/**
 * Get the USDC address for a chain.
 * @param {string} chainKey
 * @param {boolean} [useTestnet=false]
 * @returns {string|null}
 */
function getUsdcAddress(chainKey, useTestnet = false) {
  const chain = CHAINS[chainKey];
  if (!chain) return null;
  if (useTestnet) return chain.testnet?.usdc || null;
  return chain.usdc || null;
}

/**
 * Build a chain summary for API responses.
 * @returns {object[]} Array of { key, name, type, chainId?, enabled }
 */
function getChainSummary() {
  return Object.values(CHAINS).map((c) => ({
    key: c.key,
    name: c.name,
    type: c.type,
    chainId: c.chainId || null,
    nativeCurrency: c.nativeCurrency,
    explorerUrl: c.explorerUrl,
    hasVault: !!c.vault,
    enabled: c.enabled,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CHAINS,
  ChainType,
  getChain,
  getChainByChainId,
  getEnabledChains,
  getEVMChains,
  getRpcUrl,
  getUsdcAddress,
  getChainSummary,
};
