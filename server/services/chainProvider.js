/**
 * chainProvider.js — Multi-Chain Balance & Transaction Service
 *
 * Provides a unified interface for querying balances and broadcasting
 * transactions across all supported chains (EVM, Bitcoin, Solana).
 *
 * Usage:
 *   const { getMultiChainBalances, getEvmBalance } = require('./chainProvider');
 *   const balances = await getMultiChainBalances(addresses);
 */

'use strict';

const { CHAINS, ChainType, getEVMChains } = require('../config/chains');

// Per-request RPC timeout for balance queries (public RPCs are often slow; keep low to avoid hanging)
const BALANCE_RPC_TIMEOUT_MS = 5000;
// Overall timeout for multi-chain balance: return partial results after this (avoid waiting for slowest chain)
const MULTICHAIN_OVERALL_TIMEOUT_MS = 10000;

function isValidEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

// ---------------------------------------------------------------------------
// Internal: JSON-RPC helper with timeout + fallback
// ---------------------------------------------------------------------------

/**
 * Fetch JSON with timeout.
 * @param {string} url
 * @param {object} [options]
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make a JSON-RPC call with automatic fallback to next RPC URL on failure.
 * @param {string[]} rpcUrls
 * @param {string} method
 * @param {any[]} params
 * @param {number} [timeoutMs] - per-request timeout (default 10000)
 * @returns {Promise<any>}
 */
async function jsonRpcCall(rpcUrls, method, params, timeoutMs = 10000) {
  let lastError;
  for (const url of rpcUrls) {
    try {
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }, timeoutMs);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.result;
    } catch (err) {
      lastError = err;
      // Try next RPC URL
    }
  }
  throw lastError || new Error(`All RPC URLs failed for ${method}`);
}

// ---------------------------------------------------------------------------
// EVM Balance Queries
// ---------------------------------------------------------------------------

/**
 * Get native balance for an EVM address on a specific chain.
 * @param {string} chainKey - e.g., 'ethereum', 'arbitrum'
 * @param {string} address - EVM address (0x...)
 * @param {number} [timeoutMs] - RPC timeout (default BALANCE_RPC_TIMEOUT_MS)
 * @param {boolean} [useTestnet=false] - use testnet RPC (e.g. Sepolia) when true
 * @returns {Promise<{ chain: string, address: string, balanceWei: string, balance: string, symbol: string }>}
 */
async function getEvmNativeBalance(chainKey, address, timeoutMs = BALANCE_RPC_TIMEOUT_MS, useTestnet = false) {
  const chain = CHAINS[chainKey];
  if (!chain || chain.type !== ChainType.EVM) {
    throw new Error(`Unknown EVM chain: ${chainKey}`);
  }
  const rpcUrls = useTestnet && chain.testnet?.rpcUrls?.length
    ? chain.testnet.rpcUrls
    : (chain.rpcUrls || []);

  const balanceHex = await jsonRpcCall(rpcUrls, 'eth_getBalance', [address, 'latest'], timeoutMs);
  const balanceWei = BigInt(balanceHex);
  const decimals = chain.nativeCurrency.decimals;
  const divisor = BigInt(10 ** decimals);
  const whole = balanceWei / divisor;
  const frac = balanceWei % divisor;
  const balance = `${whole}.${frac.toString().padStart(decimals, '0').slice(0, 6)}`;

  return {
    chain: chainKey,
    chainName: chain.name,
    address,
    balanceWei: balanceWei.toString(),
    balance: balance.replace(/\.?0+$/, '') || '0',
    symbol: chain.nativeCurrency.symbol,
  };
}

/**
 * Get ERC-20 token balance (e.g., USDC) on a specific chain.
 * @param {string} chainKey
 * @param {string} address - EVM address
 * @param {string} tokenAddress - ERC-20 contract address
 * @param {number} [decimals=6] - Token decimals
 * @param {number} [timeoutMs] - RPC timeout (default BALANCE_RPC_TIMEOUT_MS)
 * @param {boolean} [useTestnet=false] - use testnet RPC when true
 * @returns {Promise<{ chain: string, address: string, balance: string, token: string }>}
 */
