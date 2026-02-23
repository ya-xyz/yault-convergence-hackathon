/**
 * escrowContract.js — VaultShareEscrow contract client
 *
 * Query allocated/remaining shares for recipients, and convert to underlying asset value.
 * Follows the same pattern as pathClaimContract.js.
 */

'use strict';

const { ethers } = require('ethers');

const VAULT_SHARE_ESCROW_ABI = [
  'function walletOwner(bytes32) view returns (address)',
  'function totalDeposited(bytes32) view returns (uint256)',
  'function allocatedShares(bytes32, uint256) view returns (uint256)',
  'function claimedShares(bytes32, uint256) view returns (uint256)',
  'function remainingForRecipient(bytes32 walletIdHash, uint256 recipientIndex) view returns (uint256)',
  'function VAULT() view returns (address)',
  'function ATTESTATION() view returns (address)',
];

const ERC4626_ABI = [
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

/**
 * Compute walletIdHash as keccak256(walletId string).
 * @param {string} walletId
 * @returns {string} 0x-prefixed bytes32 hex
 */
function walletIdHash(walletId) {
  return ethers.keccak256(ethers.toUtf8Bytes(walletId));
}

/**
 * Get read-only contract instance.
 * @param {object} config - Server config
 * @returns {{ provider, escrow, escrowAddress } | null}
 */
function getEscrowReadOnly(config) {
  const addr = (config?.escrow?.address || '').trim();
  if (!addr) return null;
  try {
    if (ethers.getAddress(addr) === ethers.ZeroAddress) return null;
  } catch (_) {
    return null;
  }
  const rpc = (config?.escrow?.rpcUrl || config?.contracts?.evmRpcUrl || '').trim() ||
    'https://ethereum-sepolia-rpc.publicnode.com';
  const provider = new ethers.JsonRpcProvider(rpc);
  const escrow = new ethers.Contract(addr, VAULT_SHARE_ESCROW_ABI, provider);
  return { provider, escrow, escrowAddress: addr };
}

/**
 * Get remaining claimable shares for (walletIdHash, recipientIndex).
 * @param {object} config
 * @param {string} walletIdHashHex - 0x-prefixed bytes32
 * @param {number|string} recipientIndex
 * @returns {Promise<string|null>} remaining shares (wei string) or null
 */
async function getRemainingShares(config, walletIdHashHex, recipientIndex) {
  const ctx = getEscrowReadOnly(config);
  if (!ctx) return null;
  try {
    const remaining = await ctx.escrow.remainingForRecipient(walletIdHashHex, recipientIndex);
    return remaining.toString();
  } catch (err) {
    console.error('[escrowContract] getRemainingShares:', err.message);
    return null;
  }
}

/**
 * Get allocated shares for (walletIdHash, recipientIndex).
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {number|string} recipientIndex
 * @returns {Promise<string|null>} allocated shares (wei string) or null
 */
async function getAllocatedShares(config, walletIdHashHex, recipientIndex) {
  const ctx = getEscrowReadOnly(config);
  if (!ctx) return null;
  try {
    const allocated = await ctx.escrow.allocatedShares(walletIdHashHex, recipientIndex);
    return allocated.toString();
  } catch (err) {
    console.error('[escrowContract] getAllocatedShares:', err.message);
    return null;
  }
}

/**
 * Get full balance info: allocated shares, remaining shares, and their underlying asset value.
 * @param {object} config
 * @param {string} walletIdHashHex
 * @param {number|string} recipientIndex
 * @returns {Promise<{ allocatedShares, remainingShares, allocatedAssets, remainingAssets, underlyingDecimals, underlyingSymbol } | null>}
 */
async function getRecipientBalance(config, walletIdHashHex, recipientIndex) {
  const ctx = getEscrowReadOnly(config);
  if (!ctx) return null;
  try {
    const [allocated, remaining, vaultAddr] = await Promise.all([
      ctx.escrow.allocatedShares(walletIdHashHex, recipientIndex),
      ctx.escrow.remainingForRecipient(walletIdHashHex, recipientIndex),
      ctx.escrow.VAULT(),
    ]);

    // Convert shares to underlying asset value via vault.convertToAssets
    const vault = new ethers.Contract(vaultAddr, ERC4626_ABI, ctx.provider);
    const [allocatedAssets, remainingAssets, assetAddr] = await Promise.all([
      allocated > 0n ? vault.convertToAssets(allocated) : 0n,
      remaining > 0n ? vault.convertToAssets(remaining) : 0n,
      vault.asset(),
    ]);

    // Get underlying token info
    const underlying = new ethers.Contract(assetAddr, ERC20_ABI, ctx.provider);
    const [decimals, symbol] = await Promise.all([
      underlying.decimals().catch(() => 18),
      underlying.symbol().catch(() => 'TOKEN'),
    ]);

    return {
      allocatedShares: allocated.toString(),
      remainingShares: remaining.toString(),
      allocatedAssets: allocatedAssets.toString(),
      remainingAssets: remainingAssets.toString(),
      underlyingDecimals: Number(decimals),
      underlyingSymbol: symbol,
    };
  } catch (err) {
    console.error('[escrowContract] getRecipientBalance:', err.message);
    return null;
  }
}

module.exports = {
  VAULT_SHARE_ESCROW_ABI,
  walletIdHash,
  getEscrowReadOnly,
  getRemainingShares,
  getAllocatedShares,
  getRecipientBalance,
};
