/**
 * vaultContract.js — YaultVault (ERC-4626) contract helper
 *
 * Reads on-chain state and builds transaction payloads for the client to sign and send.
 * Contract address and RPC come from config; for mainnet, set VAULT_ADDRESS and EVM_RPC_URL.
 */

'use strict';

const { ethers } = require('ethers');

const VAULT_ABI = [
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function convertToShares(uint256) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function harvest() external',
  'function harvestFor(address user) external',
  'function userPrincipal(address) view returns (uint256)',
  'function getPendingRevenue(address) view returns (uint256)',
  'function claimAuthorityRevenue() external',
];

/**
 * @returns {{ provider: ethers.JsonRpcProvider, vault: ethers.Contract } | null }
 */
function getVaultReadOnly(config) {
  const addr = (config?.contracts?.vaultAddress || '').trim();
  if (!addr) return null;
  try {
    if (ethers.getAddress(addr) === ethers.ZeroAddress) return null;
  } catch (_) {
    return null;
  }
  const rpc = (config?.contracts?.evmRpcUrl || '').trim() || 'https://eth.llamarpc.com';
  const provider = new ethers.JsonRpcProvider(rpc);
  const vault = new ethers.Contract(addr, VAULT_ABI, provider);
  return { provider, vault };
}

/**
 * Get vault balance and principal for an address (from chain).
 * @param {object} config - server config
 * @param {string} address - EVM address (with or without 0x)
 * @returns {Promise<{ shares: string, assets: string, principal: string } | null>}
 */
async function getVaultBalance(config, address) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const addr = address.replace(/^0x/i, '').toLowerCase();
  const addr0x = '0x' + addr;
  try {
    const [shares, principal] = await Promise.all([
      ctx.vault.balanceOf(addr0x),
      ctx.vault.userPrincipal(addr0x),
    ]);
    const assets = shares > 0n ? await ctx.vault.convertToAssets(shares) : 0n;
    const decimals = config?.contracts?.underlyingDecimals ?? 6;
    return {
      shares: ethers.formatUnits(shares, decimals),
      assets: ethers.formatUnits(assets, decimals),
      principal: ethers.formatUnits(principal, decimals),
    };
  } catch (err) {
    console.error('[vaultContract] getVaultBalance error:', err.message, 'address=', address);
    return null;
  }
}

// Ensure even-length hex for wallet compatibility (e.g. Yallet).
function padEvenHex(h) {
  const hex = typeof h === 'string' && h.startsWith('0x') ? h.slice(2) : String(h);
  const normalized = hex.length % 2 === 0 ? hex : '0' + hex;
  return normalized.startsWith('0x') ? normalized : '0x' + normalized;
}

/**
 * Build transaction payload for deposit(assets, receiver).
 * Client must sign and send; client should have approved the vault to spend underlying first.
 * @param {object} config - server config
 * @param {string} assetsHuman - amount in human units (e.g. "100.5")
 * @param {string} receiverAddress - EVM address (receiver of shares)
 * @returns {Promise<{ to: string, data: string, value: string, chainId: string } | null>}
 */
async function buildDepositTx(config, assetsHuman, receiverAddress) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const vaultAddress = config.contracts.vaultAddress;
  const decimals = config.contracts.underlyingDecimals ?? 6;
  const assetsWei = ethers.parseUnits(String(assetsHuman), decimals);
  const receiver = receiverAddress.startsWith('0x') ? receiverAddress : '0x' + receiverAddress;
  const iface = new ethers.Interface(VAULT_ABI);
  const data = iface.encodeFunctionData('deposit', [assetsWei, receiver]);
  const chainId = config.contracts.vaultChainId || '1';
  const dataHex = (data.startsWith('0x') ? data : '0x' + data);
  return {
    to: padEvenHex(vaultAddress),
    data: dataHex.length % 2 === 0 ? dataHex : '0x0' + dataHex.slice(2),
    value: '0x00',
    chainId,
    gasLimit: '0x030d40', // 200000 in even-length hex
  };
}

/**
 * Build transaction payload for redeem(shares, receiver, owner).
 * Owner should be the signer (msg.sender).
 */
