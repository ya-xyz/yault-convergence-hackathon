/**
 * pathClaimContract.js — YaultPathClaim contract client
 *
 * Read state and build tx payloads for registerWallet, deposit, registerPath, claim.
 * Claim requires EIP-712 signature from pathController (path-derived EVM key).
 */

'use strict';

const { ethers } = require('ethers');

const YAULT_PATH_CLAIM_ABI = [
  'function registerWallet(bytes32 walletIdHash)',
  'function deposit(bytes32 walletIdHash, uint256 amount)',
  'function registerPath(bytes32 walletIdHash, uint256 pathIndex, address pathController, uint256 totalAmount)',
  'function claim(bytes32 walletIdHash, uint256 pathIndex, uint256 amount, address to, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function walletOwner(bytes32) view returns (address)',
  'function totalDeposited(bytes32) view returns (uint256)',
  'function pathInfo(bytes32, uint256) view returns (address pathController, uint256 totalAmount, uint256 claimedAmount)',
  'function claimNonce(bytes32, uint256) view returns (uint256)',
  'function remainingForPath(bytes32 walletIdHash, uint256 pathIndex) view returns (uint256)',
  'function getClaimHash(bytes32 walletIdHash, uint256 pathIndex, uint256 amount, address to, uint256 nonce, uint256 deadline) view returns (bytes32)',
  'function asset() view returns (address)',
];

/**
 * Compute walletIdHash as keccak256(walletId string), matching contract usage.
 * @param {string} walletId - Wallet ID string (e.g. UUID)
 * @returns {string} 0x-prefixed bytes32 hex
 */
function walletIdHash(walletId) {
  return ethers.keccak256(ethers.toUtf8Bytes(walletId));
}

/**
 * @param {object} config - Server config (config.pathClaim, config.contracts)
 * @returns {{ provider: ethers.JsonRpcProvider, contract: ethers.Contract } | null}
 */
function getPathClaimReadOnly(config) {
  const addr = (config?.pathClaim?.address || '').trim();
  if (!addr) return null;
  try {
    if (ethers.getAddress(addr) === ethers.ZeroAddress) return null;
  } catch (_) {
    return null;
  }
  const rpc = (config?.pathClaim?.rpcUrl || config?.contracts?.evmRpcUrl || '').trim() ||
    'https://eth.llamarpc.com';
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(addr, YAULT_PATH_CLAIM_ABI, provider);
  return { provider, contract };
}

/**
 * Get remaining claimable amount for (walletIdHash, pathIndex).
 * @param {object} config
 * @param {string} walletIdHashHex - 0x-prefixed bytes32
 * @param {number|string} pathIndex
 * @returns {Promise<string|null>} remaining amount (wei string) or null
 */
async function getRemainingForPath(config, walletIdHashHex, pathIndex) {
  const ctx = getPathClaimReadOnly(config);
  if (!ctx) return null;
  try {
    const remaining = await ctx.contract.remainingForPath(walletIdHashHex, pathIndex);
    return remaining.toString();
  } catch (err) {
    console.error('[pathClaimContract] getRemainingForPath:', err.message);
    return null;
  }
}

/**
 * Get current claim nonce for (walletIdHash, pathIndex).
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {number|string} pathIndex
 * @returns {Promise<string|null>} nonce string or null
 */
async function getClaimNonce(config, walletIdHashHex, pathIndex) {
  const ctx = getPathClaimReadOnly(config);
  if (!ctx) return null;
  try {
    const nonce = await ctx.contract.claimNonce(walletIdHashHex, pathIndex);
    return nonce.toString();
  } catch (err) {
    console.error('[pathClaimContract] getClaimNonce:', err.message);
    return null;
  }
}

/**
 * Get EIP-712 claim digest from contract (matches contract's getClaimHash).
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {number|string} pathIndex
 * @param {string|bigint} amountWei
 * @param {string} toAddress
 * @param {string|bigint} nonce
 * @param {string|bigint} deadline
 * @returns {Promise<string|null>} 0x-prefixed digest hex or null
 */