async function getEvmTokenBalance(chainKey, address, tokenAddress, decimals = 6, timeoutMs = BALANCE_RPC_TIMEOUT_MS, useTestnet = false) {
  const chain = CHAINS[chainKey];
  if (!chain || chain.type !== ChainType.EVM) {
    throw new Error(`Unknown EVM chain: ${chainKey}`);
  }
  const rpcUrls = useTestnet && chain.testnet?.rpcUrls?.length
    ? chain.testnet.rpcUrls
    : (chain.rpcUrls || []);

  // ERC-20 balanceOf(address) call data; ensure to/tokenAddress has 0x for RPC
  const toContract = tokenAddress.startsWith('0x') ? tokenAddress : '0x' + tokenAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(toContract)) {
    throw new Error(`Invalid token contract address: ${tokenAddress}`);
  }
  const addrPadded = address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const callData = '0x70a08231' + addrPadded;

  if (process.env.NODE_ENV === 'development' && chainKey === 'ethereum') {
    console.log('[chainProvider] token eth_call', useTestnet ? 'Sepolia' : 'mainnet', 'to=', toContract, 'rpc=', rpcUrls[0]);
  }

  const result = await jsonRpcCall(rpcUrls, 'eth_call', [
    { to: toContract, data: callData },
    'latest',
  ], timeoutMs);

  if (process.env.NODE_ENV === 'development' && chainKey === 'ethereum') {
    console.log('[chainProvider] token eth_call result:', typeof result === 'string' ? result : JSON.stringify(result));
  }

  // Some RPCs return "0x" (empty hex) for failed/empty eth_call; treat as zero.
  const balanceHex = (typeof result === 'string' && result.trim() === '0x') ? '0x0' : (result || '0x0');
  const balanceRaw = BigInt(balanceHex);
  const divisor = BigInt(10 ** decimals);
  const whole = balanceRaw / divisor;
  const frac = balanceRaw % divisor;
  const balance = `${whole}.${frac.toString().padStart(decimals, '0').slice(0, decimals)}`;

  return {
    chain: chainKey,
    chainName: chain.name,
    address,
    balance: balance.replace(/\.?0+$/, '') || '0',
    balanceRaw: balanceRaw.toString(),
    token: tokenAddress,
  };
}

// ---------------------------------------------------------------------------
// Bitcoin Balance Query
// ---------------------------------------------------------------------------

/**
 * Get Bitcoin balance via mempool.space API.
 * @param {string} address - Bitcoin address
 * @param {boolean} [useTestnet=false] - use testnet API when true
 * @returns {Promise<{ chain: string, address: string, balanceSats: number, balance: string, symbol: string }>}
 */
async function getBitcoinBalance(address, useTestnet = false) {
  const chain = CHAINS.bitcoin;
  const addr = String(address || '').trim();
  const isLikelyTestnetAddr = /^(tb1|bcrt1|2|m|n)/i.test(addr);
  const primaryTestnet = useTestnet || isLikelyTestnetAddr;
  const primary = primaryTestnet ? chain.testnet?.apis?.mempool : chain.apis.mempool;
  const fallback = primaryTestnet ? chain.apis.mempool : chain.testnet?.apis?.mempool;

  let data;
  try {
    data = await fetchJson(`${primary}/address/${addr}`);
  } catch (err) {
    // Common case: wrong network endpoint for this BTC address -> HTTP 400.
    if (fallback) {
      data = await fetchJson(`${fallback}/address/${addr}`);
    } else {
      throw err;
    }
  }
  const funded = data.chain_stats?.funded_txo_sum || 0;
  const spent = data.chain_stats?.spent_txo_sum || 0;
  const balanceSats = funded - spent;

  // Include unconfirmed
  const mempoolFunded = data.mempool_stats?.funded_txo_sum || 0;
  const mempoolSpent = data.mempool_stats?.spent_txo_sum || 0;
  const pendingSats = mempoolFunded - mempoolSpent;

  return {
    chain: 'bitcoin',
    chainName: 'Bitcoin',
    address,
    balanceSats,
    pendingSats,
    balance: (balanceSats / 1e8).toFixed(8),
    symbol: 'BTC',
  };
}

