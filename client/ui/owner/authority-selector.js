/**
 * authority-selector.js — Authority Search & Selection UI
 *
 * Components:
 * - AuthoritySearchPanel            // search by region, language, specialization
 * - AuthorityCard                   // name, rating, jurisdiction, capacity, fee structure
 * - AuthorityDetailModal            // detailed profile view
 * - AuthorityBindConfirmation       // confirm binding, display encryption config
 *
 * Exports:
 * - renderAuthoritySelector(container, onSelect)
 * - renderAuthorityCard(authority)
 * - showAuthorityDetail(container, authority)
 */

import { API_PROXY } from '../../../public/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGIONS = [
  { value: '', label: 'All Regions' },
  { value: 'US', label: 'United States' },
  { value: 'UK', label: 'United Kingdom' },
  { value: 'EU', label: 'European Union' },
  { value: 'SG', label: 'Singapore' },
  { value: 'HK', label: 'Hong Kong' },
  { value: 'JP', label: 'Japan' },
  { value: 'AU', label: 'Australia' },
  { value: 'CH', label: 'Switzerland' },
  { value: 'CA', label: 'Canada' },
];

const LANGUAGES = [
  { value: '', label: 'Any Language' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'ko', label: 'Korean' },
];

const SPECIALIZATIONS = [
  'Estate Planning',
  'Crypto / Digital Assets',
  'Trusts & Wills',
  'Tax Law',
  'International',
  'Family Law',
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

function renderStars(rating) {
  let html = '';
  const rounded = Math.round(rating || 0);
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${i <= rounded ? '' : ' empty'}">&#9733;</span>`;
  }
  return html;
}

function formatFeeBps(bps) {
  if (bps == null) return '--';
  return (bps / 100).toFixed(2) + '%';
}

// ---------------------------------------------------------------------------
// AuthorityCard Renderer
// ---------------------------------------------------------------------------

/**
 * Render a single authority card HTML.
 * @param {object} authority
 * @param {number} [index]
 * @returns {string} HTML string
 */
