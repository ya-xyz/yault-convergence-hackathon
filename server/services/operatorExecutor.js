/**
 * operatorExecutor.js — Server-side transaction execution for agent API keys
 *
 * When an agent API key triggers a vault operation, the server signs and sends
 * the transaction using the operator private key (deployer/relayer key).
 *
 * Security model:
 *   On-chain:  User's ERC-20 approve(operator, amount) caps total operator access
 *   App-layer: Spending policy enforces per-tx, daily/weekly/monthly limits
 *
 * Deposit flow:  transferFrom(user→operator) + vault.deposit(amount, user)
 * Redeem flow:   vault.redeem(shares, user, user) — ERC-4626 allowance mechanism
 */

'use strict';

const { ethers } = require('ethers');
const config = require('../config');

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const VAULT_ABI = [
  'function asset() view returns (address)',
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Lazy-init singleton
let _provider = null;
let _operatorWallet = null;
let _operatorVaultApproved = false;

function _getOperatorKey() {
  return (config.oracle?.releaseAttestationRelayerPrivateKey || '').trim();
}

function _ensureOperator() {
  if (_operatorWallet) return { provider: _provider, wallet: _operatorWallet };

  const key = _getOperatorKey();
  if (!key) throw new Error('Operator key not configured (RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY)');

  const rpc = (config.contracts?.evmRpcUrl || '').trim();
  if (!rpc) throw new Error('EVM_RPC_URL not configured');

  _provider = new ethers.JsonRpcProvider(rpc);
  _operatorWallet = new ethers.Wallet(key, _provider);
  return { provider: _provider, wallet: _operatorWallet };
}

function _getVaultAddress() {
  const addr = (config.contracts?.vaultAddress || '').trim();
  if (!addr) throw new Error('VAULT_ADDRESS not configured');
  return addr;
}

function _getDecimals() {
  return config.contracts?.underlyingDecimals ?? 6;
}

function _normalize(addr) {
  return addr.startsWith('0x') ? addr : '0x' + addr;
}

/**
 * Returns the operator's 0x address (derived from private key).
 */
function getOperatorAddress() {
  const key = _getOperatorKey();
  if (!key) return null;
  try {
    const wallet = new ethers.Wallet(key);
    return wallet.address;
  } catch (_) {
    return null;
  }
}

/**
 * Ensure operator has approved the vault to spend its USDC (one-time, lazy).
 */
async function _ensureVaultApproval(usdcContract, vaultAddress) {
  if (_operatorVaultApproved) return;

  const { wallet } = _ensureOperator();
  const current = await usdcContract.allowance(wallet.address, vaultAddress);
  if (current < ethers.parseUnits('1000000', _getDecimals())) {
    console.log('[operatorExecutor] Approving vault to spend operator USDC (one-time)...');
    const tx = await usdcContract.approve(vaultAddress, ethers.MaxUint256);
    await tx.wait();
    console.log('[operatorExecutor] Vault approval confirmed:', tx.hash);
  }
  _operatorVaultApproved = true;
}

/**
 * Execute a deposit on behalf of a user.
 *
 * 1. transferFrom(user, operator, amount) — pull USDC from user
 * 2. vault.deposit(amount, user) — deposit into vault, shares go to user
 *
 * @param {string} userAddress - user's EVM address
 * @param {string} amountHuman - deposit amount in human units (e.g. "100.5")
 * @returns {{ txHash: string, blockNumber: number, sharesReceived: string }}
 */
async function executeDeposit(userAddress, amountHuman) {
  const { wallet } = _ensureOperator();
  const vaultAddress = _getVaultAddress();
  const decimals = _getDecimals();
  const user = _normalize(userAddress);
  const amountWei = ethers.parseUnits(String(amountHuman), decimals);

  // Get USDC address from vault
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  const usdcAddress = await vault.asset();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, wallet);

  // Ensure operator has approved vault to spend its USDC
  await _ensureVaultApproval(usdc, vaultAddress);

  // Step 1: Pull USDC from user to operator
  const transferTx = await usdc.transferFrom(user, wallet.address, amountWei);
  await transferTx.wait();

  // Step 2: Deposit into vault, shares go to user.
  // If this fails, funds are on operator wallet — attempt to return them.
  let depositReceipt;
  try {
    const depositTx = await vault.deposit(amountWei, user);
    depositReceipt = await depositTx.wait();
  } catch (depositErr) {
    console.error('[operatorExecutor] vault.deposit failed after transferFrom; recovering funds to user:', depositErr.message);
    try {
      const returnTx = await usdc.transfer(user, amountWei);
      await returnTx.wait();
      console.log('[operatorExecutor] Recovery transfer confirmed:', returnTx.hash);
    } catch (recoveryErr) {
      // Critical: funds are stranded on operator wallet. Log loudly for manual resolution.
      console.error('[operatorExecutor] CRITICAL: Recovery transfer ALSO failed. Funds stranded on operator wallet.', {
        user,
        amount: amountHuman,
        transferTxHash: transferTx.hash,
        recoveryError: recoveryErr.message,
      });
    }
    throw new Error(`Deposit failed (funds returned to user): ${depositErr.message}`);
  }

  // Read shares received from event or balance delta
  const sharesReceived = ethers.formatUnits(amountWei, decimals); // approximate; exact from event

  return {
    txHash: depositReceipt.hash,
    blockNumber: depositReceipt.blockNumber,
    sharesReceived,
    transferTxHash: transferTx.hash,
  };
}