// ---------------------------------------------------------------------------
// Solana Balance Query
// ---------------------------------------------------------------------------

/**
 * Get Solana balance via JSON-RPC.
 * @param {string} address - Solana address (base58)
 * @param {boolean} [useTestnet=false] - use devnet RPC when true
 * @returns {Promise<{ chain: string, address: string, balanceLamports: number, balance: string, symbol: string }>}
 */
async function getSolanaBalance(address, useTestnet = false) {
  const chain = CHAINS.solana;
  const rpcUrls = useTestnet && chain.testnet?.rpcUrls?.length
    ? chain.testnet.rpcUrls
    : (chain.rpcUrls || []);

  const result = await jsonRpcCall(rpcUrls, 'getBalance', [address]);
  const lamports = result?.value || 0;

  return {
    chain: 'solana',
    chainName: 'Solana',
    address,
    balanceLamports: lamports,
    balance: (lamports / 1e9).toFixed(9),
    symbol: 'SOL',
  };
}

// ---------------------------------------------------------------------------
// Multi-Chain Aggregate Balance
// ---------------------------------------------------------------------------

/**
 * Get balances across all supported chains for a set of derived addresses.
 * Uses shorter RPC timeouts and optional overall timeout so slow/failing public RPCs
 * don't block the whole response (aligned with proxy-api: one RPC per chain, fail-fast).
 *
 * @param {{
 *   evmAddress?: string,
 *   bitcoinAddress?: string,
 *   solanaAddress?: string,
 * }} addresses - Derived addresses from ACEGF
 * @param {{
 *   includeTokens?: boolean,
 *   chains?: string[],
 *   maxEvmChains?: number,
 *   useTestnet?: boolean,
 *   rpcTimeoutMs?: number,
 *   overallTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<{
 *   evm: object[],
 *   bitcoin: object|null,
 *   solana: object|null,
 * }>}
 */
