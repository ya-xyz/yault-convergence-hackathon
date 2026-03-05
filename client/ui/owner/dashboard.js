/**
 * dashboard.js — Owner Release Dashboard UI
 *
 * Main release management panel embedded in Yallet wallet.
 *
 * Components:
 * - ReleaseDashboard                // top-level container
 *   +-- ReleaseStatus               // path status summary (active / triggered / released)
 *   +-- AuthorityBindings           // authority cards with verification badges
 *   +-- RecipientPathList           // recipient cards with status
 *   |   +-- RecipientPathCard       // individual path: label, status, actions
 *   +-- AddRecipientForm            // create new path wizard
 *   +-- CredentialExportModal       // QR / PDF export
 *   +-- ReplaceAuthorityFlow        // authority replacement wizard
 *
 * Exports:
 * - renderReleaseDashboard(container)
 * - updateReleaseStatus(container, paths)
 * - updateRecipientList(container, paths)
 * - updateAuthorityBindings(container, bindings)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a relative time duration from milliseconds.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g. "11m 27d")
 */
function formatDuration(ms) {
  if (ms <= 0) return 'Expired';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);

  if (months > 0) {
    const remainDays = days - months * 30;
    return `${months}m ${remainDays}d`;
  }
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Format a timestamp to relative past time.
 * @param {number} ts - Unix timestamp (ms)
 * @returns {string}
 */
function timeAgo(ts) {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Render star rating HTML.
 * @param {number} rating - 0 to 5
 * @returns {string}
 */
function renderStars(rating) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${i <= Math.round(rating) ? '' : ' empty'}">&#9733;</span>`;
  }
  return html;
}

/**
 * Generate a unique DOM id.
 * @returns {string}
 */
function uid() {
  return 'yi_' + Math.random().toString(36).slice(2, 9);
}

// ---------------------------------------------------------------------------
// ReleaseStatus
// ---------------------------------------------------------------------------

/**
 * Derive a summary of path statuses from a list of recipient paths.
 * @param {Array} paths
 * @returns {{ active: number, triggered: number, released: number, total: number }}
 */
function _summarizePathStatuses(paths) {
  const summary = { active: 0, triggered: 0, released: 0, total: 0 };
  if (!paths || paths.length === 0) return summary;
  paths.forEach((p) => {
    summary.total++;
    if (p.status === 'triggered') summary.triggered++;
    else if (p.status === 'released' || p.status === 'activated') summary.released++;
    else summary.active++;
  });
  return summary;
}

/**
 * Determine overall release status CSS class.
 * @param {{ active: number, triggered: number, released: number }} summary
 * @returns {string}
 */
function _releaseStatusClass(summary) {
  if (summary.released > 0) return 'status-released';
  if (summary.triggered > 0) return 'status-triggered';
  return 'status-active';
}

/**
 * Build release status bar HTML.
 * Shows an at-a-glance overview of all recipient path statuses.
 * @param {Array} paths - Recipient path objects
 * @returns {string}
 */