function renderAuthorityCard(authority, index) {
  const initial = authority.name ? authority.name.charAt(0).toUpperCase() : '?';
  const verifiedHTML = authority.verified
    ? '<span class="verified-badge" title="Verified">&#10003;</span>'
    : '';
  const capacityUsed = authority.active_bindings || 0;
  const capacityMax = authority.max_capacity || 100;
  const feeLabel = authority.fee_structure
    ? formatFeeBps(authority.fee_structure.base_fee_bps)
    : '--';

  return `
    <div class="authority-card" data-action="select-authority" data-authority-index="${index != null ? index : ''}">
      <div class="authority-avatar">${initial}</div>
      <div class="authority-details">
        <div class="authority-name">${escapeHTML(authority.name)} ${verifiedHTML}</div>
        <div class="authority-jurisdiction">${escapeHTML(authority.jurisdiction || authority.region || '')}</div>
        <div class="authority-rating">${renderStars(authority.rating)}</div>
        <div class="authority-capacity">${capacityUsed}/${capacityMax} clients</div>
      </div>
      <div class="authority-meta">
        <div class="authority-fee">${feeLabel}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Search Panel Renderer
// ---------------------------------------------------------------------------

/**
 * Build the search form HTML.
 * @returns {string}
 */
function _renderSearchForm() {
  const regionOpts = REGIONS.map(
    (r) => `<option value="${r.value}">${escapeHTML(r.label)}</option>`
  ).join('');

  const langOpts = LANGUAGES.map(
    (l) => `<option value="${l.value}">${escapeHTML(l.label)}</option>`
  ).join('');

  const specTags = SPECIALIZATIONS.map(
    (s) => `<span class="search-tag" data-spec="${escapeHTML(s)}">${escapeHTML(s)}</span>`
  ).join('');

  return `
    <div class="search-form" data-component="authority-search">
      <div class="search-row">
        <select class="form-select" id="lfSearchRegion">
          ${regionOpts}
        </select>
        <select class="form-select" id="lfSearchLanguage">
          ${langOpts}
        </select>
      </div>
      <div class="search-tags" data-component="spec-tags">
        ${specTags}
      </div>
      <button class="btn-add-recipient" data-action="search-authorities" style="margin-top:4px;">
        Search Authorities
      </button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Results Renderer
// ---------------------------------------------------------------------------

/**
 * Build the results area HTML.
 * @param {Array} results
 * @returns {string}
 */
function _renderResults(results) {
  if (!results) {
    return '<div class="authority-results" data-component="authority-results"></div>';
  }
  if (results.length === 0) {
    return `
      <div class="authority-results" data-component="authority-results">
        <div class="release-empty">
          <div class="empty-icon">&#128269;</div>
          <div class="empty-title">No firms found</div>
          <div class="empty-desc">Try adjusting your search filters.</div>
        </div>
      </div>
    `;
  }
  const cards = results.map((f, i) => renderAuthorityCard(f, i)).join('');
  return `
    <div class="authority-results" data-component="authority-results">
      ${cards}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Detail Modal
// ---------------------------------------------------------------------------

/**
 * Build the authority detail modal HTML and inject it.
 * @param {HTMLElement} container
 * @param {object} authority
 */
function showAuthorityDetail(container, authority) {
  if (!container || !authority) return;

  // Remove existing detail modal
  const existing = container.querySelector('[data-modal="authority-detail"]');
  if (existing) existing.remove();

  const verifiedHTML = authority.verified
    ? '<span class="verified-badge" title="Verified" style="width:18px;height:18px;font-size:10px;">&#10003;</span> Verified'
    : '<span style="color:var(--text-muted)">Unverified</span>';

  const specsHTML = (authority.specialization || [])
    .map((s) => `<span class="search-tag active">${escapeHTML(s)}</span>`)
    .join('');

  const langsHTML = (authority.languages || [])
    .map((l) => `<span class="search-tag">${escapeHTML(l)}</span>`)
    .join('');

  const feeLabel = authority.fee_structure
    ? formatFeeBps(authority.fee_structure.base_fee_bps)
    : '--';
  const flatFee = authority.fee_structure && authority.fee_structure.flat_fee_usd
    ? `$${authority.fee_structure.flat_fee_usd}`
    : '$0';

  const modalHTML = `
    <div class="yallet-modal-overlay show" data-modal="authority-detail">
      <div class="yallet-modal">
        <div class="yallet-modal-header">
          <h3>${escapeHTML(authority.name)}</h3>
          <button class="yallet-modal-close" data-action="close-detail-modal">&times;</button>
        </div>
        <div class="yallet-modal-body">
          <div class="bind-confirm-detail">
            <div class="bind-confirm-row">
              <span class="label">Jurisdiction</span>
              <span class="value">${escapeHTML(authority.jurisdiction || authority.region || '')}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Bar Number</span>
              <span class="value">${escapeHTML(authority.bar_number || '--')}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Rating</span>
              <span class="value">${renderStars(authority.rating)} (${authority.rating_count || 0})</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Capacity</span>
              <span class="value">${authority.active_bindings || 0} / ${authority.max_capacity || 100}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Verification</span>
              <span class="value">${verifiedHTML}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Base Fee</span>
              <span class="value">${feeLabel}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Flat Fee</span>
              <span class="value">${flatFee}</span>
            </div>
          </div>

          ${specsHTML ? `<div style="margin-bottom:8px;"><div class="form-label">Specializations</div><div class="search-tags">${specsHTML}</div></div>` : ''}
          ${langsHTML ? `<div><div class="form-label">Languages</div><div class="search-tags">${langsHTML}</div></div>` : ''}

          ${authority.email ? `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">Contact: ${escapeHTML(authority.email)}</div>` : ''}
          ${authority.website ? `<div style="font-size:12px;color:var(--text-secondary);">Website: ${escapeHTML(authority.website)}</div>` : ''}
        </div>
        <div class="yallet-modal-footer">
          <button class="btn btn-secondary" data-action="close-detail-modal">Close</button>
          <button class="btn btn-primary" data-action="bind-authority">Bind This Authority</button>
        </div>
      </div>
    </div>
  `;

  const wrapper = container.querySelector('.yallet-release') || container;
  const temp = document.createElement('div');
  temp.innerHTML = modalHTML;
  wrapper.appendChild(temp.firstElementChild);
}

// ---------------------------------------------------------------------------
// Bind Confirmation Dialog
// ---------------------------------------------------------------------------

/**
 * Show the bind confirmation dialog.
 * @param {HTMLElement} container
 * @param {object} authority
 */
function _showBindConfirmation(container, authority) {
  // Remove existing
  const existing = container.querySelector('[data-modal="bind-confirm"]');
  if (existing) existing.remove();

  const html = `
    <div class="yallet-modal-overlay show" data-modal="bind-confirm">
      <div class="yallet-modal">
        <div class="yallet-modal-header">
          <h3>Confirm Binding</h3>
          <button class="yallet-modal-close" data-action="close-bind-modal">&times;</button>
        </div>
        <div class="yallet-modal-body">
          <div class="alert-banner alert-info">
            <span class="alert-icon">&#8505;</span>
            Binding an authority grants them an encrypted copy of your AdminFactor.
            They cannot access your assets independently.
          </div>
          <div class="bind-confirm-detail">
            <div class="bind-confirm-row">
              <span class="label">Firm</span>
              <span class="value">${escapeHTML(authority.name)}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Jurisdiction</span>
              <span class="value">${escapeHTML(authority.jurisdiction || authority.region || '')}</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Encryption</span>
              <span class="value">E2E encrypted AdminFactor</span>
            </div>
            <div class="bind-confirm-row">
              <span class="label">Share Type</span>
              <span class="value">AdminFactor shard (no standalone capability)</span>
            </div>
          </div>
        </div>
        <div class="yallet-modal-footer">
          <button class="btn btn-secondary" data-action="close-bind-modal">Cancel</button>
          <button class="btn btn-primary" data-action="confirm-bind">Confirm Bind</button>
        </div>
      </div>
    </div>
  `;

  const wrapper = container.querySelector('.yallet-release') || container;
  const temp = document.createElement('div');
  temp.innerHTML = html;
  wrapper.appendChild(temp.firstElementChild);
}

// ---------------------------------------------------------------------------
// Main Selector Renderer
// ---------------------------------------------------------------------------

/**
 * Internal state for the current search context.
 */
const _state = {
  results: null,
  selectedSpecs: new Set(),
  onSelect: null,
  currentAuthority: null,
};

/**
 * Render the full authority search & selection panel.
 * @param {HTMLElement} container
 * @param {Function} onSelect - Callback called with the selected authority object
 */
function renderAuthoritySelector(container, onSelect) {
  if (!container) return;

  _state.onSelect = onSelect || null;
  _state.results = null;
  _state.selectedSpecs.clear();
  _state.currentAuthority = null;

  container.innerHTML = `
    <div class="yallet-release" data-component="authority-selector">
      <h2>Find an Authority</h2>
      ${_renderSearchForm()}
      ${_renderResults(null)}
    </div>
  `;

  _attachSelectorEvents(container);
}

// ---------------------------------------------------------------------------
// Event Delegation
// ---------------------------------------------------------------------------

function _attachSelectorEvents(container) {
  container.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) {
      // Check for spec tag toggle
      const tag = e.target.closest('.search-tag[data-spec]');
      if (tag) {
        _toggleSpec(tag);
      }
      return;
    }

    const action = target.dataset.action;

    switch (action) {
      case 'search-authorities':
        _performSearch(container);
        break;

      case 'select-authority': {
        const idx = parseInt(target.dataset.authorityIndex, 10);
        if (_state.results && _state.results[idx]) {
          _state.currentAuthority = _state.results[idx];
          showAuthorityDetail(container, _state.currentAuthority);
        }
        break;
      }

      case 'close-detail-modal': {
        const modal = container.querySelector('[data-modal="authority-detail"]');
        if (modal) modal.remove();
        break;
      }

      case 'bind-authority': {
        // Close detail modal and show bind confirmation
        const detailModal = container.querySelector('[data-modal="authority-detail"]');
        if (detailModal) detailModal.remove();
        if (_state.currentAuthority) {
          _showBindConfirmation(container, _state.currentAuthority);
        }
        break;
      }

      case 'close-bind-modal': {
        const modal = container.querySelector('[data-modal="bind-confirm"]');
        if (modal) modal.remove();
        break;
      }

      case 'confirm-bind': {
        const modal = container.querySelector('[data-modal="bind-confirm"]');
        if (modal) modal.remove();
        if (_state.currentAuthority && _state.onSelect) {
          _state.onSelect(_state.currentAuthority);
        }
        // Also dispatch custom event
        container.dispatchEvent(new CustomEvent('release:bind-authority', {
          bubbles: true,
          detail: { authority: _state.currentAuthority },
        }));
        break;
      }

      default:
        break;
    }
  });

  // Close modals on overlay click
  container.addEventListener('click', (e) => {
    if (e.target.classList.contains('yallet-modal-overlay')) {
      e.target.remove();
    }
  });
}

// ---------------------------------------------------------------------------
// Search Logic
// ---------------------------------------------------------------------------

function _toggleSpec(tagEl) {
  const spec = tagEl.dataset.spec;
  if (_state.selectedSpecs.has(spec)) {
    _state.selectedSpecs.delete(spec);
    tagEl.classList.remove('active');
  } else {
    _state.selectedSpecs.add(spec);
    tagEl.classList.add('active');
  }
}

async function _performSearch(container) {
  const region = container.querySelector('#lfSearchRegion')?.value || '';
  const language = container.querySelector('#lfSearchLanguage')?.value || '';
  const specs = Array.from(_state.selectedSpecs);

  // Show loading state
  const resultsEl = container.querySelector('[data-component="authority-results"]');
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="release-spinner">
        <div class="spinner"></div>
      </div>
    `;
  }

  try {
    const params = new URLSearchParams();
    if (region) params.set('region', region);
    if (language) params.set('language', language);
    if (specs.length > 0) params.set('specialization', specs.join(','));

    const baseUrl = API_PROXY.baseUrl || 'https://api.yault.xyz/api/v1';
    const url = `${baseUrl}/authority/search?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }

    const data = await response.json();
    _state.results = Array.isArray(data) ? data : (data.results || []);
  } catch (err) {
    console.error('[AuthoritySelector] Search error:', err);
    _state.results = [];
  }

  // Update results
  if (resultsEl) {
    const temp = document.createElement('div');
    temp.innerHTML = _renderResults(_state.results);
    resultsEl.replaceWith(temp.firstElementChild);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  renderAuthoritySelector,
  renderAuthorityCard,
  showAuthorityDetail,
};
