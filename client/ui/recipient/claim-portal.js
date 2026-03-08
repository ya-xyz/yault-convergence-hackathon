/**
 * claim-portal.js — Recipient Claim Portal UI
 *
 * Standalone page for recipients to claim released assets.
 *
 * Components:
 * - CredentialInputForm             // enter SA (mnemonic) + UserCred + AdminFactor
 * - ReleaseStatusChecker            // check if authority has released AdminFactor
 * - PathActivationWizard            // step-by-step activation flow
 * - BalanceDisplay                  // show BTC/ETH/SOL balances after activation
 * - TransferPrompt                  // guide recipient to transfer to own wallet
 *
 * Exports:
 * - renderClaimPortal(container)
 * - renderActivationResult(container, result)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS = [
  { number: 1, title: 'Enter SA Mnemonic', key: 'mnemonic' },
  { number: 2, title: 'Enter UserCred Passphrase', key: 'usercred' },
  { number: 3, title: 'Enter AdminFactor', key: 'adminfactor' },
  { number: 4, title: 'Activate Path', key: 'activate' },
  { number: 5, title: 'Transfer Assets', key: 'transfer' },
];

const CHAINS = [
  { value: 'btc', label: 'Bitcoin (BTC)' },
  { value: 'eth', label: 'Ethereum (ETH)' },
  { value: 'sol', label: 'Solana (SOL)' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBalance(amount) {
  if (amount == null || isNaN(amount)) return '0.00';
  if (amount === 0) return '0.00';
  if (amount < 0.0001) return amount.toExponential(2);
  return parseFloat(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

const _portalState = {
  currentStep: 1,
  mnemonic: '',
  usercred: '',
  adminfactor: '',
  status: 'waiting', // 'waiting' | 'released' | 'activated'
  balances: null,
  error: null,
  _retrievingAF: false,
};

function _resetState() {
  _portalState.currentStep = 1;
  _portalState.mnemonic = '';
  _portalState.usercred = '';
  _portalState.adminfactor = '';
  _portalState.status = 'waiting';
  _portalState.balances = null;
  _portalState.error = null;
  _portalState._retrievingAF = false;
}

// ---------------------------------------------------------------------------
// Status Indicator
// ---------------------------------------------------------------------------

function _renderStatusIndicator(status) {
  const statusConfig = {
    waiting: {
      cls: 'status-waiting',
      text: 'Waiting for authority release',
    },
    released: {
      cls: 'status-released',
      text: 'AdminFactor released — ready to activate',
    },
    activated: {
      cls: 'status-activated',
      text: 'Path activated — assets accessible',
    },
  };

  const cfg = statusConfig[status] || statusConfig.waiting;
  return `
    <div class="claim-status ${cfg.cls}">
      <span class="status-dot"></span>
      <span>${cfg.text}</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step Renderers
// ---------------------------------------------------------------------------

function _stepClass(stepNum) {
  if (stepNum < _portalState.currentStep) return 'step-complete';
  if (stepNum === _portalState.currentStep) return 'step-active';
  return 'step-disabled';
}

function _stepNumberContent(stepNum) {
  if (stepNum < _portalState.currentStep) return '&#10003;';
  return stepNum;
}

function _renderStep1() {
  return `
    <div class="claim-step ${_stepClass(1)}" data-step="1">
      <div class="claim-step-header">
        <div class="claim-step-number">${_stepNumberContent(1)}</div>
        <div class="claim-step-title">Enter SA Mnemonic</div>
      </div>
      <div class="claim-step-content">
        <div class="form-group">
          <label class="form-label">Sealed Artifact (24-word mnemonic)</label>
          <textarea class="form-textarea" id="claimMnemonic" rows="3"
            placeholder="Enter the 24-word mnemonic provided to you..."
            ${_portalState.currentStep !== 1 ? 'disabled' : ''}
          >${escapeHTML(_portalState.mnemonic)}</textarea>
          <div class="form-hint">This is the encrypted credential mnemonic, not a wallet seed phrase.</div>
        </div>
        ${_portalState.currentStep === 1 ? `
          <button class="btn-add-recipient" data-action="next-step" data-step="1" style="margin-top:4px;">
            Continue
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function _renderStep2() {
  return `
    <div class="claim-step ${_stepClass(2)}" data-step="2">
      <div class="claim-step-header">
        <div class="claim-step-number">${_stepNumberContent(2)}</div>
        <div class="claim-step-title">Enter UserCred Passphrase</div>
      </div>
      <div class="claim-step-content">
        <div class="form-group">
          <label class="form-label">UserCred Passphrase</label>
          <input class="form-input" type="password" id="claimUserCred"
            placeholder="Enter the passphrase provided to you"
            ${_portalState.currentStep !== 2 ? 'disabled' : ''}
            value="${escapeHTML(_portalState.usercred)}" />
          <div class="form-hint">The passphrase you received along with the SA mnemonic.</div>
        </div>
        ${_portalState.currentStep === 2 ? `
          <button class="btn-add-recipient" data-action="next-step" data-step="2" style="margin-top:4px;">
            Continue
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function _renderStep3() {
  const isActive = _portalState.currentStep === 3;
  const isRetrieving = isActive && _portalState._retrievingAF;
  return `
    <div class="claim-step ${_stepClass(3)}" data-step="3">
      <div class="claim-step-header">
        <div class="claim-step-number">${_stepNumberContent(3)}</div>
        <div class="claim-step-title">AdminFactor</div>
      </div>
      <div class="claim-step-content">
        ${isActive ? `
          <div class="alert-banner alert-info" style="margin-bottom:8px;">
            <span class="alert-icon">&#8505;</span>
            AdminFactor can be retrieved automatically from the on-chain vault, or entered manually.
          </div>
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <button class="btn-add-recipient" data-action="retrieve-af-onchain"
              style="flex:1;${isRetrieving ? 'opacity:0.6;pointer-events:none;' : ''}"
              ${isRetrieving ? 'disabled' : ''}>
              ${isRetrieving ? 'Retrieving...' : 'Retrieve from On-Chain Vault'}
            </button>
          </div>
          <div style="text-align:center;font-size:11px;color:var(--text-secondary);margin-bottom:8px;">— or enter manually —</div>
        ` : ''}
        <div class="form-group">
          <label class="form-label">AdminFactor or blob (hex)</label>
          <input class="form-input" type="text" id="claimAdminFactor"
            placeholder="64-char (AF only) or 80-char (AF+amount blob)"
            ${!isActive ? 'disabled' : ''}
            value="${escapeHTML(_portalState.adminfactor)}" maxlength="82" />
          <div class="form-hint">
            64-char = AdminFactor only. 80-char = blob (AdminFactor + amount).
          </div>
        </div>
        ${isActive ? `
          <button class="btn-add-recipient" data-action="next-step" data-step="3" style="margin-top:4px;">
            Continue
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function _renderStep4() {
  const isActive = _portalState.currentStep === 4;
  const isLoading = isActive && _portalState.status === 'activating';

  return `
    <div class="claim-step ${_stepClass(4)}" data-step="4">
      <div class="claim-step-header">
        <div class="claim-step-number">${_stepNumberContent(4)}</div>
        <div class="claim-step-title">Activate Path</div>
      </div>
      <div class="claim-step-content">
        ${isLoading ? `
          <div class="release-spinner">
            <div class="spinner"></div>
          </div>
          <div style="text-align:center;font-size:12px;color:var(--text-secondary);margin-top:8px;">
            Activating authorization path... This may take a moment.
          </div>
        ` : `
          <div class="alert-banner alert-info">
            <span class="alert-icon">&#8505;</span>
            Activation will reconstruct the composite credential, unseal the REV, and derive keys for all chains.
          </div>
          ${isActive ? `
            <button class="btn-add-recipient" data-action="activate-path" style="margin-top:4px;border-color:var(--success);color:var(--success);">
              Activate Path
            </button>
          ` : ''}
        `}
      </div>
    </div>
  `;
}

function _renderStep5() {
  const balances = _portalState.balances;

  return `
    <div class="claim-step ${_stepClass(5)}" data-step="5">
      <div class="claim-step-header">
        <div class="claim-step-number">${_stepNumberContent(5)}</div>
        <div class="claim-step-title">Transfer Assets</div>
      </div>
      <div class="claim-step-content">
        ${balances ? _renderBalances(balances) : ''}
        ${_portalState.currentStep === 5 ? _renderTransferForm() : ''}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Balance Display
// ---------------------------------------------------------------------------

function _renderBalances(balances) {
  const items = [
    { chain: 'BTC', amount: balances.btc, usd: balances.btcUsd },
    { chain: 'ETH', amount: balances.eth, usd: balances.ethUsd },
    { chain: 'SOL', amount: balances.sol, usd: balances.solUsd },
  ].filter((b) => b.amount != null);

  if (items.length === 0) {
    return `
      <div class="release-empty" style="padding:20px;">
        <div class="empty-title">No balances found</div>
        <div class="empty-desc">The released wallet does not hold any detectable assets.</div>
      </div>
    `;
  }

  const cards = items.map((b) => `
    <div class="balance-item">
      <div class="balance-chain">${escapeHTML(b.chain)}</div>
      <div class="balance-amount">${formatBalance(b.amount)}</div>
      ${b.usd != null ? `<div class="balance-usd">~$${formatBalance(b.usd)}</div>` : ''}
    </div>
  `).join('');

  return `<div class="balance-grid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Transfer Form
// ---------------------------------------------------------------------------

function _renderTransferForm() {
  const chainOpts = CHAINS.map(
    (c) => `<option value="${c.value}">${escapeHTML(c.label)}</option>`
  ).join('');

  return `
    <div class="transfer-section">
      <h4>Transfer to Your Wallet</h4>

      <div class="form-group">
        <label class="form-label">Chain</label>
        <select class="form-select" id="transferChain">
          ${chainOpts}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Recipient Address</label>
        <input class="form-input" type="text" id="transferAddress"
          placeholder="Enter your wallet address" />
      </div>

      <div class="form-group">
        <label class="form-label">Amount</label>
        <input class="form-input" type="number" id="transferAmount"
          placeholder="0.00" step="any" min="0" />
        <div class="form-hint">Leave blank to transfer the full balance.</div>
      </div>

      <button class="btn-add-recipient" data-action="send-transfer"
        style="margin-top:8px;border-color:var(--primary);color:var(--primary);">
        Send Transfer
      </button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Error Display
// ---------------------------------------------------------------------------

function _renderError(error) {
  if (!error) return '';
  return `
    <div class="alert-banner alert-critical" data-component="claim-error">
      <span class="alert-icon">&#9888;</span>
      ${escapeHTML(error)}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Portal Renderer
// ---------------------------------------------------------------------------

/**
 * Render the full recipient claim portal.
 * @param {HTMLElement} container
 */