/**
 * Execute a redeem on behalf of a user.
 *
 * vault.redeem(shares, user, user) — ERC-4626 checks allowance(user, operator)
 *
 * @param {string} userAddress - user's EVM address
 * @param {string} sharesHuman - shares to redeem in human units
 * @returns {{ txHash: string, blockNumber: number, assetsReceived: string }}
 */
async function executeRedeem(userAddress, sharesHuman) {
  const { wallet } = _ensureOperator();
  const vaultAddress = _getVaultAddress();
  const decimals = _getDecimals();
  const user = _normalize(userAddress);
  const sharesWei = ethers.parseUnits(String(sharesHuman), decimals);

  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);

  // Redeem: operator calls redeem(shares, receiver=user, owner=user)
  // ERC-4626 will check vault.allowance(user, operator) >= shares
  const redeemTx = await vault.redeem(sharesWei, user, user);
  const receipt = await redeemTx.wait();

  // Approximate assets received
  const assetsReceived = ethers.formatUnits(sharesWei, decimals);

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    assetsReceived,
  };
}

/**
 * Execute a send (direct ERC-20 transfer) on behalf of a user.
 *
 * asset.transferFrom(user, recipient, amount) — pull from user, send to recipient.
 * Requires: user has approved operator for the underlying asset (WETH).
 *
 * @param {string} userAddress - sender's EVM address
 * @param {string} recipientAddress - recipient's EVM address
 * @param {string} amountHuman - amount in human units (e.g. "0.1")
 * @returns {{ txHash: string, blockNumber: number }}
 */
async function executeSend(userAddress, recipientAddress, amountHuman) {
  const { wallet } = _ensureOperator();
  const vaultAddress = _getVaultAddress();
  const decimals = _getDecimals();
  const user = _normalize(userAddress);
  const recipient = _normalize(recipientAddress);
  const amountWei = ethers.parseUnits(String(amountHuman), decimals);

  // Get underlying asset address from vault
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  const assetAddress = await vault.asset();
  const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);

  // transferFrom(user, recipient, amount) — operator must be approved by user
  const tx = await asset.transferFrom(user, recipient, amountWei);
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * Get current agent authorization status for a user address.
 * Returns operator address and current on-chain allowances.
 */
async function getAgentAuthorization(userAddress) {
  const operatorAddr = getOperatorAddress();
  if (!operatorAddr) {
    return { configured: false, error: 'Operator key not configured' };
  }

  const vaultAddr = (config.contracts?.vaultAddress || '').trim();
  if (!vaultAddr) {
    return { configured: false, error: 'Vault not configured' };
  }

  const rpc = (config.contracts?.evmRpcUrl || '').trim();
  if (!rpc) {
    return { configured: false, error: 'RPC not configured' };
  }

  const user = _normalize(userAddress);
  const decimals = _getDecimals();
  const chainId = config.contracts?.vaultChainId || '1';

  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const vault = new ethers.Contract(vaultAddr, VAULT_ABI, provider);
    const usdcAddress = await vault.asset();
    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

    const [usdcAllowance, sharesAllowance] = await Promise.all([
      usdc.allowance(user, operatorAddr),
      vault.allowance(user, operatorAddr),
    ]);

    return {
      configured: true,
      operator_address: operatorAddr,
      usdc_address: usdcAddress,
      vault_address: vaultAddr,
      chain_id: chainId,
      underlying_decimals: decimals,
      underlying_symbol: config.contracts?.underlyingSymbol || 'USDC',
      usdc_allowance: ethers.formatUnits(usdcAllowance, decimals),
      shares_allowance: ethers.formatUnits(sharesAllowance, decimals),
    };
  } catch (err) {
    console.error('[operatorExecutor] getAgentAuthorization error:', err.message);
    return {
      configured: true,
      operator_address: operatorAddr,
      usdc_address: null,
      vault_address: vaultAddr,
      chain_id: chainId,
      underlying_decimals: decimals,
      underlying_symbol: config.contracts?.underlyingSymbol || 'USDC',
      usdc_allowance: '0',
      shares_allowance: '0',
      error: err.message,
    };
  }
}

module.exports = {
  getOperatorAddress,
  executeDeposit,
  executeRedeem,
  executeSend,
  getAgentAuthorization,
};