function renderReleaseStatusHTML(paths) {
  const summary = _summarizePathStatuses(paths);
  const cls = _releaseStatusClass(summary);

  if (summary.total === 0) {
    return `
      <div class="release-status ${cls}" data-component="release-status">
        <div class="release-status-dot"></div>
        <div class="status-info">
          <div class="status-label">Release Status</div>
          <div class="status-value">No paths configured</div>
        </div>
      </div>
    `;
  }

  const parts = [];
  if (summary.active > 0) parts.push(`${summary.active} active`);
  if (summary.triggered > 0) parts.push(`${summary.triggered} triggered`);
  if (summary.released > 0) parts.push(`${summary.released} released`);

  return `
    <div class="release-status ${cls}" data-component="release-status">
      <div class="release-status-dot"></div>
      <div class="status-info">
        <div class="status-label">Release Status</div>
        <div class="status-value">${parts.join(' &middot; ')}</div>
      </div>
      <div class="status-total">
        <div class="status-total-count">${summary.total}</div>
        <div class="status-total-label">path${summary.total !== 1 ? 's' : ''}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// AuthorityBindings
// ---------------------------------------------------------------------------

/**
 * Build authority bindings section HTML.
 * @param {Array} bindings
 * @returns {string}
 */
function renderAuthorityBindingsHTML(bindings) {
  if (!bindings || bindings.length === 0) {
    return `
      <h3>Authority Nodes</h3>
      <div class="release-empty">
        <div class="empty-icon">&#9878;</div>
        <div class="empty-title">No authorities bound</div>
        <div class="empty-desc">Bind an authority to enable the Guardian Protocol for your recipients.</div>
      </div>
    `;
  }

  const cards = bindings.map((b, idx) => {
    const initial = b.name ? b.name.charAt(0).toUpperCase() : '?';
    const verifiedHTML = b.verified
      ? '<span class="verified-badge" title="Verified">&#10003;</span>'
      : '';
    return `
      <div class="authority-card" data-action="authority-detail" data-index="${idx}">
        <div class="authority-avatar">${initial}</div>
        <div class="authority-details">
          <div class="authority-name">${escapeHTML(b.name || 'Unknown')} ${verifiedHTML}</div>
          <div class="authority-jurisdiction">${escapeHTML(b.jurisdiction || '')}</div>
        </div>
        <div class="authority-meta">
          <div class="authority-badge">E2E</div>
          <div class="authority-index">Authority #${idx + 1}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <h3>Authority Nodes</h3>
    <div class="authority-cards" data-component="authority-bindings">
      ${cards}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// RecipientPathList
// ---------------------------------------------------------------------------

/**
 * Build a single recipient card HTML.
 * @param {object} path
 * @param {number} index
 * @returns {string}
 */
function renderRecipientCardHTML(path, index) {
  const statusMap = {
    active: 'Active',
    triggered: 'Triggered',
    released: 'Released',
    activated: 'Activated',
    revoked: 'Revoked',
  };
  const statusText = statusMap[path.status] || 'Unknown';
  const statusClass = `status-${path.status || 'active'}`;

  // tlock countdown
  const remaining = path.tlock_expiry ? path.tlock_expiry - Date.now() : 0;
  const tlockHTML = path.tlock_expiry
    ? `<div class="tlock-countdown">
        <span class="tlock-icon">&#128274;</span>
        <span>Timelock expires in </span>
        <span class="tlock-time">${formatDuration(remaining)}</span>
      </div>`
    : '';

  return `
    <div class="recipient-card" data-path-index="${index}">
      <div class="recipient-card-header">
        <div class="recipient-label">${escapeHTML(path.label || `Recipient #${index + 1}`)}</div>
        <span class="recipient-status ${statusClass}">${statusText}</span>
      </div>
      ${tlockHTML}
      <div class="recipient-actions">
        <button class="btn-action" data-action="view-path" data-index="${index}">View</button>
        <button class="btn-action" data-action="export-creds" data-index="${index}">Export</button>
        <button class="btn-action btn-danger" data-action="revoke-path" data-index="${index}">Revoke</button>
      </div>
    </div>
  `;
}

/**
 * Build full recipient list HTML.
 * @param {Array} paths
 * @returns {string}
 */
function renderRecipientListHTML(paths) {
  if (!paths || paths.length === 0) {
    return `
      <h3>Recipient Paths</h3>
      <div class="release-empty">
        <div class="empty-icon">&#128101;</div>
        <div class="empty-title">No recipient paths</div>
        <div class="empty-desc">Create a recipient path to set up asset release for someone you trust.</div>
      </div>
      <button class="btn-add-recipient" data-action="add-recipient">
        <span>+</span> Add Recipient
      </button>
    `;
  }

  const cards = paths.map((p, i) => renderRecipientCardHTML(p, i)).join('');
  return `
    <h3>Recipient Paths</h3>
    <div class="recipient-cards" data-component="recipient-list">
      ${cards}
    </div>
    <button class="btn-add-recipient" data-action="add-recipient">
      <span>+</span> Add Recipient
    </button>
  `;
}

// ---------------------------------------------------------------------------
// AddRecipientForm (Modal)
// ---------------------------------------------------------------------------

/**
 * Build the "Add Recipient" modal HTML.
 * @returns {string}
 */
function renderAddRecipientModal() {
  return `
    <div class="yallet-modal-overlay" data-modal="add-recipient">
      <div class="yallet-modal">
        <div class="yallet-modal-header">
          <h3>Add Recipient Path</h3>
          <button class="yallet-modal-close" data-action="close-modal">&times;</button>
        </div>
        <div class="yallet-modal-body">
          <div class="form-group">
            <label class="form-label">Label</label>
            <input class="form-input" type="text" id="recipientLabel"
              placeholder="e.g. Spouse, Child, Sibling" maxlength="64" />
            <div class="form-hint">A human-readable name for this recipient path.</div>
          </div>
          <div class="alert-banner alert-info">
            <span class="alert-icon">&#8505;</span>
            Credentials (SA mnemonic + UserCred passphrase) will be auto-generated.
            You must securely deliver them to your recipient.
          </div>
        </div>
        <div class="yallet-modal-footer">
          <button class="btn btn-secondary" data-action="close-modal">Cancel</button>
          <button class="btn btn-primary" data-action="confirm-add-recipient">Create Path</button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// CredentialExportModal
// ---------------------------------------------------------------------------

/**
 * Build the credential export modal HTML.
 * @param {object} creds
 * @param {string} creds.mnemonic - SA mnemonic
 * @param {string} creds.passphrase - UserCred passphrase
 * @param {string} creds.label
 * @returns {string}
 */
function renderCredentialExportModal(creds) {
  const mnemonic = creds && creds.mnemonic ? creds.mnemonic : '(not available)';
  const passphrase = creds && creds.passphrase ? creds.passphrase : '(not available)';

  return `
    <div class="yallet-modal-overlay show" data-modal="credential-export">
      <div class="yallet-modal">
        <div class="yallet-modal-header">
          <h3>Credential Export${creds && creds.label ? ' — ' + escapeHTML(creds.label) : ''}</h3>
          <button class="yallet-modal-close" data-action="close-modal">&times;</button>
        </div>
        <div class="yallet-modal-body">
          <div class="alert-banner alert-critical">
            <span class="alert-icon">&#9888;</span>
            Store these credentials securely. They cannot be recovered if lost.
          </div>

          <div class="credential-display">
            <div class="credential-label">SA Mnemonic (24 words)</div>
            <div class="credential-value" id="credMnemonic">${escapeHTML(mnemonic)}</div>
          </div>

          <div class="credential-display">
            <div class="credential-label">UserCred Passphrase</div>
            <div class="credential-value" id="credPassphrase">${escapeHTML(passphrase)}</div>
          </div>

          <div class="qr-placeholder" id="credQRCode">
            QR Code Placeholder
          </div>

          <div class="form-hint" style="text-align:center;">
            The AdminFactor is held by your bound authority(s) and will only be released upon verified conditions.
          </div>
        </div>
        <div class="yallet-modal-footer">
          <button class="btn btn-secondary" data-action="download-pdf">Download PDF</button>
          <button class="btn btn-primary" data-action="close-modal">Done</button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ReplaceAuthorityFlow (Modal)
// ---------------------------------------------------------------------------

/**
 * Build the replace-authority confirmation modal.
 * @param {object} opts
 * @param {string} opts.oldName
 * @param {string} opts.newName
 * @param {number} opts.pathIndex
 * @returns {string}
 */
function renderReplaceAuthorityModal(opts) {
  return `
    <div class="yallet-modal-overlay show" data-modal="replace-authority">
      <div class="yallet-modal">
        <div class="yallet-modal-header">
          <h3>Replace Authority</h3>
          <button class="yallet-modal-close" data-action="close-modal">&times;</button>
        </div>
        <div class="yallet-modal-body">
          <div class="alert-banner alert-warning">
            <span class="alert-icon">&#9888;</span>
            Replacing an authority will re-encrypt the AdminFactor and distribute to all authorities.
          </div>
          <div class="bind-confirm-detail">
            <div class="bind-confirm-row">
              <span class="label">Removing</span>
              <span class="value">${escapeHTML(opts.oldName || 'Current firm')}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Adding</span>
              <span class="value">${escapeHTML(opts.newName || 'New firm')}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Encryption</span>
              <span class="value">E2E encrypted</span>
            </div>
          </div>
        </div>
        <div class="yallet-modal-footer">
          <button class="btn btn-secondary" data-action="close-modal">Cancel</button>
          <button class="btn btn-danger" data-action="confirm-replace-authority" data-path-index="${opts.pathIndex}">Replace</button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Escaper
// ---------------------------------------------------------------------------

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Main Dashboard Renderer
// ---------------------------------------------------------------------------

/**
 * Render the full release dashboard into a container element.
 * @param {HTMLElement} container
 * @param {object} [data] - Optional initial data
 * @param {Array}  [data.bindings]
 * @param {Array}  [data.paths]
 */
function renderReleaseDashboard(container, data) {
  if (!container) return;

  const bindings = (data && data.bindings) || [];
  const paths = (data && data.paths) || [];

  container.innerHTML = `
    <div class="yallet-release" data-component="release-dashboard">
      <h2>Release Dashboard</h2>
      ${renderReleaseStatusHTML(paths)}
      ${renderAuthorityBindingsHTML(bindings)}
      ${renderRecipientListHTML(paths)}
      ${renderAddRecipientModal()}
    </div>
  `;

  // Attach event delegation
  _attachDashboardEvents(container);
}

// ---------------------------------------------------------------------------
// Partial Updates
// ---------------------------------------------------------------------------

/**
 * Update the release status bar.
 * @param {HTMLElement} container
 * @param {Array} paths - Current recipient path objects
 */
function updateReleaseStatus(container, paths) {
  if (!container) return;
  const el = container.querySelector('[data-component="release-status"]');
  if (el) {
    const temp = document.createElement('div');
    temp.innerHTML = renderReleaseStatusHTML(paths);
    el.replaceWith(temp.firstElementChild);
  }
}

/**
 * Update the recipient path list.
 * @param {HTMLElement} container
 * @param {Array} paths
 */
function updateRecipientList(container, paths) {
  if (!container) return;
  const listEl = container.querySelector('[data-component="recipient-list"]');
  // Find the section containing the recipient cards (or the empty state)
  const dashboard = container.querySelector('[data-component="release-dashboard"]');
  if (!dashboard) return;

  // Remove existing recipient section elements
  const existingH3 = Array.from(dashboard.querySelectorAll('h3')).find(
    (h) => h.textContent === 'Recipient Paths'
  );
  if (existingH3) existingH3.remove();
  if (listEl) listEl.remove();
  const existingEmpty = dashboard.querySelector('.release-empty');
  // Only remove the recipient empty state, not the authority one
  if (existingEmpty && existingEmpty.querySelector('.empty-title')?.textContent === 'No recipient paths') {
    existingEmpty.remove();
  }
  const existingAddBtn = dashboard.querySelector('.btn-add-recipient');
  if (existingAddBtn) existingAddBtn.remove();

  // Build new HTML fragment
  const temp = document.createElement('div');
  temp.innerHTML = renderRecipientListHTML(paths);

  // Insert before the modal overlay
  const modalOverlay = dashboard.querySelector('.yallet-modal-overlay');
  while (temp.firstChild) {
    if (modalOverlay) {
      dashboard.insertBefore(temp.firstChild, modalOverlay);
    } else {
      dashboard.appendChild(temp.firstChild);
    }
  }
}

/**
 * Update the authority bindings section.
 * @param {HTMLElement} container
 * @param {Array} bindings
 */
function updateAuthorityBindings(container, bindings) {
  if (!container) return;
  const dashboard = container.querySelector('[data-component="release-dashboard"]');
  if (!dashboard) return;

  // Remove existing authority section
  const existingCards = dashboard.querySelector('[data-component="authority-bindings"]');
  const existingH3 = Array.from(dashboard.querySelectorAll('h3')).find(
    (h) => h.textContent === 'Authority Nodes'
  );
  if (existingH3) existingH3.remove();
  if (existingCards) existingCards.remove();
  // Remove authority empty state if present
  const emptyStates = dashboard.querySelectorAll('.release-empty');
  emptyStates.forEach((el) => {
    if (el.querySelector('.empty-title')?.textContent === 'No authorities bound') {
      el.remove();
    }
  });

  // Build new HTML
  const temp = document.createElement('div');
  temp.innerHTML = renderAuthorityBindingsHTML(bindings);

  // Insert after the release status bar
  const statusEl = dashboard.querySelector('.release-status');
  let insertRef = statusEl ? statusEl.nextSibling : null;
  if (!insertRef) {
    // fallback: insert after h2
    const h2 = dashboard.querySelector('h2');
    insertRef = h2 ? h2.nextSibling : dashboard.firstChild;
  }

  while (temp.firstChild) {
    dashboard.insertBefore(temp.firstChild, insertRef);
  }
}

// ---------------------------------------------------------------------------
// Event Delegation
// ---------------------------------------------------------------------------

/**
 * Attach event listeners to the dashboard using event delegation.
 * @param {HTMLElement} container
 */
function _attachDashboardEvents(container) {
  container.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const index = target.dataset.index != null ? parseInt(target.dataset.index, 10) : null;

    switch (action) {
      case 'add-recipient':
        _openModal(container, 'add-recipient');
        break;

      case 'close-modal':
        _closeAllModals(container);
        break;

      case 'confirm-add-recipient':
        _handleAddRecipient(container);
        break;

      case 'view-path':
        _handleViewPath(container, index);
        break;

      case 'export-creds':
        _handleExportCreds(container, index);
        break;

      case 'revoke-path':
        _handleRevokePath(container, index);
        break;

      case 'download-pdf':
        _handleDownloadPDF(container);
        break;

      case 'authority-detail':
        _handleAuthorityDetail(container, index);
        break;

      case 'confirm-replace-authority':
        _handleConfirmReplaceAuthority(container, target.dataset.pathIndex);
        break;

      default:
        break;
    }
  });

  // Close modals on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      _closeAllModals(container);
    }
  });

  // Close modal on overlay click
  container.addEventListener('click', (e) => {
    if (e.target.classList.contains('yallet-modal-overlay')) {
      e.target.classList.remove('show');
    }
  });
}

