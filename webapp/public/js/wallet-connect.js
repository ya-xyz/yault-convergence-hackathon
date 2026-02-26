/**
 * wallet-connect.js — Yallet Wallet Connection Module
 *
 * Supports:
 * - Yallet (EVM-compatible) — via window.yallet
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

function report(msg) {
  if (typeof console !== 'undefined' && console.log) console.log('[WalletConnector]', msg);
}

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
    this.allAddresses = null; // Yallet multi-chain addresses { evm_address, bitcoin_address, solana_address, ... }
    this.authResult = null;   // { pubkey, authority_id } from server
    this._yalletProvider = null;
    this._connected = false;
    this._connecting = false; // guard: prevent re-entry / duplicate passkey prompts
  }

  /**
   * Request all chain addresses supported by the current wallet from the Yallet extension.
   * First try yallet_getAddresses, then try yallet_deriveContextAddresses({ context: '' }) to get the default account.
   * @param {object} provider - window.yallet
   * @returns {Promise<object|null>} { evm_address, bitcoin_address, cosmos_address, polkadot_address, solana_address, xaddress?, xidentity? } or null
   */
  static async getYalletAllAddresses(provider) {
    if (!provider || typeof provider.request !== 'function') {
      report('getYalletAllAddresses: no provider or request method');
      return null;
    }
    try {
      // Extension requirement: must connect (eth_requestAccounts) before calling yallet_getAddresses, otherwise returns Not connected
      let accounts = await provider.request({ method: 'eth_accounts' });
      if (!accounts || accounts.length === 0) {
        accounts = await provider.request({ method: 'eth_requestAccounts' });
      }
      if (!accounts || accounts.length === 0) {
        report('getYalletAllAddresses: no connected accounts');
        return null;
      }
      report('getYalletAllAddresses: connected, calling yallet_getAddresses');
      let raw = await provider.request({ method: 'yallet_getAddresses' });
      const source = raw ? 'yallet_getAddresses' : null;
      if (!raw) raw = await provider.request({ method: 'yallet_deriveContextAddresses', params: [{ context: '' }] });
      if (!raw) {
        report('yallet_getAddresses and deriveContextAddresses both returned empty');
        return null;
      }
      const reportStr = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      report('Response (source: ' + (source || 'yallet_deriveContextAddresses') + '):\n' + reportStr);
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj && (obj.evm_address || obj.evmAddress)) {
        const normalized = {
          evm_address: obj.evm_address || obj.evmAddress || null,
          bitcoin_address: obj.bitcoin_address || obj.bitcoinAddress || null,
          cosmos_address: obj.cosmos_address || obj.cosmosAddress || null,
          polkadot_address: obj.polkadot_address || obj.polkadotAddress || null,
          solana_address: obj.solana_address || obj.solanaAddress || null,
          xaddress: obj.xaddress || null,
          xidentity: obj.xidentity || null,
        };
        return normalized;
      }
      report('Response missing evm_address, ignored');
      return null;
    } catch (e) {
      const errMsg = (e && (e.message || e.data?.message || String(e))) || 'unknown';
      console.warn('[Yallet] getYalletAllAddresses error:', errMsg, e);
      report('getYalletAllAddresses error: ' + errMsg);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Detection
  // -----------------------------------------------------------------------

  static detectYallet() {
    return !!window.yallet;
  }

  static _getYalletProvider() {
    return window.yallet || null;
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

  /**
   * Login flow (minimize verification prompts):
   * 1) First try eth_accounts (read-only, usually no popup); if no accounts, then eth_requestAccounts (one popup)
   * 2) After getting address: challenge -> personal_sign (another popup) -> verify
   * If already connected, only personal_sign is needed (1 popup); first connection requires 2 popups (connect + sign)
   */
  async connectAndSignIn() {
    const provider = WalletConnector._getYalletProvider();
    if (!provider) {
      throw new Error('Yallet not detected. Please install the extension and refresh the page.');
    }
    // 1) Read already-connected accounts to avoid duplicate "connect" prompts; request connection only if needed (preserve user gesture)
    let accounts = await provider.request({ method: 'eth_accounts' });
    if (!accounts || accounts.length === 0) {
      accounts = await provider.request({ method: 'eth_requestAccounts' });
    }
    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts retrieved. Please try again.');
    }
    const address = accounts[0].toLowerCase();

    // 2) challenge (include address to avoid server returning "pubkey is required")
    const challengeResp = await fetch(`${this.apiBase}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: address, wallet_type: 'yallet' }),
    });
    if (!challengeResp.ok) {
      const err = await challengeResp.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to get challenge');
    }
    const { challenge_id, challenge } = await challengeResp.json();

    // 3) Sign (personal_sign(message, address))
    const messageHex = '0x' + challenge;
    const sig = await provider.request({
      method: 'personal_sign',
      params: [messageHex, address],
    });
    const signature = (sig && typeof sig === 'string' && sig.startsWith('0x')) ? sig.slice(2) : sig;
    if (!signature) throw new Error('Signing was cancelled or failed');

    // 4) Server-side verification
    const verifyResp = await fetch(`${this.apiBase}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id, signature, wallet_type: 'yallet' }),
    });
    if (!verifyResp.ok) {
      const err = await verifyResp.json().catch(() => ({}));
      throw new Error(err.error || 'Verification failed');
    }
    const result = await verifyResp.json();
    const recoveredAddress = (result.pubkey || '').toLowerCase();
    if (!recoveredAddress) throw new Error('Server did not return an address');

    this.walletType = 'yallet';
    this.address = recoveredAddress;
    this.pubkey = recoveredAddress;
    this._yalletProvider = provider;
    this._connected = true;
    this.authResult = result;
    this.sessionToken = result.session_token || null; // After login, data APIs use this token without requiring a second signature
    // Persist session token so it survives page refresh within the same tab
    if (this.sessionToken) {
      try { sessionStorage.setItem('yault_session_token', this.sessionToken); } catch (_) {}
    }
    // On first login, fetch all chain addresses supported by Yallet for backend storage
    let allAddresses = null;
    try {
      allAddresses = await WalletConnector.getYalletAllAddresses(provider);
      if (allAddresses) this.allAddresses = allAddresses;
    } catch (_) { /* non-fatal, just no multi-chain addresses */ }
    return { walletType: 'yallet', address: recoveredAddress, pubkey: recoveredAddress, allAddresses: allAddresses || undefined };
  }

  disconnect() {
    this.walletType = null;
    this.address = null;
    this.pubkey = null;
    this.allAddresses = null;
    this.authResult = null;
    this.sessionToken = null;
    try { sessionStorage.removeItem('yault_session_token'); } catch (_) {}
    this._yalletProvider = null;
    this._connected = false;
    this._connecting = false;
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

    // Yallet: click -> connectAndSignIn (single verification) -> onConnect (uses authResult, no longer calls authenticate)
    container.querySelectorAll('.wallet-btn[data-wallet="yallet"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (this._connecting) return;
        this._connecting = true;
        try {
          const result = await this.connectAndSignIn();
          await this.onConnect(result);
        } catch (err) {
          this.onError(err.message);
        } finally {
          this._connecting = false;
        }
      });
    });

    // Disconnect button
    container.querySelectorAll('[data-action="wallet-disconnect"]').forEach((btn) => {
      btn.addEventListener('click', () => this.disconnect());
    });

    // If Yallet wasn't detected at render time, poll briefly (extension may inject after page load)
    if (!WalletConnector.detectYallet()) {
      this._startYalletDetectionPoll(container);
    }
  }

  /**
   * Poll for window.yallet for a few seconds after load; if it appears, remove "Yallet not detected" and update button.
   * @param {HTMLElement} container
   */
  _startYalletDetectionPoll(container) {
    const maxWaitMs = 2500;
    const intervalMs = 200;
    let elapsed = 0;
    const t = setInterval(() => {
      if (!container.isConnected) {
        clearInterval(t);
        return;
      }
      elapsed += intervalMs;
      if (elapsed > maxWaitMs) {
        clearInterval(t);
        return;
      }
      if (!window.yallet) return;
      clearInterval(t);
      const alertEl = container.querySelector('.wallet-login .alert.alert-info');
      if (alertEl && alertEl.textContent.indexOf('Yallet not detected') !== -1) {
        alertEl.remove();
      }
      const small = container.querySelector('.wallet-login .wallet-btn[data-wallet="yallet"] .wallet-label small');
      if (small) small.textContent = 'Ready to connect';
    }, intervalMs);
  }
}

// Export for both module and script contexts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WalletConnector, hexToBytes, bytesToHex };
}
if (typeof window !== 'undefined') {
  window.WalletConnector = WalletConnector;
}