async function getClaimHash(config, walletIdHashHex, pathIndex, amountWei, toAddress, nonce, deadline) {
  const ctx = getPathClaimReadOnly(config);
  if (!ctx) return null;
  try {
    const digest = await ctx.contract.getClaimHash(
      walletIdHashHex,
      pathIndex,
      amountWei,
      ethers.getAddress(toAddress),
      nonce,
      deadline
    );
    return digest;
  } catch (err) {
    console.error('[pathClaimContract] getClaimHash:', err.message);
    return null;
  }
}

/**
 * Build unsigned claim tx payload. Caller (frontend or relayer) must sign digest with pathController key and pass v,r,s.
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {number|string} pathIndex
 * @param {string|bigint} amountWei
 * @param {string} toAddress
 * @param {string|bigint} deadline
 * @param {number} v
 * @param {string} r - 0x-prefixed bytes32
 * @param {string} s - 0x-prefixed bytes32
 * @returns {{ to: string, data: string, value: string, chainId: string } | null}
 */
function buildClaimTx(config, walletIdHashHex, pathIndex, amountWei, toAddress, deadline, v, r, s) {
  const addr = (config?.pathClaim?.address || '').trim();
  if (!addr) return null;
  const iface = new ethers.Interface(YAULT_PATH_CLAIM_ABI);
  const data = iface.encodeFunctionData('claim', [
    walletIdHashHex,
    pathIndex,
    amountWei,
    ethers.getAddress(toAddress),
    deadline,
    v,
    r,
    s,
  ]);
  const chainId = (config?.pathClaim?.chainId || config?.contracts?.vaultChainId || '1').toString();
  return {
    to: addr,
    data,
    value: '0',
    chainId,
  };
}

/**
 * Build registerWallet tx (owner).
 * @param {object} config
 * @param {string} walletIdHashHex
 * @returns {{ to: string, data: string, value: string, chainId: string } | null}
 */
function buildRegisterWalletTx(config, walletIdHashHex) {
  const addr = (config?.pathClaim?.address || '').trim();
  if (!addr) return null;
  const iface = new ethers.Interface(YAULT_PATH_CLAIM_ABI);
  const data = iface.encodeFunctionData('registerWallet', [walletIdHashHex]);
  const chainId = (config?.pathClaim?.chainId || config?.contracts?.vaultChainId || '1').toString();
  return { to: addr, data, value: '0', chainId };
}

/**
 * Build deposit tx (owner must have approved pool to spend token).
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {string|bigint} amountWei
 * @returns {{ to: string, data: string, value: string, chainId: string } | null}
 */
function buildDepositTx(config, walletIdHashHex, amountWei) {
  const addr = (config?.pathClaim?.address || '').trim();
  if (!addr) return null;
  const iface = new ethers.Interface(YAULT_PATH_CLAIM_ABI);
  const data = iface.encodeFunctionData('deposit', [walletIdHashHex, amountWei]);
  const chainId = (config?.pathClaim?.chainId || config?.contracts?.vaultChainId || '1').toString();
  return { to: addr, data, value: '0', chainId };
}

/**
 * Build registerPath tx (owner).
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {number|string} pathIndex
 * @param {string} pathControllerAddress
 * @param {string|bigint} totalAmountWei
 * @returns {{ to: string, data: string, value: string, chainId: string } | null}
 */
function buildRegisterPathTx(config, walletIdHashHex, pathIndex, pathControllerAddress, totalAmountWei) {
  const addr = (config?.pathClaim?.address || '').trim();
  if (!addr) return null;
  const iface = new ethers.Interface(YAULT_PATH_CLAIM_ABI);
  const data = iface.encodeFunctionData('registerPath', [
    walletIdHashHex,
    pathIndex,
    ethers.getAddress(pathControllerAddress),
    totalAmountWei,
  ]);
  const chainId = (config?.pathClaim?.chainId || config?.contracts?.vaultChainId || '1').toString();
  return { to: addr, data, value: '0', chainId };
}

module.exports = {
  YAULT_PATH_CLAIM_ABI,
  walletIdHash,
  getPathClaimReadOnly,
  getRemainingForPath,
  getClaimNonce,
  getClaimHash,
  buildClaimTx,
  buildRegisterWalletTx,
  buildDepositTx,
  buildRegisterPathTx,
};