// ---------------------------------------------------------------------------
// Modal Management
// ---------------------------------------------------------------------------

function _openModal(container, modalName) {
  const overlay = container.querySelector(`[data-modal="${modalName}"]`);
  if (overlay) {
    overlay.classList.add('show');
    // Focus first input
    const input = overlay.querySelector('input');
    if (input) setTimeout(() => input.focus(), 100);
  }
}

function _closeAllModals(container) {
  const overlays = container.querySelectorAll('.yallet-modal-overlay');
  overlays.forEach((o) => o.classList.remove('show'));
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

/**
 * Handle "Create Path" button click.
 * Dispatches a custom event with the label value.
 */
function _handleAddRecipient(container) {
  const labelInput = container.querySelector('#recipientLabel');
  const label = labelInput ? labelInput.value.trim() : '';

  if (!label) {
    _shakeInput(labelInput);
    return;
  }

  // Dispatch custom event for the release module to handle
  container.dispatchEvent(new CustomEvent('release:create-path', {
    bubbles: true,
    detail: { label },
  }));

  // Close modal
  _closeAllModals(container);

  // Clear input
  if (labelInput) labelInput.value = '';
}

/**
 * Handle "View" button on a recipient card.
 */
function _handleViewPath(container, index) {
  container.dispatchEvent(new CustomEvent('release:view-path', {
    bubbles: true,
    detail: { index },
  }));
}

/**
 * Handle "Export" button on a recipient card.
 * Shows the credential export modal via custom event.
 */
function _handleExportCreds(container, index) {
  container.dispatchEvent(new CustomEvent('release:export-creds', {
    bubbles: true,
    detail: { index },
  }));
}

/**
 * Handle "Revoke" button on a recipient card.
 */
function _handleRevokePath(container, index) {
  container.dispatchEvent(new CustomEvent('release:revoke-path', {
    bubbles: true,
    detail: { index },
  }));
}

/**
 * Handle "Download PDF" button in credential modal.
 */
function _handleDownloadPDF(container) {
  container.dispatchEvent(new CustomEvent('release:download-pdf', {
    bubbles: true,
  }));
}

/**
 * Handle click on an authority card.
 */
function _handleAuthorityDetail(container, index) {
  container.dispatchEvent(new CustomEvent('release:authority-detail', {
    bubbles: true,
    detail: { index },
  }));
}

/**
 * Handle confirming an authority replacement.
 */
function _handleConfirmReplaceAuthority(container, pathIndex) {
  container.dispatchEvent(new CustomEvent('release:replace-authority', {
    bubbles: true,
    detail: { pathIndex: parseInt(pathIndex, 10) },
  }));
  _closeAllModals(container);
}

// ---------------------------------------------------------------------------
// UI Feedback Helpers
// ---------------------------------------------------------------------------

function _shakeInput(el) {
  if (!el) return;
  el.style.borderColor = 'var(--danger)';
  el.style.animation = 'none';
  void el.offsetWidth; // trigger reflow
  el.style.animation = 'shake 0.3s ease';
  setTimeout(() => {
    el.style.borderColor = '';
    el.style.animation = '';
  }, 600);
}

// ---------------------------------------------------------------------------
// Public API: show credential export modal (called externally)
// ---------------------------------------------------------------------------

/**
 * Show the credential export modal with provided credentials.
 * This is intended to be called by the release module after
 * generating credentials.
 * @param {HTMLElement} container
 * @param {object} creds
 */
function showCredentialExport(container, creds) {
  if (!container) return;

  // Remove any existing export modal
  const existing = container.querySelector('[data-modal="credential-export"]');
  if (existing) existing.remove();

  // Append new modal
  const dashboard = container.querySelector('[data-component="release-dashboard"]');
  if (!dashboard) return;

  const temp = document.createElement('div');
  temp.innerHTML = renderCredentialExportModal(creds);
  dashboard.appendChild(temp.firstElementChild);
}

/**
 * Show the replace-authority modal.
 * @param {HTMLElement} container
 * @param {object} opts
 */
function showReplaceAuthorityModal(container, opts) {
  if (!container) return;

  const existing = container.querySelector('[data-modal="replace-authority"]');
  if (existing) existing.remove();

  const dashboard = container.querySelector('[data-component="release-dashboard"]');
  if (!dashboard) return;

  const temp = document.createElement('div');
  temp.innerHTML = renderReplaceAuthorityModal(opts);
  dashboard.appendChild(temp.firstElementChild);
}

// ---------------------------------------------------------------------------
// Shake animation (injected inline since we are in JS)
// ---------------------------------------------------------------------------

(function injectShakeKeyframe() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('yallet-shake-keyframe')) return;
  const style = document.createElement('style');
  style.id = 'yallet-shake-keyframe';
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-4px); }
      40% { transform: translateX(4px); }
      60% { transform: translateX(-3px); }
      80% { transform: translateX(2px); }
    }
  `;
  document.head.appendChild(style);
})();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  renderReleaseDashboard,
  updateReleaseStatus,
  updateRecipientList,
  updateAuthorityBindings,
  showCredentialExport,
  showReplaceAuthorityModal,
};