async function buildRedeemTx(config, sharesHuman, receiverAddress, ownerAddress) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const vaultAddress = config.contracts.vaultAddress;
  const decimals = config.contracts.underlyingDecimals ?? 6;
  const sharesWei = ethers.parseUnits(String(sharesHuman), decimals);
  const receiver = receiverAddress.startsWith('0x') ? receiverAddress : '0x' + receiverAddress;
  const owner = ownerAddress.startsWith('0x') ? ownerAddress : '0x' + ownerAddress;
  const iface = new ethers.Interface(VAULT_ABI);
  const data = iface.encodeFunctionData('redeem', [sharesWei, receiver, owner]);
  const chainId = config.contracts.vaultChainId || '1';
  const dataHex = (data.startsWith('0x') ? data : '0x' + data);
  return {
    to: padEvenHex(vaultAddress),
    data: dataHex.length % 2 === 0 ? dataHex : '0x0' + dataHex.slice(2),
    value: '0x00',
    chainId,
  };
}

/**
 * Build transaction payload for harvest(). Caller must be the vault share holder (msg.sender).
 */
async function buildHarvestTx(config) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const vaultAddress = config.contracts.vaultAddress;
  const iface = new ethers.Interface(VAULT_ABI);
  const data = iface.encodeFunctionData('harvest');
  const chainId = config.contracts.vaultChainId || '1';
  const dataHex = (data.startsWith('0x') ? data : '0x' + data);
  return {
    to: padEvenHex(vaultAddress),
    data: dataHex.length % 2 === 0 ? dataHex : '0x0' + dataHex.slice(2),
    value: '0x00',
    chainId,
  };
}

/**
 * Build transaction payload for harvestFor(user). Caller must be the vault owner (for periodic settlement).
 * @param {object} config - server config
 * @param {string} userAddress - EVM address of the depositor to harvest for
 */
async function buildHarvestForTx(config, userAddress) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const vaultAddress = config.contracts.vaultAddress;
  const user = userAddress.startsWith('0x') ? userAddress : '0x' + userAddress;
  const iface = new ethers.Interface(VAULT_ABI);
  const data = iface.encodeFunctionData('harvestFor', [user]);
  const chainId = config.contracts.vaultChainId || '1';
  const dataHex = (data.startsWith('0x') ? data : '0x' + data);
  return {
    to: padEvenHex(vaultAddress),
    data: dataHex.length % 2 === 0 ? dataHex : '0x0' + dataHex.slice(2),
    value: '0x00',
    chainId,
  };
}

/**
 * Build transaction payload for claimAuthorityRevenue(). Caller must be the authority (msg.sender).
 */
async function buildClaimAuthorityRevenueTx(config) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const vaultAddress = config.contracts.vaultAddress;
  const iface = new ethers.Interface(VAULT_ABI);
  const data = iface.encodeFunctionData('claimAuthorityRevenue');
  const chainId = config.contracts.vaultChainId || '1';
  const dataHex = (data.startsWith('0x') ? data : '0x' + data);
  return {
    to: padEvenHex(vaultAddress),
    data: dataHex.length % 2 === 0 ? dataHex : '0x0' + dataHex.slice(2),
    value: '0x00',
    chainId,
  };
}

/**
 * Get pending revenue for an authority address (from chain).
 */
async function getPendingRevenue(config, authorityAddress) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  const addr = authorityAddress.startsWith('0x') ? authorityAddress : '0x' + authorityAddress;
  try {
    const pending = await ctx.vault.getPendingRevenue(addr);
    const decimals = config?.contracts?.underlyingDecimals ?? 6;
    return ethers.formatUnits(pending, decimals);
  } catch (err) {
    console.error('[vaultContract] getPendingRevenue error:', err.message);
    return null;
  }
}

/**
 * Get underlying asset address (for client to call approve(asset, vault)).
 */
async function getAssetAddress(config) {
  const ctx = getVaultReadOnly(config);
  if (!ctx) return null;
  try {
    return await ctx.vault.asset();
  } catch (err) {
    console.error('[vaultContract] getAssetAddress error:', err.message);
    return null;
  }
}

module.exports = {
  getVaultReadOnly,
  getVaultBalance,
  buildDepositTx,
  buildRedeemTx,
  buildHarvestTx,
  buildHarvestForTx,
  buildClaimAuthorityRevenueTx,
  getPendingRevenue,
  getAssetAddress,
};
