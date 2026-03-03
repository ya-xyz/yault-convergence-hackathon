/**
 * recipient-activation.js — Recipient-Side Asset Claim
 *
 * After an authority releases AdminFactor shares (post-tlock expiry and
 * verification), the recipient uses this module to activate the
 * authorization path and gain control over the released assets.
 *
 * Flow:
 *   1. checkReleaseStatus() - Check if AdminFactor has been released
 *   2. activatePath() - Build composite, unseal REV, derive chain keys
 *   3. getBalances() - Query BTC/ETH/SOL balances
 *   4. initiateTransfer() - Sign and broadcast to recipient's own wallet
 *
 * Dependencies: WASM core (acegf + custody), chain APIs
 */

import { view_wallet_wasm } from '../wasm/acegf';
// Context-aware variant — available after acegf-core implements §3.3 of
// docs/ACEGF_CONTEXT_ISOLATION_SPEC.md. Until then, falls back to view_wallet_wasm.
let view_wallet_wasm_with_context;
try {
  ({ view_wallet_wasm_with_context } = require('../wasm/acegf'));
} catch {
  // Fallback: context-aware export not yet available in acegf-core
  view_wallet_wasm_with_context = null;
}

import {
  custody_build_composite,
  custody_build_acegf_context,
} from '../../wasm-core/pkg/yault_custody_wasm';

import { fetchReleaseRecords } from './arweave-nft.js';
import { reconstructAdminFactor } from './authority-crypto.js';

// ─── Multi-Chain Configuration ───
// All supported EVM chains share the same derived address.
// RPC endpoints with fallbacks for each chain.

const EVM_CHAINS = {
  ethereum:  { chainId: 1,     rpc: 'https://eth.llamarpc.com',                    name: 'Ethereum',   symbol: 'ETH'  },
  arbitrum:  { chainId: 42161, rpc: 'https://arb1.arbitrum.io/rpc',                name: 'Arbitrum',   symbol: 'ETH'  },
  optimism:  { chainId: 10,    rpc: 'https://mainnet.optimism.io',                 name: 'Optimism',   symbol: 'ETH'  },
  base:      { chainId: 8453,  rpc: 'https://mainnet.base.org',                    name: 'Base',       symbol: 'ETH'  },
  polygon:   { chainId: 137,   rpc: 'https://polygon-rpc.com',                     name: 'Polygon',    symbol: 'POL'  },
  bsc:       { chainId: 56,    rpc: 'https://bsc-dataseed.binance.org',            name: 'BNB Chain',  symbol: 'BNB'  },
  avalanche: { chainId: 43114, rpc: 'https://api.avax.network/ext/bc/C/rpc',       name: 'Avalanche',  symbol: 'AVAX' },
};

const MEMPOOL_API = 'https://mempool.space/api';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Get supported EVM chain keys.
 * @returns {string[]}
 */
export function getSupportedEvmChains() {
  return Object.keys(EVM_CHAINS);
}

/**
 * Get chain info by key.
 * @param {string} chainKey
 * @returns {{ chainId: number, rpc: string, name: string, symbol: string }|null}
 */
export function getEvmChainInfo(chainKey) {
  return EVM_CHAINS[chainKey] || null;
}

// ─── Internal Helpers ───

/**
 * Check a WASM string result for the "error:" prefix.
 *
 * @param {string} result
 * @returns {string}
 */
function _checkWasmResult(result) {
  if (typeof result === 'string' && result.startsWith('error:')) {
    throw new Error(result.substring(6));
  }
  return result;
}

/**
 * Check a WASM JsValue result for the error flag.
 *
 * @param {object} result
 * @returns {object}
 */
function _checkWasmObject(result) {
  if (result && result.error === true) {
    throw new Error(result.message || 'WASM operation failed');
  }
  return result;
}

/**
 * Fetch JSON with timeout.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function _fetchJson(url, options = {}, timeoutMs = 15000) {
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

// ─── Exported Functions ───

/**
 * Check whether the release path has been released for a given wallet+recipient.
 *
 * Queries Arweave for Release Records and the server API for pending trigger events.
 * Returns the release status and any AdminFactor shares that have been made available.
 *
 * @param {string} walletId - The owner's wallet identifier.
 * @param {number} recipientIndex - 1-based recipient index.
 * @returns {Promise<{
 *   released: boolean,
 *   releaseRecords: Array<object>,
 *   shares: Array<{ index: number, data_hex: string }>|null,
 *   releasedAt: string|null,
 * }>}
 */