async function getMultiChainBalances(addresses, options = {}) {
  const {
    includeTokens = true,
    chains: chainFilter = null,
    maxEvmChains = null,
    useTestnet = false,
    rpcTimeoutMs = BALANCE_RPC_TIMEOUT_MS,
    overallTimeoutMs = MULTICHAIN_OVERALL_TIMEOUT_MS,
  } = options;
  const results = { evm: [], bitcoin: null, solana: null };

  let evmChains = getEVMChains();
  if (chainFilter && chainFilter.length > 0) {
    const set = new Set(chainFilter.map((k) => String(k).toLowerCase()));
    evmChains = evmChains.filter((c) => set.has(c.key));
  }
  if (typeof maxEvmChains === 'number' && maxEvmChains > 0) {
    evmChains = evmChains.slice(0, maxEvmChains);
  }

  const promises = [];

  if (addresses.evmAddress) {
    for (const chain of evmChains) {
      promises.push(
        getEvmNativeBalance(chain.key, addresses.evmAddress, rpcTimeoutMs, useTestnet)
          .then((bal) => results.evm.push(bal))
          .catch((err) => {
            console.warn(`[chainProvider] ${chain.name} native balance failed:`, err.message);
            results.evm.push({
              chain: chain.key,
              chainName: chain.name,
              address: addresses.evmAddress,
              balanceWei: '0',
              balance: '0',
              symbol: chain.nativeCurrency.symbol,
              error: err.message,
            });
          })
      );

      const usdcAddr = useTestnet ? (chain.testnet?.usdc || chain.usdc) : chain.usdc;
      if (includeTokens && usdcAddr) {
        promises.push(
          getEvmTokenBalance(chain.key, addresses.evmAddress, usdcAddr, 6, rpcTimeoutMs, useTestnet)
            .then((bal) => results.evm.push({ ...bal, symbol: 'USDC' }))
            .catch((err) => {
              console.warn(`[chainProvider] ${chain.name} USDC balance failed:`, err.message);
              results.evm.push({
                chain: chain.key,
                chainName: chain.name,
                address: addresses.evmAddress,
                balance: '0',
                symbol: 'USDC',
                error: err.message,
              });
            })
        );
      }
      const wethAddr = useTestnet ? (chain.testnet?.weth || chain.weth) : chain.weth;
      if (includeTokens && wethAddr) {
        promises.push(
          getEvmTokenBalance(chain.key, addresses.evmAddress, wethAddr, 18, rpcTimeoutMs, useTestnet)
            .then((bal) => results.evm.push({ ...bal, symbol: 'WETH' }))
            .catch((err) => {
              console.warn(`[chainProvider] ${chain.name} WETH balance failed:`, err.message);
              results.evm.push({
                chain: chain.key,
                chainName: chain.name,
                address: addresses.evmAddress,
                balance: '0',
                symbol: 'WETH',
                error: err.message,
              });
            })
        );
      }
      const wbtcAddr = useTestnet ? (chain.testnet?.wbtc ?? null) : chain.wbtc;
      if (includeTokens && wbtcAddr && isValidEvmAddress(wbtcAddr)) {
        promises.push(
          getEvmTokenBalance(chain.key, addresses.evmAddress, wbtcAddr, 8, rpcTimeoutMs, useTestnet)
            .then((bal) => results.evm.push({ ...bal, symbol: 'WBTC' }))
            .catch((err) => {
              console.warn(`[chainProvider] ${chain.name} WBTC balance failed:`, err.message);
              results.evm.push({
                chain: chain.key,
                chainName: chain.name,
                address: addresses.evmAddress,
                balance: '0',
                symbol: 'WBTC',
                error: err.message,
              });
          })
        );
      } else if (includeTokens && wbtcAddr && !isValidEvmAddress(wbtcAddr)) {
        console.warn(`[chainProvider] ${chain.name} WBTC query skipped: invalid token address (${wbtcAddr})`);
      }
    }
  }

  if (addresses.bitcoinAddress) {
    promises.push(
      getBitcoinBalance(addresses.bitcoinAddress, useTestnet)
        .then((bal) => { results.bitcoin = bal; })
        .catch((err) => {
          console.warn('[chainProvider] Bitcoin balance failed:', err.message);
          results.bitcoin = {
            chain: 'bitcoin',
            chainName: 'Bitcoin',
            address: addresses.bitcoinAddress,
            balanceSats: 0,
            balance: '0.00000000',
            symbol: 'BTC',
            error: err.message,
          };
        })
    );
  }

  if (addresses.solanaAddress) {
    promises.push(
      getSolanaBalance(addresses.solanaAddress, useTestnet)
        .then((bal) => { results.solana = bal; })
        .catch((err) => {
          console.warn('[chainProvider] Solana balance failed:', err.message);
          results.solana = {
            chain: 'solana',
            chainName: 'Solana',
            address: addresses.solanaAddress,
            balanceLamports: 0,
            balance: '0.000000000',
            symbol: 'SOL',
            error: err.message,
          };
        })
    );
  }

  const deadline = new Promise((resolve) => setTimeout(resolve, overallTimeoutMs));
  await Promise.race([Promise.allSettled(promises), deadline]);

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getEvmNativeBalance,
  getEvmTokenBalance,
  getBitcoinBalance,
  getSolanaBalance,
  getMultiChainBalances,
  fetchJson,
  jsonRpcCall,
};
