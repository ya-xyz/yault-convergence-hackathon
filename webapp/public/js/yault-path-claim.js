/**
 * yault-path-claim.js — Frontend helper for YaultPathClaim (deposit, registerPath, claim).
 *
 * Uses EIP-712 claim digest from contract; pathController signs digest to produce (v,r,s).
 * Requires ethers v6 (load before this script, e.g. <script src="https://cdn.ethers.io/lib/ethers-6.7.0.umd.min.js">).
 *
 * Usage:
 *   1. Fetch config: YaultPathClaim.getConfig(baseUrl)
 *   2. Fetch claim params: YaultPathClaim.getClaimParams(baseUrl, walletIdHash, pathIndex, amount, to, deadline)
 *   3. Sign digest with pathController key: YaultPathClaim.signDigest(digestHex, privateKeyHex)
 *   4. Build claim tx: YaultPathClaim.buildClaimTx(config, walletIdHash, pathIndex, amount, to, deadline, v, r, s)
 *   5. Send tx with provider (e.g. ethers BrowserProvider + signer, or wallet_sendTransaction).
 */

(function (global) {
  'use strict';

  const CLAIM_ABI = [
    'function claim(bytes32 walletIdHash, uint256 pathIndex, uint256 amount, address to, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  ];

  /**
   * Fetch path-claim config from API.
   * @param {string} baseUrl - API base URL (e.g. /api or https://api.example.com/api)
   * @returns {Promise<{ pathClaimAddress: string, assetAddress: string, chainId: string, rpcUrl: string, enabled: boolean }>}
   */
  async function getConfig(baseUrl) {
    const url = baseUrl.replace(/\/$/, '') + '/path-claim/config';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch path-claim config: ' + res.status);
    return res.json();
  }

  /**
   * Fetch remaining claimable amount.
   * @param {string} baseUrl
   * @param {string} walletIdHashHex - 0x-prefixed bytes32
   * @param {number|string} pathIndex
   */
  async function getRemaining(baseUrl, walletIdHashHex, pathIndex) {
    const u = new URL(baseUrl.replace(/\/$/, '') + '/path-claim/remaining');
    u.searchParams.set('walletIdHash', walletIdHashHex);
    u.searchParams.set('pathIndex', String(pathIndex));
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error('Failed to fetch remaining: ' + res.status);
    const data = await res.json();
    return data.remaining;
  }

  /**
   * Fetch claim params (nonce + digest) for signing.
   * @param {string} baseUrl
   * @param {string} walletIdHashHex
   * @param {number|string} pathIndex
   * @param {string} amountWei
   * @param {string} toAddress
   * @param {string} deadline - unix timestamp string
   */
  async function getClaimParams(baseUrl, walletIdHashHex, pathIndex, amountWei, toAddress, deadline) {
    const u = new URL(baseUrl.replace(/\/$/, '') + '/path-claim/claim-params');
    u.searchParams.set('walletIdHash', walletIdHashHex);
    u.searchParams.set('pathIndex', String(pathIndex));
    u.searchParams.set('amount', String(amountWei));
    u.searchParams.set('to', toAddress);
    u.searchParams.set('deadline', String(deadline));
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error('Failed to fetch claim params: ' + res.status);
    return res.json();
  }

  /**
   * Sign EIP-712 claim digest with pathController private key. Returns { v, r, s }.
   * @param {string} digestHex - 0x-prefixed bytes32 (from contract getClaimHash or API claim-params)
   * @param {string} privateKeyHex - 0x-prefixed hex of pathController's EVM private key
   * @param {object} ethersLib - ethers v6 (default: global ethers)
   */
  function signDigest(digestHex, privateKeyHex, ethersLib) {
    const ethers = ethersLib || (typeof globalThis !== 'undefined' && globalThis.ethers) || (global && global.ethers);
    if (!ethers || !ethers.Wallet) throw new Error('ethers v6 required (ethers.Wallet)');
    const wallet = new ethers.Wallet(privateKeyHex);
    const digestBytes = ethers.getBytes(digestHex);
    const sig = wallet.signingKey.sign(digestBytes);
    return {
      v: sig.v,
      r: sig.r,
      s: sig.s,
    };
  }

  /**
   * Build unsigned claim transaction payload. After signing digest, use buildClaimTx with v,r,s.
   * @param {object} config - { pathClaimAddress, chainId }
   * @param {string} walletIdHashHex
   * @param {number|string} pathIndex
   * @param {string|bigint} amountWei
   * @param {string} toAddress
   * @param {string|number} deadline
   * @param {number} v
   * @param {string} r - 0x-prefixed bytes32
   * @param {string} s - 0x-prefixed bytes32
   * @param {object} ethersLib - optional ethers v6
   */
  function buildClaimTx(config, walletIdHashHex, pathIndex, amountWei, toAddress, deadline, v, r, s, ethersLib) {
    const ethers = ethersLib || (typeof globalThis !== 'undefined' && globalThis.ethers) || (global && global.ethers);
    if (!ethers || !ethers.Interface) throw new Error('ethers v6 required');
    const iface = new ethers.Interface(CLAIM_ABI);
    const to = ethers.getAddress(toAddress);
    const data = iface.encodeFunctionData('claim', [
      walletIdHashHex,
      pathIndex,
      amountWei,
      to,
      deadline,
      v,
      r,
      s,
    ]);
    return {
      to: config.pathClaimAddress,
      data,
      value: '0',
      chainId: String(config.chainId || '11155111'),
    };
  }

  /**
   * Build registerWallet tx (owner). For use with wallet_sendTransaction or ethers signer.
   */
  function buildRegisterWalletTx(config, walletIdHashHex, ethersLib) {
    const ethers = ethersLib || (typeof globalThis !== 'undefined' && globalThis.ethers) || (global && global.ethers);
    if (!ethers || !ethers.Interface) throw new Error('ethers v6 required');
    const iface = new ethers.Interface([
      'function registerWallet(bytes32 walletIdHash)',
    ]);
    return {
      to: config.pathClaimAddress,
      data: iface.encodeFunctionData('registerWallet', [walletIdHashHex]),
      value: '0',
      chainId: String(config.chainId || '11155111'),
    };
  }

  /**
   * Build deposit tx (owner; must have approved pool to spend token first).
   */
  function buildDepositTx(config, walletIdHashHex, amountWei, ethersLib) {
    const ethers = ethersLib || (typeof globalThis !== 'undefined' && globalThis.ethers) || (global && global.ethers);
    if (!ethers || !ethers.Interface) throw new Error('ethers v6 required');
    const iface = new ethers.Interface([
      'function deposit(bytes32 walletIdHash, uint256 amount)',
    ]);
    return {
      to: config.pathClaimAddress,
      data: iface.encodeFunctionData('deposit', [walletIdHashHex, amountWei]),
      value: '0',
      chainId: String(config.chainId || '11155111'),
    };
  }

  /**
   * Build registerPath tx (owner).
   */
  function buildRegisterPathTx(config, walletIdHashHex, pathIndex, pathControllerAddress, totalAmountWei, ethersLib) {
    const ethers = ethersLib || (typeof globalThis !== 'undefined' && globalThis.ethers) || (global && global.ethers);
    if (!ethers || !ethers.Interface) throw new Error('ethers v6 required');
    const iface = new ethers.Interface([
      'function registerPath(bytes32 walletIdHash, uint256 pathIndex, address pathController, uint256 totalAmount)',
    ]);
    return {
      to: config.pathClaimAddress,
      data: iface.encodeFunctionData('registerPath', [
        walletIdHashHex,
        pathIndex,
        ethers.getAddress(pathControllerAddress),
        totalAmountWei,
      ]),
      value: '0',
      chainId: String(config.chainId || '11155111'),
    };
  }

  const YaultPathClaim = {
    getConfig,
    getRemaining,
    getClaimParams,
    signDigest,
    buildClaimTx,
    buildRegisterWalletTx,
    buildDepositTx,
    buildRegisterPathTx,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = YaultPathClaim;
  } else {
    global.YaultPathClaim = YaultPathClaim;
  }
})(typeof window !== 'undefined' ? window : this);
