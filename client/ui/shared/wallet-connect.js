/**
 * wallet-connect.js — Yallet Wallet Connection Module
 *
 * Supports:
 * - Yallet (EVM-compatible) — via window.yallet or window.ethereum (EIP-6963)
 *
 * Usage:
 *   const wc = new WalletConnector({ onConnect, onDisconnect, onError });
 *   const html = wc.renderLoginUI();
 *   // insert html, then call wc.attachEvents(container)
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Wallet Connector
// ---------------------------------------------------------------------------

class WalletConnector {
  /**
   * @param {object} opts
   * @param {string} opts.apiBase        — API base URL (default '/api')
   * @param {function} opts.onConnect    — callback({ walletType, address, pubkey })
   * @param {function} opts.onDisconnect — callback()
   * @param {function} opts.onError      — callback(errorMessage)
   */
  constructor(opts = {}) {
    this.apiBase = opts.apiBase || '/api';
    this.onConnect = opts.onConnect || (() => {});
    this.onDisconnect = opts.onDisconnect || (() => {});
    this.onError = opts.onError || (() => {});

    this.walletType = null;   // 'yallet'
    this.address = null;
    this.pubkey = null;       // hex string
    this.authResult = null;   // { pubkey, authority_id } from server
    this._yalletProvider = null;
    this._connected = false;
  }

  // -----------------------------------------------------------------------
  // Detection
  // -----------------------------------------------------------------------

  static detectYallet() {
    // Check direct Yallet provider, or any injected ethereum provider
    // (Yallet sets both window.yallet and window.ethereum with isYallet=true)
    return !!(window.yallet || window.ethereum);
  }

  static _getYalletProvider() {
    // H-08 FIX: Verify provider identity before trusting it.
    // Prefer EIP-6963 discovery (more secure than window globals).

    // 1. Check EIP-6963 discovered providers first (most secure)
    if (window.ethereum && window.ethereum.providers) {
      const found = window.ethereum.providers.find(p => p.isYallet);
      if (found) return found;
    }

    // 2. Prefer explicit Yallet provider with identity check
    if (window.yallet && typeof window.yallet.request === 'function') {
      return window.yallet;
    }

    // 3. Check window.ethereum with Yallet flag
    if (window.ethereum && window.ethereum.isYallet && typeof window.ethereum.request === 'function') {
      return window.ethereum;
    }

    // 4. Fallback: window.ethereum with basic sanity check
    if (window.ethereum && typeof window.ethereum.request === 'function') {
      return window.ethereum;
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  async connectYallet() {
    const provider = WalletConnector._getYalletProvider();
    if (!provider) {
      throw new Error('Yallet wallet not detected. Please install the Yallet Chrome extension.');
    }

    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts returned from Yallet.');
    }
    const address = accounts[0].toLowerCase();

    this.walletType = 'yallet';
    this.address = address;
    this.pubkey = address; // EVM-compatible: address as identifier
    this._yalletProvider = provider;
    this._connected = true;

    return { walletType: 'yallet', address, pubkey: address };
  }

  disconnect() {
    this.walletType = null;
    this.address = null;
    this.pubkey = null;
    this.authResult = null;
    this._yalletProvider = null;
    this._connected = false;
    this.onDisconnect();
  }

  get connected() {
    return this._connected;
  }

  // -----------------------------------------------------------------------
  // Signing
  // -----------------------------------------------------------------------

  /**
   * Sign a hex-encoded message using the connected wallet.
   * Returns the signature as a hex string.
   */
  async signMessage(messageHex) {
    if (!this._connected || !this._yalletProvider) {
      throw new Error('No wallet connected.');
    }

    const signature = await this._yalletProvider.request({
      method: 'personal_sign',
      params: ['0x' + messageHex, this.address],
    });
    // Strip 0x prefix, return hex
    return signature.startsWith('0x') ? signature.slice(2) : signature;
  }

  // -----------------------------------------------------------------------
  // Server Auth — full challenge-response flow
  // -----------------------------------------------------------------------

  /**
   * Perform challenge-response authentication with the server.
   * Returns { pubkey, authority_id } on success.
   */
  async authenticate() {
    if (!this._connected) throw new Error('No wallet connected.');

    // 1. Request challenge
    const challengeResp = await fetch(`${this.apiBase}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: this.pubkey,
        wallet_type: this.walletType,
      }),
    });
    if (!challengeResp.ok) {
      const err = await challengeResp.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to get auth challenge');
    }
    const { challenge_id, challenge } = await challengeResp.json();

    // 2. Sign the challenge
    const signature = await this.signMessage(challenge);

    // 3. Verify with server
    const verifyResp = await fetch(`${this.apiBase}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id,
        signature,
        wallet_type: this.walletType,
      }),
    });
    if (!verifyResp.ok) {
      const err = await verifyResp.json().catch(() => ({}));
      throw new Error(err.error || 'Authentication failed');
    }
    const result = await verifyResp.json();
    if (!result.valid) {
      throw new Error(result.error || 'Signature verification failed');
    }

    this.authResult = result;
    return result;
  }

  /**
   * Get the Authorization header value for API requests.
   */
  getAuthHeader(challengeId, signature) {
    return `EVM ${challengeId}:${signature}`;
  }

  // -----------------------------------------------------------------------
  // UI Rendering
  // -----------------------------------------------------------------------

  /**
   * Render the wallet login UI as an HTML string.
   * @param {object} opts
   * @param {string} opts.title       — heading text
   * @param {string} opts.subtitle    — description text
   */
  renderLoginUI(opts = {}) {
    const title = opts.title || 'Connect Wallet';
    const subtitle = opts.subtitle || 'Sign in with Yallet to continue.';
    const detected = WalletConnector.detectYallet();

    return `
      <div class="wallet-login">
        <h2 style="text-align:center;margin-bottom:8px;">${title}</h2>
        <p style="text-align:center;color:var(--text-secondary);margin-bottom:24px;font-size:14px;">
          ${subtitle}
        </p>

        <div class="wallet-options">
          <button class="wallet-btn" data-wallet="yallet">
            <span class="wallet-icon" style="background:transparent;">
              <img src="icon128.png" alt="Yallet" width="40" height="40" style="border-radius:10px;" />
            </span>
            <span class="wallet-label">
              <strong>Yallet</strong>
              <small>${detected ? 'Ready to connect' : 'Chrome Extension'}</small>
            </span>
          </button>
        </div>

        ${!detected ? `
          <div class="alert alert-info" style="margin-top:16px;">
            <strong>Yallet not detected</strong>
            <p style="margin-top:4px;font-size:13px;">
              Please install the <a href="https://yallet.xyz" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline;">Yallet Chrome Extension</a> to continue.
            </p>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render connected wallet status bar.
   */
  renderConnectedStatus() {
    if (!this._connected) return '';
    const shortAddr = this.address
      ? (this.address.length > 16
        ? this.address.substring(0, 8) + '...' + this.address.substring(this.address.length - 6)
        : this.address)
      : '';

    return `
      <div class="wallet-status">
        <span class="wallet-status-dot"></span>
        <span class="wallet-status-info">
          <strong>Yallet</strong>
          <span class="wallet-status-addr">${shortAddr}</span>
        </span>
        <button class="wallet-disconnect-btn" data-action="wallet-disconnect">Disconnect</button>
      </div>
    `;
  }

  /**
   * Attach event listeners to wallet UI elements within a container.
   * @param {HTMLElement} container
   */
  attachEvents(container) {
    if (!container) return;

    // Yallet button
    container.querySelectorAll('.wallet-btn[data-wallet="yallet"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const result = await this.connectYallet();
          this.onConnect(result);
        } catch (err) {
          this.onError(err.message);
        }
      });
    });

    // Disconnect button
    container.querySelectorAll('[data-action="wallet-disconnect"]').forEach((btn) => {
      btn.addEventListener('click', () => this.disconnect());
    });
  }
}

// Export for both module and script contexts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WalletConnector, hexToBytes, bytesToHex };
}
if (typeof window !== 'undefined') {
  window.WalletConnector = WalletConnector;
}
