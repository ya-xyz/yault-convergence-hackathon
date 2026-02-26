/**
 * yault-escrow.js — Frontend helper for VaultShareEscrow + ERC4626 Vault interactions.
 *
 * Provides transaction builders for:
 *   - vault.approve(escrow, shares)           → Owner approves escrow to pull shares
 *   - escrow.registerWallet(walletIdHash)     → Owner registers in escrow
 *   - escrow.deposit(walletIdHash, shares, recipientIndices, amounts) → Owner deposits + allocates
 *   - escrow.claim(walletIdHash, recipientIndex, to, amount, redeemToAsset) → Recipient claims
 *   - vault.balanceOf(owner)                  → Read owner's share balance
 *
 * Requires ethers v6 (loaded before this script).
 */

(function (global) {
  'use strict';

  // -----------------------------------------------------------------------
  //  ABIs (human-readable, ethers v6 format)
  // -----------------------------------------------------------------------

  const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];

  const VAULT_SHARE_ESCROW_ABI = [
    'function registerWallet(bytes32 walletIdHash)',
    'function deposit(bytes32 walletIdHash, uint256 shares, uint256[] calldata recipientIndices, uint256[] calldata amounts)',
    'function claim(bytes32 walletIdHash, uint256 recipientIndex, address to, uint256 amount, bool redeemToAsset)',
    'function reclaim(bytes32 walletIdHash, uint256 recipientIndex, uint256 amount)',
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
    'function balanceOf(address owner) view returns (uint256)',
  ];

  // -----------------------------------------------------------------------
  //  Helpers
  // -----------------------------------------------------------------------

  function _ethers() {
    const e = (typeof globalThis !== 'undefined' && globalThis.ethers) || (global && global.ethers);
    if (!e || !e.Interface) throw new Error('ethers v6 required');
    return e;
  }

  /**
   * Compute walletIdHash = keccak256(utf8(walletId)), matching the contract convention.
   * @param {string} walletId - Typically the owner's EVM address (0x-prefixed or raw).
   * @returns {string} 0x-prefixed bytes32 hex
   */
  function walletIdHash(walletId) {
    const ethers = _ethers();
    return ethers.keccak256(ethers.toUtf8Bytes(walletId));
  }

  // -----------------------------------------------------------------------
  //  Config
  // -----------------------------------------------------------------------

  /**
   * Fetch escrow + vault config from server.
   * @param {string} baseUrl - API base (e.g. '/api')
   * @returns {Promise<{ escrowAddress, vaultAddress, chainId, rpcUrl, enabled }>}
   */
  async function getConfig(baseUrl, opts) {
    const url = baseUrl.replace(/\/$/, '') + '/claim/escrow-config';
    const res = await fetch(url, opts && opts.headers ? { headers: opts.headers } : undefined);
    if (!res.ok) throw new Error('Failed to fetch escrow config: ' + res.status);
    return res.json();
  }

  // -----------------------------------------------------------------------
  //  Read-only queries (via JsonRpcProvider)
  // -----------------------------------------------------------------------

  /**
   * Get owner's vault share balance.
   * @param {string} rpcUrl
   * @param {string} vaultAddress
   * @param {string} ownerAddress
   * @returns {Promise<string>} balance in wei (share units)
   */
  async function getShareBalance(rpcUrl, vaultAddress, ownerAddress) {
    const ethers = _ethers();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const vault = new ethers.Contract(vaultAddress, ERC4626_ABI, provider);
    const bal = await vault.balanceOf(ownerAddress);
    return bal.toString();
  }

  /**
   * Get remaining claimable shares for a recipient.
   * @param {string} rpcUrl
   * @param {string} escrowAddress
   * @param {string} walletIdHashHex
   * @param {number} recipientIndex
   * @returns {Promise<string>}
   */
  async function getRemaining(rpcUrl, escrowAddress, walletIdHashHex, recipientIndex) {
    const ethers = _ethers();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const escrow = new ethers.Contract(escrowAddress, VAULT_SHARE_ESCROW_ABI, provider);
    const remaining = await escrow.remainingForRecipient(walletIdHashHex, recipientIndex);
    return remaining.toString();
  }

  /**
   * Check if wallet is already registered in escrow.
   * @param {string} rpcUrl
   * @param {string} escrowAddress
   * @param {string} walletIdHashHex
   * @returns {Promise<string>} registered owner address (0x0 if not registered)
   */
  async function getWalletOwner(rpcUrl, escrowAddress, walletIdHashHex) {
    const ethers = _ethers();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const escrow = new ethers.Contract(escrowAddress, VAULT_SHARE_ESCROW_ABI, provider);
    return escrow.walletOwner(walletIdHashHex);
  }

  // -----------------------------------------------------------------------
  //  Transaction builders (return { to, data, value, chainId })
  // -----------------------------------------------------------------------

  /**
   * Build vault.approve(escrow, shares) tx.
   * Owner must approve VaultShareEscrow to pull vault shares.
   */
  function buildApproveTx(vaultAddress, escrowAddress, sharesWei, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(ERC20_ABI);
    return {
      to: vaultAddress,
      data: iface.encodeFunctionData('approve', [escrowAddress, sharesWei]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  /**
   * Build escrow.registerWallet(walletIdHash) tx.
   * Owner registers as the wallet controller in escrow.
   */
  function buildRegisterWalletTx(escrowAddress, walletIdHashHex, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(VAULT_SHARE_ESCROW_ABI);
    return {
      to: escrowAddress,
      data: iface.encodeFunctionData('registerWallet', [walletIdHashHex]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  /**
   * Build escrow.deposit(walletIdHash, shares, recipientIndices, amounts) tx.
   * Owner deposits vault shares and allocates per recipient.
   *
   * @param {string} escrowAddress
   * @param {string} walletIdHashHex
   * @param {string} totalSharesWei - Total shares to deposit (sum of amounts)
   * @param {number[]} recipientIndices - [1, 2, 3, ...]
   * @param {string[]} amounts - Per-recipient share amounts in wei strings
   * @param {string|number} chainId
   */
  function buildDepositTx(escrowAddress, walletIdHashHex, totalSharesWei, recipientIndices, amounts, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(VAULT_SHARE_ESCROW_ABI);
    return {
      to: escrowAddress,
      data: iface.encodeFunctionData('deposit', [walletIdHashHex, totalSharesWei, recipientIndices, amounts]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  /**
   * Build escrow.claim(walletIdHash, recipientIndex, to, amount, redeemToAsset) tx.
   * Recipient (or anyone) can call this after attestation is RELEASE.
   *
   * @param {string} escrowAddress
   * @param {string} walletIdHashHex
   * @param {number} recipientIndex
   * @param {string} toAddress - Where to send the underlying asset
   * @param {string} amountWei - Share amount to claim
   * @param {boolean} redeemToAsset - true = receive underlying; false = receive vault shares (may revert if C-05)
   * @param {string|number} chainId
   */
  function buildClaimTx(escrowAddress, walletIdHashHex, recipientIndex, toAddress, amountWei, redeemToAsset, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(VAULT_SHARE_ESCROW_ABI);
    return {
      to: escrowAddress,
      data: iface.encodeFunctionData('claim', [
        walletIdHashHex,
        recipientIndex,
        ethers.getAddress(toAddress),
        amountWei,
        redeemToAsset,
      ]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  /**
   * Build escrow.reclaim(walletIdHash, recipientIndex, amount) tx.
   * Owner reclaims unclaimed shares before RELEASE attestation.
   */
  function buildReclaimTx(escrowAddress, walletIdHashHex, recipientIndex, amountWei, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(VAULT_SHARE_ESCROW_ABI);
    return {
      to: escrowAddress,
      data: iface.encodeFunctionData('reclaim', [walletIdHashHex, recipientIndex, amountWei]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  // -----------------------------------------------------------------------
  //  High-level: deposit all shares into escrow (multi-tx sequence)
  // -----------------------------------------------------------------------

  /**
   * Execute the full escrow deposit sequence via an EVM provider.
   * Sends 3 transactions: approve → registerWallet → deposit.
   *
   * @param {object} provider - EVM-compatible provider with request({ method, params }) support
   * @param {object} cfg - { escrowAddress, vaultAddress, chainId, rpcUrl }
   * @param {string} ownerAddress - Owner's EVM address
   * @param {number[]} recipientIndices - [1, 2, 3, ...]
   * @param {number[]} weights - Percentage weights per recipient (must sum to 100)
   * @param {function} [onProgress] - Optional callback: (step, total, detail) => void
   * @returns {Promise<{ success: boolean, txHashes: string[], totalShares: string, error?: string }>}
   */
  async function depositAllToEscrow(provider, cfg, ownerAddress, recipientIndices, weights, onProgress) {
    const ethers = _ethers();
    const progress = onProgress || function () {};
    const txHashes = [];

    try {
      // 1. Query owner's vault share balance
      progress(0, 4, 'Querying vault share balance...');
      const totalShares = await getShareBalance(cfg.rpcUrl, cfg.vaultAddress, ownerAddress);
      if (totalShares === '0' || !totalShares) {
        return { success: false, txHashes: [], totalShares: '0', error: 'Owner has no vault shares to deposit' };
      }

      // Calculate per-recipient share allocation (weighted by percentage)
      const totalBigInt = BigInt(totalShares);
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      if (totalWeight <= 0) {
        return { success: false, txHashes: [], totalShares: '0', error: 'Recipient weights sum to zero' };
      }
      if (weights.length === 0) {
        return { success: false, txHashes: [], totalShares: '0', error: 'No recipients specified' };
      }
      const amounts = [];
      let allocated = 0n;
      for (let i = 0; i < weights.length; i++) {
        if (i === weights.length - 1) {
          // Last recipient gets the remainder (avoid rounding dust)
          amounts.push((totalBigInt - allocated).toString());
        } else {
          const share = (totalBigInt * BigInt(weights[i])) / BigInt(totalWeight);
          amounts.push(share.toString());
          allocated += share;
        }
      }

      const wHash = walletIdHash(ownerAddress);

      // 2. Check if wallet already registered
      const existingOwner = await getWalletOwner(cfg.rpcUrl, cfg.escrowAddress, wHash);
      const isRegistered = existingOwner !== ethers.ZeroAddress;

      // 3. Approve escrow to pull vault shares (skip if allowance already sufficient)
      const rpcProvider = new ethers.JsonRpcProvider(cfg.rpcUrl);
      const vaultToken = new ethers.Contract(cfg.vaultAddress, ERC20_ABI, rpcProvider);
      const currentAllowance = await vaultToken.allowance(ownerAddress, cfg.escrowAddress);

      if (BigInt(currentAllowance) < totalBigInt) {
        progress(1, isRegistered ? 3 : 4, 'Approving escrow to pull vault shares...');
        const approveTx = buildApproveTx(cfg.vaultAddress, cfg.escrowAddress, totalShares, cfg.chainId);
        approveTx.from = ownerAddress;
        const approveHash = await provider.request({ method: 'eth_sendTransaction', params: [approveTx] });
        txHashes.push(approveHash);

        // Wait for approval to confirm
        await _waitForTx(cfg.rpcUrl, approveHash);
      } else {
        progress(1, isRegistered ? 3 : 4, 'Allowance already sufficient, skipping approve...');
      }

      // 4. Register wallet (skip if already registered)
      if (!isRegistered) {
        progress(2, 4, 'Registering wallet in escrow...');
        const regTx = buildRegisterWalletTx(cfg.escrowAddress, wHash, cfg.chainId);
        regTx.from = ownerAddress;
        const regHash = await provider.request({ method: 'eth_sendTransaction', params: [regTx] });
        txHashes.push(regHash);
        await _waitForTx(cfg.rpcUrl, regHash);
      }

      // 5. Deposit + allocate shares
      const depositStep = isRegistered ? 2 : 3;
      const totalSteps = isRegistered ? 3 : 4;
      progress(depositStep, totalSteps, 'Depositing shares into escrow (' + recipientIndices.length + ' recipients)...');
      const depTx = buildDepositTx(cfg.escrowAddress, wHash, totalShares, recipientIndices, amounts, cfg.chainId);
      depTx.from = ownerAddress;
      const depHash = await provider.request({ method: 'eth_sendTransaction', params: [depTx] });
      txHashes.push(depHash);
      await _waitForTx(cfg.rpcUrl, depHash);

      progress(totalSteps, totalSteps, 'Escrow deposit complete!');
      return { success: true, txHashes, totalShares, amounts };
    } catch (err) {
      return { success: false, txHashes, totalShares: '0', error: err.message || String(err) };
    }
  }

  /**
   * Reclaim all shares from escrow back to the owner's wallet.
   * Sends one reclaim tx per recipient index that has remaining shares.
   *
   * @param {object} provider - EVM-compatible provider with request() support
   * @param {object} cfg - { escrowAddress, vaultAddress, chainId, rpcUrl }
   * @param {string} ownerAddress - Owner's EVM address
   * @param {number[]} recipientIndices - Recipient indices to reclaim from
   * @param {function} [onProgress] - Optional callback: (step, total, detail) => void
   * @returns {Promise<{ success: boolean, txHashes: string[], reclaimedCount: number, error?: string }>}
   */
  async function reclaimAllFromEscrow(provider, cfg, ownerAddress, recipientIndices, onProgress) {
    const ethers = _ethers();
    const progress = onProgress || function () {};
    let txHashes = [];
    let reclaimedCount = 0;

    try {
      const wHash = walletIdHash(ownerAddress);

      // 1. Query remaining shares for each recipient index
      progress(0, recipientIndices.length + 1, 'Querying escrow allocations...');
      const rpcProvider = new ethers.JsonRpcProvider(cfg.rpcUrl);
      const escrow = new ethers.Contract(cfg.escrowAddress, VAULT_SHARE_ESCROW_ABI, rpcProvider);

      const remainingList = await Promise.all(
        recipientIndices.map(async (idx) => {
          const rem = await escrow.remainingForRecipient(wHash, idx);
          return { index: idx, remaining: rem };
        })
      );

      const toReclaim = remainingList.filter((r) => r.remaining > 0n);
      if (toReclaim.length === 0) {
        return { success: true, txHashes: [], reclaimedCount: 0, error: 'No remaining shares to reclaim' };
      }

      // 2. Send reclaim tx per recipient; skip on revert (e.g. already RELEASE attested) so others can still be reclaimed
      const errors = [];
      for (let i = 0; i < toReclaim.length; i++) {
        const { index, remaining } = toReclaim[i];
        progress(i + 1, toReclaim.length + 1, 'Reclaiming from recipient #' + index + '...');
        try {
          const tx = buildReclaimTx(cfg.escrowAddress, wHash, index, remaining.toString(), cfg.chainId);
          tx.from = ownerAddress;
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
          txHashes.push(hash);
          await _waitForTx(cfg.rpcUrl, hash);
          reclaimedCount++;
        } catch (perErr) {
          errors.push('recipient #' + index + ': ' + (perErr.message || perErr));
          // continue to next recipient so one revert (e.g. AttestationAlreadyReleased) does not block the rest
        }
      }

      progress(toReclaim.length + 1, toReclaim.length + 1, 'Reclaim complete!');
      if (reclaimedCount === 0 && errors.length > 0) {
        return { success: false, txHashes, reclaimedCount: 0, error: errors.join('; ') };
      }
      return { success: true, txHashes, reclaimedCount, partialErrors: errors.length > 0 ? errors : undefined };
    } catch (err) {
      return { success: false, txHashes: [], reclaimedCount: 0, error: err.message || String(err) };
    }
  }

  /**
   * Wait for a transaction to be mined.
   */
  async function _waitForTx(rpcUrl, txHash, timeoutMs) {
    const ethers = _ethers();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const timeout = timeoutMs || 120000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 0) throw new Error('Transaction reverted: ' + txHash);
        return receipt;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('Transaction not confirmed within timeout: ' + txHash);
  }

  // -----------------------------------------------------------------------
  //  Export
  // -----------------------------------------------------------------------

  const YaultEscrow = {
    // ABIs
    ERC20_ABI,
    VAULT_SHARE_ESCROW_ABI,
    ERC4626_ABI,
    // Helpers
    walletIdHash,
    // Config
    getConfig,
    // Read
    getShareBalance,
    getRemaining,
    getWalletOwner,
    // Tx builders
    buildApproveTx,
    buildRegisterWalletTx,
    buildDepositTx,
    buildClaimTx,
    buildReclaimTx,
    // High-level
    depositAllToEscrow,
    reclaimAllFromEscrow,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = YaultEscrow;
  } else {
    global.YaultEscrow = YaultEscrow;
  }
})(typeof window !== 'undefined' ? window : this);
