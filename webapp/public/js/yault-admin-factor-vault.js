/**
 * yault-admin-factor-vault.js — Frontend helper for AdminFactorVault contract interactions.
 *
 * Provides transaction builders and read functions for:
 *   - afVault.store(walletIdHash, index, ciphertext, fingerprint)  → Owner stores encrypted AF on-chain
 *   - afVault.destroy(walletIdHash, index)                         → Owner destroys AF + submits REJECT
 *   - afVault.retrieve(walletIdHash, index)                        → Anyone reads encrypted AF (for claim)
 *   - afVault.isActive(walletIdHash, index)                        → Check if AF exists and not destroyed
 *
 * Requires ethers v6 (loaded before this script).
 */

(function (global) {
  'use strict';

  // -----------------------------------------------------------------------
  //  ABI (human-readable, ethers v6 format)
  // -----------------------------------------------------------------------

  const ADMIN_FACTOR_VAULT_ABI = [
    'function store(bytes32 walletIdHash, uint256 recipientIndex, bytes calldata ciphertext, bytes32 fingerprint)',
    'function destroy(bytes32 walletIdHash, uint256 recipientIndex)',
    'function destroyAndReclaim(bytes32 walletIdHash, uint256 recipientIndex)',
    'function retrieve(bytes32 walletIdHash, uint256 recipientIndex) view returns (bytes ciphertext, bytes32 fingerprint, address owner)',
    'function isActive(bytes32 walletIdHash, uint256 recipientIndex) view returns (bool)',
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
  //  Read-only queries (via JsonRpcProvider)
  // -----------------------------------------------------------------------

  /**
   * Retrieve the encrypted AdminFactor for a (walletIdHash, recipientIndex).
   * @param {string} rpcUrl
   * @param {string} afVaultAddress - AdminFactorVault contract address
   * @param {string} walletIdHashHex - 0x-prefixed bytes32
   * @param {number} recipientIndex
   * @returns {Promise<{ ciphertext: string, fingerprint: string, owner: string }>}
   *          ciphertext is hex-encoded; empty string if destroyed or not stored.
   */
  async function retrieveAF(rpcUrl, afVaultAddress, walletIdHashHex, recipientIndex) {
    const ethers = _ethers();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const vault = new ethers.Contract(afVaultAddress, ADMIN_FACTOR_VAULT_ABI, provider);
    const [ciphertext, fingerprint, owner] = await vault.retrieve(walletIdHashHex, recipientIndex);
    return {
      ciphertext: ciphertext,   // bytes as hex string
      fingerprint: fingerprint, // bytes32 hex
      owner: owner,             // address
    };
  }

  /**
   * Check if an AF exists and has not been destroyed.
   * @param {string} rpcUrl
   * @param {string} afVaultAddress
   * @param {string} walletIdHashHex
   * @param {number} recipientIndex
   * @returns {Promise<boolean>}
   */
  async function checkIsActive(rpcUrl, afVaultAddress, walletIdHashHex, recipientIndex) {
    const ethers = _ethers();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const vault = new ethers.Contract(afVaultAddress, ADMIN_FACTOR_VAULT_ABI, provider);
    return vault.isActive(walletIdHashHex, recipientIndex);
  }

  // -----------------------------------------------------------------------
  //  Transaction builders (return { to, data, value, chainId })
  // -----------------------------------------------------------------------

  /**
   * Build afVault.store(walletIdHash, index, ciphertext, fingerprint) tx.
   * Plan owner stores encrypted AF on-chain during plan creation.
   *
   * @param {string} afVaultAddress
   * @param {string} walletIdHashHex - 0x-prefixed bytes32
   * @param {number} recipientIndex
   * @param {string} ciphertextHex - 0x-prefixed hex of ECIES-encrypted AF
   * @param {string} fingerprintHex - 0x-prefixed bytes32 SHA-256(AF)
   * @param {string|number} chainId
   */
  function buildStoreTx(afVaultAddress, walletIdHashHex, recipientIndex, ciphertextHex, fingerprintHex, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(ADMIN_FACTOR_VAULT_ABI);
    return {
      to: afVaultAddress,
      data: iface.encodeFunctionData('store', [walletIdHashHex, recipientIndex, ciphertextHex, fingerprintHex]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  /**
   * Build afVault.destroy(walletIdHash, index) tx.
   * Plan owner destroys encrypted AF + submits REJECT attestation atomically.
   *
   * @param {string} afVaultAddress
   * @param {string} walletIdHashHex
   * @param {number} recipientIndex
   * @param {string|number} chainId
   */
  function buildDestroyTx(afVaultAddress, walletIdHashHex, recipientIndex, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(ADMIN_FACTOR_VAULT_ABI);
    return {
      to: afVaultAddress,
      data: iface.encodeFunctionData('destroy', [walletIdHashHex, recipientIndex]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  /**
   * Build afVault.destroyAndReclaim(walletIdHash, index) tx.
   * Destroy AF + reclaim escrow shares atomically in one transaction (one signature).
   *
   * @param {string} afVaultAddress
   * @param {string} walletIdHashHex
   * @param {number} recipientIndex
   * @param {string|number} chainId
   */
  function buildDestroyAndReclaimTx(afVaultAddress, walletIdHashHex, recipientIndex, chainId) {
    const ethers = _ethers();
    const iface = new ethers.Interface(ADMIN_FACTOR_VAULT_ABI);
    return {
      to: afVaultAddress,
      data: iface.encodeFunctionData('destroyAndReclaim', [walletIdHashHex, recipientIndex]),
      value: '0x0',
      chainId: '0x' + Number(chainId).toString(16),
    };
  }

  // -----------------------------------------------------------------------
  //  High-level: store all AFs during plan creation
  // -----------------------------------------------------------------------

  /**
   * Store encrypted AdminFactors for all recipients in a plan.
   * Sends one store() tx per recipient.
   *
   * @param {object} provider - EVM-compatible provider with request({ method, params })
   * @param {object} cfg - { afVaultAddress, chainId, rpcUrl }
   * @param {string} ownerAddress - Plan owner's EVM address
   * @param {Array<{ index: number, ciphertextHex: string, fingerprintHex: string }>} entries
   * @param {function} [onProgress] - Optional callback: (step, total, detail) => void
   * @returns {Promise<{ success: boolean, txHashes: string[], error?: string }>}
   */
  async function storeAllAFs(provider, cfg, ownerAddress, entries, onProgress) {
    const progress = onProgress || function () {};
    const txHashes = [];
    const wHash = walletIdHash(ownerAddress);

    try {
      for (let i = 0; i < entries.length; i++) {
        const { index, ciphertextHex, fingerprintHex } = entries[i];
        progress(i + 1, entries.length, 'Storing encrypted AF for recipient #' + index + '...');

        const tx = buildStoreTx(cfg.afVaultAddress, wHash, index, ciphertextHex, fingerprintHex, cfg.chainId);
        tx.from = ownerAddress;
        const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
        txHashes.push(hash);
        await _waitForTx(cfg.rpcUrl, hash);
      }

      progress(entries.length, entries.length, 'All AFs stored on-chain.');
      return { success: true, txHashes };
    } catch (err) {
      return { success: false, txHashes, error: err.message || String(err) };
    }
  }

  /**
   * Destroy AF and reclaim escrow shares for a recipient in a single transaction.
   * One signature: destroyAndReclaim() on AdminFactorVault atomically submits REJECT,
   * zeros ciphertext, and reclaims escrow shares back to the owner.
   *
   * @param {object} provider - EVM-compatible provider
   * @param {object} cfg - { afVaultAddress, chainId, rpcUrl }
   * @param {string} ownerAddress
   * @param {number} recipientIndex
   * @param {function} [onProgress]
   * @returns {Promise<{ success: boolean, txHashes: string[], error?: string }>}
   */
  async function destroyAndReclaim(provider, cfg, ownerAddress, recipientIndex, onProgress) {
    const progress = onProgress || function () {};
    const txHashes = [];
    const wHash = walletIdHash(ownerAddress);

    try {
      progress(1, 1, 'Destroying AF and reclaiming escrow shares...');
      const tx = buildDestroyAndReclaimTx(cfg.afVaultAddress, wHash, recipientIndex, cfg.chainId);
      tx.from = ownerAddress;
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      txHashes.push(hash);
      await _waitForTx(cfg.rpcUrl, hash);

      progress(1, 1, 'AF destroyed and shares reclaimed.');
      return { success: true, txHashes };
    } catch (err) {
      return { success: false, txHashes, error: err.message || String(err) };
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

  const YaultAdminFactorVault = {
    // ABI
    ADMIN_FACTOR_VAULT_ABI,
    // Helpers
    walletIdHash,
    // Read
    retrieveAF,
    checkIsActive,
    // Tx builders
    buildStoreTx,
    buildDestroyTx,
    buildDestroyAndReclaimTx,
    // High-level
    storeAllAFs,
    destroyAndReclaim,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = YaultAdminFactorVault;
  } else {
    global.YaultAdminFactorVault = YaultAdminFactorVault;
  }
})(typeof window !== 'undefined' ? window : this);