function renderClaimPortal(container) {
  if (!container) return;

  _resetState();

  container.innerHTML = `
    <div class="yallet-release" data-component="claim-portal">
      <h2>Asset Claim Portal</h2>

      ${_renderStatusIndicator(_portalState.status)}
      <div data-component="claim-error-slot"></div>

      <div class="claim-wizard" data-component="claim-wizard">
        ${_renderStep1()}
        ${_renderStep2()}
        ${_renderStep3()}
        ${_renderStep4()}
        ${_renderStep5()}
      </div>
    </div>
  `;

  _attachPortalEvents(container);
}

/**
 * Re-render the wizard steps (called after state change).
 * @param {HTMLElement} container
 */
function _refreshWizard(container) {
  const wizard = container.querySelector('[data-component="claim-wizard"]');
  if (!wizard) return;

  wizard.innerHTML = `
    ${_renderStep1()}
    ${_renderStep2()}
    ${_renderStep3()}
    ${_renderStep4()}
    ${_renderStep5()}
  `;

  // Update status indicator
  const portal = container.querySelector('[data-component="claim-portal"]');
  if (portal) {
    const statusEl = portal.querySelector('.claim-status');
    if (statusEl) {
      const temp = document.createElement('div');
      temp.innerHTML = _renderStatusIndicator(_portalState.status);
      statusEl.replaceWith(temp.firstElementChild);
    }
  }

  // Update error
  const errorSlot = container.querySelector('[data-component="claim-error-slot"]');
  if (errorSlot) {
    errorSlot.innerHTML = _renderError(_portalState.error);
  }
}