export async function checkReleaseStatus(walletId, recipientIndex) {
  if (!walletId) throw new Error('walletId is required');
  if (!Number.isInteger(recipientIndex) || recipientIndex < 1) {
    throw new Error('recipientIndex must be a positive integer');
  }

  // Check Arweave for release records
  let releaseRecords = [];
  try {
    releaseRecords = await fetchReleaseRecords(walletId);
    // Filter to this specific recipient
    releaseRecords = releaseRecords.filter(
      (r) => r.tags['Recipient-Index'] === String(recipientIndex)
    );
  } catch {
    // Arweave query failure is non-fatal
  }

  // Check the server API for released shares
  let shares = null;
  try {
    const params = new URLSearchParams({
      wallet_id: walletId,
      recipient_index: String(recipientIndex),
    });

    const response = await fetch(`/api/trigger/pending?${params}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      if (data && Array.isArray(data.shares) && data.shares.length > 0) {
        shares = data.shares;
      }
    }
  } catch {
    // API failure is non-fatal
  }

  const released = releaseRecords.length > 0 || shares !== null;
  const releasedAt = releaseRecords.length > 0
    ? releaseRecords[0].block?.timestamp
      ? new Date(releaseRecords[0].block.timestamp * 1000).toISOString()
      : null
    : null;

  return {
    released,
    releaseRecords,
    shares,
    releasedAt,
  };
}

/**
 * Activate a release path to derive wallet keys.
 *
 * The recipient provides:
 *   - The wallet mnemonic (SA) which they received out-of-band
 *   - The UserCred from their credential document
 *   - The AdminFactor (reconstructed from authority shares)
 *
 * This function:
 *   1. Builds a composite credential: concat(UserCred, AdminFactor)
 *   2. Uses the composite as the passphrase to unseal the wallet via view_wallet_wasm
 *   3. Returns the derived chain addresses and keys
 *
 * @param {string} mnemonicSA - The wallet mnemonic (24 words).
 * @param {string} userCred - The recipient's UserCred string.
 * @param {string} adminFactorHex - The AdminFactor as hex (reconstructed from shares).
 * @returns {{
 *   solanaAddress: string,
 *   evmAddress: string,
 *   bitcoinAddress: string,
 *   cosmosAddress: string,
 *   mnemonic: string,
 *   compositeHex: string,
 * }}
 * @throws {Error} If credential composition or wallet derivation fails.
 */
export function activatePath(mnemonicSA, userCred, adminFactorHex) {
  if (!mnemonicSA || !userCred || !adminFactorHex) {
    throw new Error('mnemonicSA, userCred, and adminFactorHex are all required');
  }

  // Step 1: Build composite credential via WASM
  // The composite is UserCred_bytes || AdminFactor_bytes
  const compositeHex = custody_build_composite(userCred, adminFactorHex);
  _checkWasmResult(compositeHex);

  // Step 2: Use the composite as the passphrase to derive wallet keys
  // The ACE-GF system uses the composite through Argon2id to derive the
  // base key, which then unseals the REV and derives all chain keys.
  const wallet = view_wallet_wasm(mnemonicSA, compositeHex);
  _checkWasmObject(wallet);

  if (!wallet.solana_address && !wallet.solanaAddress) {
    throw new Error('Wallet derivation failed: no addresses returned. Check credentials.');
  }

  return {
    solanaAddress: wallet.solana_address || wallet.solanaAddress,
    evmAddress: wallet.evm_address || wallet.evmAddress,
    bitcoinAddress: wallet.bitcoin_address || wallet.bitcoinAddress,
    cosmosAddress: wallet.cosmos_address || wallet.cosmosAddress,
    mnemonic: wallet.mnemonic,
    compositeHex,
  };
}

/**
 * Activate a release path with institutional vault context.
 *
 * Same as activatePath() but passes vault context to acegf-core's
 * context-aware key derivation, producing isolated keys per vault.
 *
 * @param {string} mnemonicSA - The wallet mnemonic (24 words).
 * @param {string} userCred - The recipient's UserCred string.
 * @param {string} adminFactorHex - The AdminFactor as hex.
 * @param {{ entityId?: string, domain?: string, index?: number }} [vaultContext]
 *   - Institutional vault context. Omit or pass null for personal (default).
 * @returns {{ solanaAddress, evmAddress, bitcoinAddress, cosmosAddress, mnemonic, compositeHex, contextInfo }}
 * @throws {Error} If context-aware acegf-core export is not available.
 */
export function activatePathWithContext(mnemonicSA, userCred, adminFactorHex, vaultContext) {
  if (!mnemonicSA || !userCred || !adminFactorHex) {
    throw new Error('mnemonicSA, userCred, and adminFactorHex are all required');
  }

  // Step 1: Build composite credential via WASM
  const compositeHex = custody_build_composite(userCred, adminFactorHex);
  _checkWasmResult(compositeHex);

  // Step 2: Build context string for acegf-core
  let contextInfo = '';
  if (vaultContext && vaultContext.entityId && vaultContext.entityId !== 'personal') {
    contextInfo = custody_build_acegf_context(
      vaultContext.entityId,
      vaultContext.domain || 'AssetControl',
      vaultContext.index ?? 0,
    );
  }

  // Step 3: Derive wallet keys with context
  let wallet;
  if (contextInfo && view_wallet_wasm_with_context) {
    // Context-aware path (requires acegf-core update)
    wallet = view_wallet_wasm_with_context(mnemonicSA, compositeHex, contextInfo);
  } else if (contextInfo && !view_wallet_wasm_with_context) {
    throw new Error(
      'Institutional vault context requires acegf-core with context-aware key derivation. ' +
      'See docs/ACEGF_CONTEXT_ISOLATION_SPEC.md §3.3.'
    );
  } else {
    // Personal path (backward compatible)
    wallet = view_wallet_wasm(mnemonicSA, compositeHex);
  }
  _checkWasmObject(wallet);

  if (!wallet.solana_address && !wallet.solanaAddress) {
    throw new Error('Wallet derivation failed: no addresses returned. Check credentials.');
  }

  return {
    solanaAddress: wallet.solana_address || wallet.solanaAddress,
    evmAddress: wallet.evm_address || wallet.evmAddress,
    bitcoinAddress: wallet.bitcoin_address || wallet.bitcoinAddress,
    cosmosAddress: wallet.cosmos_address || wallet.cosmosAddress,
    mnemonic: wallet.mnemonic,
    compositeHex,
    contextInfo,
  };
}

/**
 * Query balances across ALL supported chains for the derived addresses.
 * EVM address is the same across all EVM chains — queries all in parallel.
 *
 * @param {{
 *   solanaAddress?: string,
 *   evmAddress?: string,
 *   bitcoinAddress?: string,
 * }} derivedAddresses - Addresses from activatePath().
 * @returns {Promise<{
 *   bitcoin: object|null,
 *   solana: object|null,
 *   evm: object[],
 * }>}
 */
export async function getBalances(derivedAddresses) {
  if (!derivedAddresses) throw new Error('derivedAddresses is required');

  const results = { bitcoin: null, solana: null, evm: [] };
  const promises = [];

  // Bitcoin balance via mempool.space
  if (derivedAddresses.bitcoinAddress) {
    promises.push(
      _fetchJson(`${MEMPOOL_API}/address/${derivedAddresses.bitcoinAddress}`)
        .then((data) => {
          const funded = data.chain_stats?.funded_txo_sum || 0;
          const spent = data.chain_stats?.spent_txo_sum || 0;
          const balanceSats = funded - spent;
          results.bitcoin = {
            chain: 'bitcoin',
            name: 'Bitcoin',
            address: derivedAddresses.bitcoinAddress,
            balanceSats,
            balance: (balanceSats / 1e8).toFixed(8),
            symbol: 'BTC',
          };
        })
        .catch(() => {
          results.bitcoin = {
            chain: 'bitcoin', name: 'Bitcoin',
            address: derivedAddresses.bitcoinAddress,
            balanceSats: 0, balance: '0.00000000', symbol: 'BTC',
          };
        })
    );
  }

  // All EVM chains — same address, different networks
  if (derivedAddresses.evmAddress) {
    for (const [chainKey, chain] of Object.entries(EVM_CHAINS)) {
      promises.push(
        _fetchJson(chain.rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'eth_getBalance',
            params: [derivedAddresses.evmAddress, 'latest'],
          }),
        }).then((data) => {
          const balanceWei = BigInt(data?.result || '0x0');
          const divisor = BigInt(1e14);
          const display = (Number(balanceWei) / 1e18).toFixed(6);
          results.evm.push({
            chain: chainKey,
            name: chain.name,
            chainId: chain.chainId,
            address: derivedAddresses.evmAddress,
            balanceWei: balanceWei.toString(),
            balance: display,
            symbol: chain.symbol,
          });
        }).catch(() => {
          results.evm.push({
            chain: chainKey, name: chain.name, chainId: chain.chainId,
            address: derivedAddresses.evmAddress,
            balanceWei: '0', balance: '0.000000', symbol: chain.symbol,
            error: 'RPC query failed',
          });
        })
      );
    }
  }

  // Solana balance via RPC
  if (derivedAddresses.solanaAddress) {
    promises.push(
      _fetchJson(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getBalance',
          params: [derivedAddresses.solanaAddress],
        }),
      }).then((data) => {
        const lamports = data?.result?.value || 0;
        results.solana = {
          chain: 'solana',
          name: 'Solana',
          address: derivedAddresses.solanaAddress,
          balanceLamports: lamports,
          balance: (lamports / 1e9).toFixed(9),
          symbol: 'SOL',
        };
      }).catch(() => {
        results.solana = {
          chain: 'solana', name: 'Solana',
          address: derivedAddresses.solanaAddress,
          balanceLamports: 0, balance: '0.000000000', symbol: 'SOL',
        };
      })
    );
  }

  await Promise.allSettled(promises);

  // Sort EVM results by chain name for consistent display
  results.evm.sort((a, b) => a.name.localeCompare(b.name));

  return results;
}

/**
 * Initiate a transfer from the released wallet to the recipient's own address.
 *
 * This is a high-level function that coordinates with the existing Yallet
 * signing infrastructure. The recipient provides their destination address
 * and the derived wallet credentials handle signing.
 *
 * NOTE: The actual signing uses the existing Yallet WASM signers (Solana,
 * EVM, Bitcoin) with the composite credential as the passphrase.
 *
 * @param {{
 *   mnemonic: string,
 *   compositeHex: string,
 * }} credentials - From activatePath().
 * @param {string} chain - Target chain key: 'bitcoin', 'solana', or any EVM chain key
 *                         (e.g., 'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche').
 * @param {string} toAddress - Recipient's own wallet address.
 * @param {string} amount - Amount to transfer (in human-readable units).
 * @returns {Promise<{ txHash: string, chain: string, chainName: string, status: string }>}
 */
export async function initiateTransfer(credentials, chain, toAddress, amount) {
  if (!credentials?.mnemonic || !credentials?.compositeHex) {
    throw new Error('Valid credentials from activatePath() are required');
  }
  if (!toAddress) throw new Error('toAddress is required');
  if (!amount) throw new Error('amount is required');

  const { mnemonic, compositeHex } = credentials;

  // ── Solana transfer ──
  if (chain === 'solana') {
    const { solana_sign_system_transfer } = await import('../wasm/acegf');

    const blockData = await _fetchJson(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'finalized' }],
      }),
    });

    const blockhash = blockData?.result?.value?.blockhash;
    if (!blockhash) throw new Error('Failed to get Solana blockhash');

    const lamports = Math.floor(parseFloat(amount) * 1e9);
    const signedTx = solana_sign_system_transfer(
      mnemonic, compositeHex, toAddress, lamports, blockhash
    );
    _checkWasmResult(signedTx);

    const sendResult = await _fetchJson(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sendTransaction',
        params: [signedTx, { encoding: 'base64', preflightCommitment: 'finalized' }],
      }),
    });

    if (sendResult.error) {
      throw new Error(`Solana send failed: ${sendResult.error.message}`);
    }
    return { txHash: sendResult.result, chain: 'solana', chainName: 'Solana', status: 'submitted' };
  }

  // ── Bitcoin transfer ──
  if (chain === 'bitcoin') {
    const { bitcoin_sign_transaction, bitcoin_address_to_script_pubkey } = await import('../wasm/acegf');

    const wallet = view_wallet_wasm(mnemonic, compositeHex);
    _checkWasmObject(wallet);
    const fromAddress = wallet.bitcoin_address || wallet.bitcoinAddress;

    const utxos = await _fetchJson(`${MEMPOOL_API}/address/${fromAddress}/utxo`);
    if (!Array.isArray(utxos) || utxos.length === 0) {
      throw new Error('No UTXOs available for this Bitcoin address');
    }

    const satoshis = Math.floor(parseFloat(amount) * 1e8);
    // Fetch current fee rate from mempool API, fallback to default if unavailable
    let feeRate = 10; // default: 10 sat/vB
    try {
      const feeEstimates = await _fetchJson(`${MEMPOOL_API}/v1/fees/recommended`);
      feeRate = feeEstimates?.halfHourFee || feeEstimates?.hourFee || 10;
    } catch (_) { /* use default fee rate */ }
    const estimatedFee = 140 * feeRate;

    utxos.sort((a, b) => b.value - a.value);
    let selectedValue = 0;
    const selectedUtxos = [];
    for (const utxo of utxos) {
      selectedUtxos.push(utxo);
      selectedValue += utxo.value;
      if (selectedValue >= satoshis + estimatedFee) break;
    }

    if (selectedValue < satoshis + estimatedFee) {
      throw new Error(`Insufficient BTC balance. Need ${satoshis + estimatedFee} sats, have ${selectedValue}`);
    }

    const toScript = bitcoin_address_to_script_pubkey(toAddress);
    _checkWasmResult(toScript);
    const outputs = [{ value: satoshis, script_pubkey: toScript }];

    const change = selectedValue - satoshis - estimatedFee;
    if (change > 546) {
      const changeScript = bitcoin_address_to_script_pubkey(fromAddress);
      _checkWasmResult(changeScript);
      outputs.push({ value: change, script_pubkey: changeScript });
    }

    const inputs = selectedUtxos.map((utxo) => ({
      txid: utxo.txid, vout: utxo.vout, value: utxo.value, sequence: 0xfffffffd,
    }));

    const signedTx = bitcoin_sign_transaction(mnemonic, compositeHex, JSON.stringify({
      version: 2, inputs, outputs, locktime: 0,
    }));
    _checkWasmResult(signedTx);

    const broadcastResp = await fetch(`${MEMPOOL_API}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: signedTx,
    });

    if (!broadcastResp.ok) {
      const errText = await broadcastResp.text();
      throw new Error(`BTC broadcast failed: ${errText}`);
    }

    const txHash = await broadcastResp.text();
    return { txHash, chain: 'bitcoin', chainName: 'Bitcoin', status: 'submitted' };
  }

  // ── EVM transfer (any supported EVM chain) ──
  const evmChain = EVM_CHAINS[chain];
  if (evmChain) {
    const { evm_sign_legacy_transaction } = await import('../wasm/acegf');

    const rpcUrl = evmChain.rpc;
    const chainId = evmChain.chainId;
    // Use string-based conversion to avoid parseFloat precision loss for large ETH amounts
    const parts = String(amount).split('.');
    const wholePart = parts[0] || '0';
    const fracPart = (parts[1] || '').padEnd(18, '0').slice(0, 18);
    const weiAmount = '0x' + BigInt(wholePart + fracPart).toString(16);

    const wallet = view_wallet_wasm(mnemonic, compositeHex);
    _checkWasmObject(wallet);
    const fromAddress = wallet.evm_address || wallet.evmAddress;

    const [fromNonceResult, gasPriceResult] = await Promise.all([
      _fetchJson(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount',
          params: [fromAddress, 'latest'],
        }),
      }),
      _fetchJson(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [],
        }),
      }),
    ]);

    const nonce = fromNonceResult?.result || '0x0';
    const gasPrice = gasPriceResult?.result || '0x3b9aca00';
    const gasLimit = '0x5208'; // 21000 for native transfer

    const signedTx = evm_sign_legacy_transaction(
      mnemonic, compositeHex,
      chainId,
      nonce, gasPrice, gasLimit,
      toAddress, weiAmount, '0x'
    );
    _checkWasmResult(signedTx);

    const sendResult = await _fetchJson(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction',
        params: [signedTx],
      }),
    });

    if (sendResult.error) {
      throw new Error(`${evmChain.name} send failed: ${sendResult.error.message}`);
    }

    return { txHash: sendResult.result, chain, chainName: evmChain.name, status: 'submitted' };
  }

  throw new Error(`Unsupported chain: ${chain}. Supported: ${['bitcoin', 'solana', ...Object.keys(EVM_CHAINS)].join(', ')}`);
}