// ---------------------------------------------------------------------------
// Activation Result (called externally after path activation)
// ---------------------------------------------------------------------------

/**
 * Show activation result with balances.
 * Called by the release module after successful activation.
 * @param {HTMLElement} container
 * @param {object} result
 * @param {object} result.balances - { btc, btcUsd, eth, ethUsd, sol, solUsd }
 * @param {string} [result.error]
 */
function renderActivationResult(container, result) {
  if (!container) return;

  if (result.error) {
    _portalState.error = result.error;
    _portalState.status = 'waiting';
    _portalState.currentStep = 4;
    _refreshWizard(container);
    return;
  }

  _portalState.status = 'activated';
  _portalState.balances = result.balances || {};
  _portalState.currentStep = 5;
  _portalState.error = null;

  _refreshWizard(container);
}

// ---------------------------------------------------------------------------
// Event Delegation
// ---------------------------------------------------------------------------

function _attachPortalEvents(container) {
  container.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    switch (action) {
      case 'next-step': {
        const stepNum = parseInt(target.dataset.step, 10);
        _handleNextStep(container, stepNum);
        break;
      }

      case 'retrieve-af-onchain':
        _handleRetrieveAFOnChain(container);
        break;

      case 'activate-path':
        _handleActivate(container);
        break;

      case 'send-transfer':
        _handleTransfer(container);
        break;

      default:
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Step Handlers
// ---------------------------------------------------------------------------

function _handleNextStep(container, fromStep) {
  _portalState.error = null;

  if (fromStep === 1) {
    const textarea = container.querySelector('#claimMnemonic');
    const value = textarea ? textarea.value.trim() : '';
    if (!value) {
      _portalState.error = 'Please enter the SA mnemonic.';
      _refreshWizard(container);
      return;
    }
    // Basic validation: should have 24 words
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length !== 24) {
      _portalState.error = `Expected 24 words, got ${words.length}. Please check your mnemonic.`;
      _refreshWizard(container);
      return;
    }
    _portalState.mnemonic = value;
    _portalState.currentStep = 2;
  }

  if (fromStep === 2) {
    const input = container.querySelector('#claimUserCred');
    const value = input ? input.value.trim() : '';
    if (!value) {
      _portalState.error = 'Please enter the UserCred passphrase.';
      _refreshWizard(container);
      return;
    }
    _portalState.usercred = value;
    _portalState.currentStep = 3;
  }

  if (fromStep === 3) {
    const input = container.querySelector('#claimAdminFactor');
    const value = input ? input.value.trim() : '';
    if (!value) {
      _portalState.error = 'Please enter the AdminFactor.';
      _refreshWizard(container);
      return;
    }
    _portalState.adminfactor = value;
    _portalState.status = 'released';
    _portalState.currentStep = 4;
  }

  _refreshWizard(container);
}

/**
 * Retrieve encrypted AF from AdminFactorVault on-chain, decrypt with recipient's
 * xidentity private key, and auto-fill the AdminFactor input.
 *
 * Dispatches 'release:retrieve-af' event for the release module to handle decryption
 * (since the private key is in the wallet extension, not accessible here).
 */
async function _handleRetrieveAFOnChain(container) {
  _portalState._retrievingAF = true;
  _portalState.error = null;
  _refreshWizard(container);

  // Dispatch event for the release module to handle the on-chain retrieval + decryption.
  // The release module has access to the wallet provider and can:
  //   1. Call AdminFactorVault.retrieve(walletIdHash, recipientIndex)
  //   2. Decrypt the ciphertext with the recipient's xidentity private key
  //   3. Return the plaintext AF hex
  container.dispatchEvent(new CustomEvent('release:retrieve-af', {
    bubbles: true,
    detail: {
      callback: (result) => {
        _portalState._retrievingAF = false;
        if (result.error) {
          _portalState.error = result.error;
        } else if (result.adminfactor) {
          _portalState.adminfactor = result.adminfactor;
          // Auto-fill the input
          const input = container.querySelector('#claimAdminFactor');
          if (input) input.value = result.adminfactor;
        }
        _refreshWizard(container);
      },
    },
  }));
}

function _handleActivate(container) {
  _portalState.error = null;
  _portalState.status = 'activating';
  _refreshWizard(container);

  // Dispatch custom event for the release module to handle actual activation
  container.dispatchEvent(new CustomEvent('release:activate-path', {
    bubbles: true,
    detail: {
      mnemonic: _portalState.mnemonic,
      usercred: _portalState.usercred,
      adminfactor: _portalState.adminfactor,
    },
  }));
}

function _handleTransfer(container) {
  const chain = container.querySelector('#transferChain')?.value || '';
  const address = container.querySelector('#transferAddress')?.value.trim() || '';
  const amountStr = container.querySelector('#transferAmount')?.value.trim() || '';

  if (!address) {
    _portalState.error = 'Please enter a recipient address.';
    _refreshWizard(container);
    return;
  }

  const amount = amountStr ? parseFloat(amountStr) : null; // null = full balance

  container.dispatchEvent(new CustomEvent('release:transfer', {
    bubbles: true,
    detail: { chain, address, amount },
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  renderClaimPortal,
  renderActivationResult,
};
