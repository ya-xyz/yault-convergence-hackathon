/**
 * app.js — Authority Dashboard Web Application
 *
 * Standalone web app for authorities to manage Yault asset release clients.
 *
 * Pages:
 * - Login (wallet connect: Phantom / MetaMask / manual Ed25519 keys)
 * - Client Overview (managed wallet_ids, share status)
 * - Pending Triggers (awaiting decision)
 * - Release Decision Form (release/hold/reject + evidence)
 * - Initiate (manual trigger initiation)
 * - Revenue Dashboard (accumulated, withdrawn, by-client)
 * - Settings (profile, pubkey, notifications)
 */

'use strict';

function T(key) { return (typeof window.t === 'function' ? window.t(key) : key); }

const API_BASE = (typeof YAULT_ENV !== 'undefined' && YAULT_ENV?.api?.baseUrl)
  ? YAULT_ENV.api.baseUrl
  : (window.location.port === '3001' ? '/api' : (window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : 'https://api.yault.xyz/api'));

// ─── Wallet Connector ───
let wallet = null;
let _e2eReady = false; // true once E2E client is initialized

// ─── State ───

let authoritySessionToken = null; // one sign → session token for all API calls

const state = {
  page: 'login',
  auth: null,       // { pubkey, authority_id, walletType, address }
  profile: null,
  profileEditMode: false,
  bindings: [],
  triggers: [],
  releaseLinks: [], // AdminFactor release links sent by clients (plan creation)
  revenue: { total: 0, withdrawn: 0, pending: 0, records: [] },
};

// ─── Navigation ───

const PAGES = ['overview', 'triggers', 'initiate', 'revenue', 'profile'];

// Jurisdiction options (same as Asset plan search authority)
const JURISDICTION_OPTIONS = [
  { value: '', label: 'Select jurisdiction' },
  { value: 'US', label: 'United States' },
  { value: 'UK', label: 'United Kingdom' },
  { value: 'EU', label: 'European Union' },
  { value: 'SG', label: 'Singapore' },
  { value: 'HK', label: 'Hong Kong' },
  { value: 'JP', label: 'Japan' },
  { value: 'CH', label: 'Switzerland' },
];
function jurisdictionLabel(code) {
  if (!code) return '—';
  const opt = JURISDICTION_OPTIONS.find((o) => o.value === code);
  return opt ? opt.label : code;
}

function navigate(page) {
  state.page = page;
  render();
}

// ─── Auth ───

function initWallet() {
  wallet = new WalletConnector({
    apiBase: API_BASE,
    onConnect: async (info) => {
      try {
        // Prefer client session from connectAndSignIn so we only trigger one Passkey
        const clientToken = wallet.authResult && wallet.authResult.session_token;
        let sessionData;
        if (clientToken) {
          const sessionResp = await fetch(`${API_BASE}/authority/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Client-Session': clientToken },
            body: JSON.stringify({}),
          });
          if (!sessionResp.ok) {
            const err = await sessionResp.json().catch(() => ({}));
            throw new Error(err.error || err.detail || 'Not registered as authority');
          }
          sessionData = await sessionResp.json();
        } else {
          const chalResp = await fetch(`${API_BASE}/auth/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: wallet.pubkey, wallet_type: wallet.walletType }),
          });
          if (!chalResp.ok) throw new Error('Failed to get auth challenge');
          const { challenge_id, challenge } = await chalResp.json();
          const sig = await wallet.signMessage(challenge);
          const sessionResp = await fetch(`${API_BASE}/authority/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challenge_id, signature: sig, wallet_type: wallet.walletType }),
          });
          if (!sessionResp.ok) {
            const err = await sessionResp.json().catch(() => ({}));
            throw new Error(err.error || err.detail || 'Not registered as authority');
          }
          sessionData = await sessionResp.json();
        }
        authoritySessionToken = sessionData.session_token;

        state.auth = {
          pubkey: wallet.pubkey,
          authority_id: sessionData.authority_id,
          walletType: wallet.walletType,
          address: wallet.address,
        };

        // Do not init E2E here: all API calls use X-Authority-Session (no extra Passkey).
        // _e2eReady stays false so apiFetch always uses session token.

        state.page = 'overview';
        await Promise.allSettled([loadProfile(), loadBindings(), loadTriggers(), loadReleaseLinks()]);
        render();
        showToast('Connected', 'success');
      } catch (err) {
        showToast('Login failed: ' + err.message, 'error');
      }
    },
    onDisconnect: () => {
      authoritySessionToken = null;
      state.auth = null;
      state.page = 'login';
      state.profile = null;
      state.bindings = [];
      state.triggers = [];
      state.releaseLinks = [];
      render();
    },
    onError: (msg) => {
      showToast(msg, 'error');
    },
  });
}

// ─── Data Loading ───

async function loadProfile() {
  try {
    const resp = await fetch(`${API_BASE}/authority/${encodeURIComponent(state.auth.authority_id)}`);
    if (resp.ok) state.profile = await resp.json();
  } catch { /* non-fatal */ }
}

async function loadBindings() {
  try {
    const resp = await apiFetch(`${API_BASE}/binding`);
    if (resp.ok) {
      const data = await resp.json();
      state.bindings = Array.isArray(data) ? data : (data.bindings || []);
    }
  } catch { /* non-fatal */ }
}

async function loadTriggers() {
  try {
    const resp = await apiFetch(`${API_BASE}/trigger/pending?status=all`);
    if (resp.ok) {
      const data = await resp.json();
      state.triggers = Array.isArray(data) ? data : (data.triggers || []);
    }
  } catch { /* non-fatal */ }
}

async function loadReleaseLinks() {
  try {
    const resp = await apiFetch(`${API_BASE}/authority/release-links`);
    if (resp.ok) {
      const data = await resp.json();
      state.releaseLinks = Array.isArray(data.items) ? data.items : [];
    }
  } catch { /* non-fatal */ }
}

async function loadRevenue() {
  try {
    const resp = await apiFetch(`${API_BASE}/revenue/authority/${encodeURIComponent(state.auth.authority_id)}`);
    if (resp.ok) state.revenue = await resp.json();
  } catch { /* non-fatal */ }
}

// ─── Auth Helper ───

/**
 * Make authenticated API request. Prefer session token (no Passkey); only use E2E when no session.
 */
async function apiFetch(url, options = {}) {
  const authHeaders = getAuthHeaders();
  if (authHeaders['X-Authority-Session']) {
    return fetch(url, { ...options, headers: { ...options.headers, ...authHeaders } });
  }
  if (_e2eReady && window.E2EClient?.isE2EEnabled?.()) {
    return window.E2EClient.e2eFetch(url, options);
  }
  return fetch(url, { ...options, headers: { ...options.headers, ...authHeaders } });
}

/**
 * Get auth headers: use session token if we have one (no extra passkey).
 */
function getAuthHeaders() {
  if (authoritySessionToken) {
    return { 'X-Authority-Session': authoritySessionToken };
  }
  return {};
}

/**
 * Get challenge-response auth headers for endpoints that require dualAuth (e.g. release-factors).
 */
async function getAuthHeadersAsync() {
  if (!wallet || !wallet.connected) return {};
  const challengeResp = await fetch(`${API_BASE}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: wallet.pubkey, wallet_type: wallet.walletType }),
  });
  if (!challengeResp.ok) throw new Error('Failed to get auth challenge');
  const { challenge_id, challenge } = await challengeResp.json();
  const signature = await wallet.signMessage(challenge);
  return { 'Authorization': 'EVM ' + challenge_id + ':' + signature };
}

// ─── Actions ───

async function checkAttestationGate(walletId, recipientIndex) {
  const url = `${API_BASE}/trigger/attestation-check?wallet_id=${encodeURIComponent(walletId)}&recipient_index=${encodeURIComponent(recipientIndex)}`;
  const resp = await apiFetch(url, { method: 'GET' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || data.detail || 'Attestation pre-check failed');
  }
  return data;
}

async function submitDecision(trigger, decision, evidenceHash, reason) {
  try {
    if (!trigger || !trigger.trigger_id) throw new Error('Missing trigger context');

    if (decision === 'release' && trigger.trigger_type === 'oracle') {
      const gate = await checkAttestationGate(trigger.wallet_id, trigger.recipient_index);
      if (!gate.valid) {
        const reasonText = gate.code ? `${gate.code}: ${gate.detail || ''}` : (gate.detail || 'attestation invalid');
        throw new Error(`Release blocked by attestation policy (${reasonText})`);
      }
    }

    let signatureHex = '';
    if (wallet && wallet.connected && evidenceHash) {
      try {
        signatureHex = await wallet.signMessage(evidenceHash);
      } catch { /* signing optional for hold/reject */ }
    }

    const resp = await fetch(`${API_BASE}/trigger/${encodeURIComponent(trigger.trigger_id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeadersAsync()) },
      body: JSON.stringify({
        decision,
        evidence_hash: evidenceHash,
        signature: signatureHex,
        reason,
      }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(result.error || result.detail || 'Decision submission failed');
    }
    if (decision === 'release' && (result.status === 'cooldown' || result.cooldown_remaining_ms != null)) {
      showToast('Release decision recorded. A cooldown period applies; the recipient will be able to claim after it ends.', 'success');
    } else {
      showToast(`Decision "${decision}" recorded`, 'success');
    }
    await loadTriggers();
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function submitTriggerInitiation(walletId, recipientIndex, reasonCode, matterId, evidenceHash, notes) {
  try {
    let signatureHex;
    if (!wallet || !wallet.connected) {
      showToast('Session expired. Please sign in again.', 'error');
      state.page = 'login';
      render();
      return;
    }
    try {
      signatureHex = await wallet.signMessage(evidenceHash);
    } catch (signErr) {
      showToast('Failed to sign evidence: ' + signErr.message, 'error');
      return;
    }

    const authHeaders = getAuthHeaders();

    const resp = await fetch(`${API_BASE}/trigger/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        wallet_id: walletId,
        recipient_index: recipientIndex,
        reason_code: reasonCode,
        matter_id: matterId || undefined,
        evidence_hash: evidenceHash,
        signature: signatureHex,
        notes: notes || undefined,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || 'Trigger initiation failed');
    }
    const result = await resp.json();
    showToast(`Trigger initiated (ID: ${result.trigger_id || 'OK'})`, 'success');
    await loadTriggers();
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Renderers ───

function renderLogin() {
  return `
    <div style="margin-top:60px;">
      <h1 style="text-align:center;margin-bottom:4px;">Yault Authority Dashboard</h1>
      <p style="text-align:center;color:var(--text-muted);margin-bottom:32px;font-size:14px;">
        Manage asset releases for your clients
      </p>
      ${wallet.renderLoginUI({
        title: 'Connect Wallet',
        subtitle: 'Sign in with your wallet to access the dashboard.',
        showManual: true,
      })}
    </div>
  `;
}

function renderNav() {
  var items = PAGES.map(function (p) {
    var label = T(p);
    if (label === p) label = p.charAt(0).toUpperCase() + p.slice(1);
    const pendingBadge = p === 'triggers' && state.triggers.length > 0
      ? ` <span class="badge badge-pending">${state.triggers.length}</span>`
      : '';
    return '<div class="nav-item ' + (state.page === p ? 'active' : '') + '" data-page="' + p + '">' + label + (pendingBadge || '') + '</div>';
  }).join('');
  return `<div class="nav">${items}</div>`;
}

function renderOverview() {
  const activeBindings = state.bindings.filter((b) => b.status === 'active');
  const pendingTriggers = state.triggers.filter((t) => t.status === 'pending');

  const bindingRows = activeBindings.length > 0
    ? activeBindings.map((b) => `
        <tr>
          <td>${esc(b.wallet_id?.substring(0, 12))}...</td>
          <td>${(b.recipient_indices || []).join(', ')}</td>
          <td>${b.shamir_config ? `${b.shamir_config.threshold}-of-${b.shamir_config.total_shares}` : '--'}</td>
          <td><span class="badge badge-active">${esc(b.status)}</span></td>
          <td>${new Date(b.created_at).toLocaleDateString()}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="5" class="empty-state">No active bindings</td></tr>';

  return `
    <h2>Dashboard</h2>
    ${wallet.renderConnectedStatus()}
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-value">${activeBindings.length}</div>
        <div class="stat-label">Active Clients</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--warning)">${pendingTriggers.length}</div>
        <div class="stat-label">Pending Triggers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--success)">$${state.revenue.pending || 0}</div>
        <div class="stat-label">Pending Revenue</div>
      </div>
    </div>
    <h3>Client Bindings</h3>
    <div class="card" style="overflow-x:auto;">
      <table class="table">
        <thead>
          <tr>
            <th>Wallet ID</th>
            <th>Paths</th>
            <th>Shamir</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>${bindingRows}</tbody>
      </table>
    </div>
    ${state.releaseLinks.length > 0 ? `
    <h3>Admin Factor Linking</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">After a client creates an Asset Plan, they will send a recipient_id. Please enter the AdminFactor while logged in and submit (it will not be transmitted via URL).</p>
    <div class="card">
      <ul style="list-style:none;padding:0;margin:0;">
        ${state.releaseLinks.map((item) => `
          <li style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-muted);">recipient_id: ${esc((item.recipient_id || '').substring(0, 16))}...</span>
            ${item.evm_address ? `<span style="font-size:12px;">EVM: ${esc((item.evm_address || '').substring(0, 14))}...</span>` : ''}
            <input class="form-input" type="text" id="release-link-factor-${esc(item.id)}" placeholder="AdminFactor 64 hex" maxlength="64" style="min-width:280px;" />
            <button class="btn btn-primary btn-sm" data-action="link-admin-factor" data-link-id="${esc(item.id)}" data-recipient-id="${esc(item.recipient_id || '')}">Submit Link</button>
          </li>
        `).join('')}
      </ul>
    </div>
    ` : ''}
  `;
}

function renderTriggers() {
  const pending = state.triggers.filter((t) => t.status === 'pending');
  const cooldown = state.triggers.filter((t) => t.status === 'cooldown');
  const released = state.triggers.filter((t) => t.status === 'released');
  const blocked = state.triggers.filter((t) => t.status === 'attestation_blocked');
  const aborted = state.triggers.filter((t) => t.status === 'aborted');

  const pendingCards = pending.length === 0 ? `
    <div class="card empty-state">
      <p>No pending trigger events.</p>
      <p style="font-size:13px;color:var(--text-muted);">Triggers appear when an asset release process is initiated.</p>
    </div>
  ` : pending.map((t, i) => {
    const idx = state.triggers.indexOf(t);
    return `
    <div class="card">
      <div class="card-header">
        <div>
          <strong>Wallet:</strong> ${esc(t.wallet_id?.substring(0, 16))}...
          <span class="badge badge-pending">pending</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">Path #${t.recipient_index}</div>
      </div>
      <div style="margin-top:12px;">
        <div class="form-group">
          <label class="form-label">Evidence Hash (SHA-256)</label>
          <input class="form-input" type="text" id="evidence-${idx}" placeholder="Hash of verified evidence..." />
        </div>
        <div class="form-group">
          <label class="form-label">Reason (optional)</label>
          <input class="form-input" type="text" id="reason-${idx}" placeholder="Verified documentation, court order, etc." />
        </div>
        <div class="actions">
          <button class="btn btn-success" data-action="decide" data-trigger-index="${idx}" data-decision="release">Release</button>
          <button class="btn btn-secondary" data-action="decide" data-trigger-index="${idx}" data-decision="hold">Hold</button>
          <button class="btn btn-danger" data-action="decide" data-trigger-index="${idx}" data-decision="reject">Reject</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  const cooldownCards = cooldown.length === 0 ? '' : cooldown.map((t) => {
    const remaining = t.cooldown_remaining_ms != null ? Math.max(0, t.cooldown_remaining_ms) : 0;
    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const remainingText = days > 0 ? days + ' day(s)' : hours + ' hour(s)';
    return `
    <div class="card">
      <div class="card-header">
        <div>
          <strong>Wallet:</strong> ${esc(t.wallet_id?.substring(0, 16))}...
          <span class="badge badge-info">cooldown</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">Path #${t.recipient_index} &bull; ${remainingText} remaining</div>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);margin-top:8px;">Release will take effect after the cooldown period. You may submit an additional legal confirmation if required for this case.</p>
      <button class="btn btn-secondary btn-sm" style="margin-top:10px;" data-action="legal-confirm" data-trigger-id="${esc(t.trigger_id)}">Submit legal confirmation</button>
    </div>
  `;
  }).join('');

  const abortedCards = aborted.length === 0 ? '' : aborted.map((t) => `
    <div class="card">
      <div class="card-header">
        <div>
          <strong>Wallet:</strong> ${esc(t.wallet_id?.substring(0, 16))}...
          <span class="badge badge-muted">aborted</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">Path #${t.recipient_index}</div>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);margin-top:8px;">This release was paused by operations. ${t.aborted_reason ? 'Reason: ' + esc(t.aborted_reason) : ''}</p>
      ${t.remaining_cooldown_ms != null ? `<p style="font-size:12px;color:var(--text-muted);margin-top:4px;">If resumed, ${Math.floor(t.remaining_cooldown_ms / (24 * 60 * 60 * 1000))} day(s) would apply.</p>` : ''}
    </div>
  `).join('');

  const releasedCards = released.map((t, i) => {
    const idx = state.triggers.indexOf(t);
    return `
    <div class="card">
      <div class="card-header">
        <div>
          <strong>Wallet:</strong> ${esc(t.wallet_id?.substring(0, 16))}...
          <span class="badge badge-released">released</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">Path #${t.recipient_index} &bull; Trigger ${esc(t.trigger_id?.substring(0, 8) || '')}...</div>
      </div>
      <div style="margin-top:12px;">
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">
          Submit the admin factor so the recipient can claim. Combine your share(s) for this path to obtain the 64-char hex.
        </p>
        <div class="form-group">
          <label class="form-label">Admin factor (64 hex chars) for path #${t.recipient_index}</label>
          <input class="form-input" type="text" id="release-factor-${idx}" placeholder="64-character hex..." maxlength="64" />
        </div>
        <button class="btn btn-primary" data-action="submit-release-factors" data-trigger-index="${idx}">Submit release factors</button>
      </div>
    </div>
  `;
  }).join('');

  const blockedCards = blocked.length === 0 ? '' : blocked.map((t) => `
    <div class="card">
      <div class="card-header">
        <div>
          <strong>Wallet:</strong> ${esc(t.wallet_id?.substring(0, 16))}...
          <span class="badge badge-danger">attestation_blocked</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">Path #${t.recipient_index}</div>
      </div>
      <div style="margin-top:10px;font-size:13px;color:var(--text-secondary);">
        <div><strong>Reason:</strong> ${esc(t.blocked_reason_code || 'unknown')}</div>
        <div>${esc(t.blocked_reason_detail || 'Attestation policy check failed at cooldown finalization.')}</div>
      </div>
    </div>
  `).join('');

  return `
    <h2>Triggers</h2>
    <h3 style="margin-top:16px;font-size:14px;color:var(--text-muted);">Pending</h3>
    ${pendingCards}
    ${cooldown.length > 0 ? `
    <h3 style="margin-top:24px;font-size:14px;color:var(--text-muted);">Cooldown — release will take effect after the waiting period</h3>
    ${cooldownCards}
    ` : ''}
    ${released.length > 0 ? `
    <h3 style="margin-top:24px;font-size:14px;color:var(--text-muted);">Released — submit factors for recipient claim</h3>
    ${releasedCards}
    ` : ''}
    ${aborted.length > 0 ? `
    <h3 style="margin-top:24px;font-size:14px;color:var(--text-muted);">Paused</h3>
    ${abortedCards}
    ` : ''}
    ${blocked.length > 0 ? `
    <h3 style="margin-top:24px;font-size:14px;color:var(--text-muted);">Blocked</h3>
    ${blockedCards}
    ` : ''}
  `;
}

function renderInitiate() {
  return `
    <h2>Initiate Asset Release</h2>
    <div class="card">
      <p style="color:var(--text-secondary);margin-bottom:16px;font-size:14px;">
        Use this form to initiate an asset release when a qualifying event occurs
        (legal order, verified documentation, authorized request, etc.).
      </p>
      <div class="form-group">
        <label class="form-label">Wallet ID *</label>
        <input class="form-input" type="text" id="initiateWalletId" placeholder="Client wallet ID" required />
      </div>
      <div class="form-group">
        <label class="form-label">Path Index *</label>
        <input class="form-input" type="number" id="initiateRecipientIndex" min="0" placeholder="0" required />
      </div>
      <div class="form-group">
        <label class="form-label">Reason Code *</label>
        <select class="form-input" id="initiateReasonCode" required>
          <option value="">— Select reason —</option>
          <option value="verified_event">Verified Event</option>
          <option value="incapacity_certification">Incapacity Certification</option>
          <option value="legal_order">Legal Order</option>
          <option value="authorized_request">Authorized Request</option>
          <option value="court_order">Court Order</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Matter ID <span style="font-size:11px;color:var(--text-muted);">(optional)</span></label>
        <input class="form-input" type="text" id="initiateMatterId" placeholder="e.g. CASE-2026-0042" />
      </div>
      <div class="form-group">
        <label class="form-label">Evidence Hash (SHA-256) *</label>
        <input class="form-input" type="text" id="initiateEvidenceHash" placeholder="64-character hex hash..." maxlength="64" required />
      </div>
      <div class="form-group">
        <label class="form-label">Notes <span style="font-size:11px;color:var(--text-muted);">(optional)</span></label>
        <textarea class="form-input" id="initiateNotes" rows="3" placeholder="Additional context..."></textarea>
      </div>
      <button class="btn btn-primary" style="width:100%;" data-action="initiate-trigger">Submit</button>
    </div>
  `;
}

function renderRevenue() {
  return `
    <h2>Revenue</h2>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-value" style="color:var(--success);">$${state.revenue.total || 0}</div>
        <div class="stat-label">Total Earned</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${state.revenue.withdrawn || 0}</div>
        <div class="stat-label">Withdrawn</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--primary);">$${state.revenue.pending || 0}</div>
        <div class="stat-label">Available</div>
      </div>
    </div>
    <div class="card">
      <p style="color:var(--text-secondary);font-size:14px;">
        Revenue is generated from ERC-4626 vault yield from bound clients.
        Revenue is distributed on-chain and can be withdrawn at any time.
      </p>
      <button class="btn btn-primary" style="margin-top:12px;" data-action="withdraw">Withdraw Available</button>
    </div>
  `;
}

function renderProfile() {
  const p = state.profile || {};
  const editMode = state.profileEditMode === true;

  const cardContent = editMode
    ? `
    <div class="card">
      <h3>Profile</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Update your authority profile. Name, jurisdiction, address and contact are shown to clients.</p>
      <div class="form-group">
        <label class="form-label">Name / Firm Name</label>
        <input class="form-input" type="text" value="${esc(p.name || '')}" id="profileName" placeholder="Authority or firm name" />
      </div>
      <div class="form-group">
        <label class="form-label">Jurisdiction</label>
        <select class="form-input" id="profileJurisdiction">
          ${JURISDICTION_OPTIONS.map((o) => `
            <option value="${esc(o.value)}" ${(p.jurisdiction || p.region || '') === o.value ? 'selected' : ''}>${esc(o.label)}</option>
          `).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <input class="form-input" type="text" value="${esc(p.address || '')}" id="profileAddress" placeholder="Physical or business address" />
      </div>
      <div class="form-group">
        <label class="form-label">Contact</label>
        <input class="form-input" type="text" value="${esc(p.contact || '')}" id="profileContact" placeholder="Phone, Telegram, etc." />
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" type="email" value="${esc(p.email || '')}" id="profileEmail" placeholder="contact@example.com" />
      </div>
      <div class="form-group">
        <label class="form-label">Website</label>
        <input class="form-input" type="url" value="${esc(p.website || '')}" id="profileWebsite" placeholder="https://..." />
      </div>
      <div class="form-group">
        <label class="form-label">Bar Number (optional)</label>
        <input class="form-input" type="text" value="${esc(p.bar_number || '')}" id="profileBarNumber" />
      </div>
      <div style="display:flex;gap:12px;margin-top:16px;">
        <button type="button" class="btn btn-primary" data-action="profile-save">Save</button>
        <button type="button" class="btn btn-secondary" data-action="profile-cancel">Cancel</button>
      </div>
    </div>
  `
    : `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">Profile</h3>
        <button type="button" class="btn btn-secondary" data-action="profile-edit">Edit</button>
      </div>
      <dl style="display:grid;grid-template-columns:140px 1fr;gap:8px 16px;font-size:14px;">
        <dt style="color:var(--text-muted);margin:0;">Name</dt>
        <dd style="margin:0;">${esc(p.name || '—')}</dd>
        <dt style="color:var(--text-muted);margin:0;">Jurisdiction</dt>
        <dd style="margin:0;">${esc(jurisdictionLabel(p.jurisdiction || p.region))}</dd>
        <dt style="color:var(--text-muted);margin:0;">Address</dt>
        <dd style="margin:0;">${esc(p.address || '—')}</dd>
        <dt style="color:var(--text-muted);margin:0;">Contact</dt>
        <dd style="margin:0;">${esc(p.contact || '—')}</dd>
        <dt style="color:var(--text-muted);margin:0;">Email</dt>
        <dd style="margin:0;">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}</dd>
        <dt style="color:var(--text-muted);margin:0;">Website</dt>
        <dd style="margin:0;">${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a>` : '—'}</dd>
        <dt style="color:var(--text-muted);margin:0;">Bar Number</dt>
        <dd style="margin:0;">${esc(p.bar_number || '—')}</dd>
        <dt style="color:var(--text-muted);margin:0;">Solana (receive NFT)</dt>
        <dd style="margin:0;">${p.solana_address ? `<span class="mono" style="font-size:12px;">${esc(p.solana_address.substring(0, 8))}...${esc(p.solana_address.slice(-6))}</span>` : '—'}</dd>
        <dt style="color:var(--text-muted);margin:0;">Wallet</dt>
        <dd style="margin:0;"><span class="mono" style="font-size:12px;opacity:0.8;">${esc((p.pubkey || state.auth?.pubkey || '').substring(0, 10))}...</span></dd>
      </dl>
    </div>
  `;

  return `
    <h2>Profile</h2>
    <div class="card" style="margin-bottom:16px;">
      <h3>Connected Wallet</h3>
      ${wallet && wallet.connected ? wallet.renderConnectedStatus() : '<p style="color:var(--text-muted);">Not connected</p>'}
    </div>
    ${cardContent}
  `;
}

// ─── Main Render ───

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (state.page === 'login') {
    app.innerHTML = renderLogin();
    if (wallet) wallet.attachEvents(app);
    return;
  }

  let content = '';
  switch (state.page) {
    case 'overview': content = renderOverview(); break;
    case 'triggers': content = renderTriggers(); break;
    case 'initiate': content = renderInitiate(); break;
    case 'revenue': content = renderRevenue(); break;
    case 'profile': content = renderProfile(); break;
    default: content = renderOverview();
  }

  const shortAddr = state.auth?.address
    ? (state.auth.address.length > 16
      ? state.auth.address.substring(0, 8) + '...' + state.auth.address.substring(state.auth.address.length - 6)
      : state.auth.address)
    : '';

  app.innerHTML = `
    <h1>Yault Authority Dashboard</h1>
    <p style="color:var(--text-muted);margin-bottom:16px;font-size:13px;">
      ${esc(state.profile?.name || '')}${state.profile?.name ? ' &bull; ' : ''}${esc(shortAddr)}
    </p>
    ${renderNav()}
    ${content}
  `;

  attachAppEvents();
}

// ─── Event Handlers ───

function attachAppEvents() {
  const app = document.getElementById('app');
  if (!app) return;

  // Navigation
  app.querySelectorAll('.nav-item[data-page]').forEach((el) => {
    el.addEventListener('click', async () => {
      const page = el.dataset.page;
      if (page === 'profile') await loadProfile();
      if (page === 'revenue') await loadRevenue();
      navigate(page);
    });
  });

  // Wallet disconnect (in status bars and settings)
  app.querySelectorAll('[data-action="wallet-disconnect"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (wallet) wallet.disconnect();
    });
  });

  // Decision buttons
  app.querySelectorAll('[data-action="decide"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.triggerIndex, 10);
      const decision = btn.dataset.decision;
      const trigger = state.triggers[idx];
      if (!trigger) return;

      const evidence = document.getElementById(`evidence-${idx}`)?.value || '';
      const reason = document.getElementById(`reason-${idx}`)?.value || '';

      if (decision === 'release' && !evidence) {
        showToast('Evidence hash is required for release decisions', 'error');
        return;
      }

      await submitDecision(trigger, decision, evidence, reason);
    });
  });

  // Legal confirmation (for triggers in cooldown — dual attestation)
  app.querySelectorAll('[data-action="legal-confirm"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const triggerId = btn.dataset.triggerId;
      if (!triggerId) return;
      try {
        const authHeaders = await getAuthHeadersAsync();
        const resp = await fetch(`${API_BASE}/trigger/${encodeURIComponent(triggerId)}/legal-confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({}),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || data.detail || 'Request failed');
        showToast('Legal confirmation recorded.', 'success');
        await loadTriggers();
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Submit release factors (for released triggers — closes the claim loop)
  app.querySelectorAll('[data-action="submit-release-factors"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.triggerIndex, 10);
      const trigger = state.triggers[idx];
      if (!trigger || trigger.status !== 'released') return;

      const hexInput = document.getElementById(`release-factor-${idx}`)?.value?.trim() || '';
      if (!/^[0-9a-fA-F]{64}$/.test(hexInput)) {
        showToast('Admin factor must be a 64-character hex string', 'error');
        return;
      }

      try {
        const authHeaders = await getAuthHeadersAsync();
        const resp = await fetch(`${API_BASE}/release/release-factors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            wallet_id: trigger.wallet_id,
            trigger_id: trigger.trigger_id,
            admin_factors: [{ index: trigger.recipient_index, admin_factor_hex: hexInput }],
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'Submit failed');
        showToast('Release factors submitted. Recipient can now claim.', 'success');
        document.getElementById(`release-factor-${idx}`).value = '';
        await loadTriggers();
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Link AdminFactor from release-link queue (authenticated, POST body only)
  app.querySelectorAll('[data-action="link-admin-factor"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const linkId = btn.dataset.linkId || '';
      const recipientId = btn.dataset.recipientId || '';
      const input = document.getElementById(`release-link-factor-${linkId}`);
      const adminFactor = (input && input.value ? input.value.trim() : '');

      if (!/^[0-9a-fA-F]{64}$/.test(recipientId)) {
        showToast('Invalid recipient_id', 'error');
        return;
      }
      if (!/^[0-9a-fA-F]{64}$/.test(adminFactor)) {
        showToast('AdminFactor must be a 64-character hex string', 'error');
        return;
      }

      try {
        const resp = await apiFetch(`${API_BASE}/authority/AdminFactor/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient_id: recipientId,
            admin_factor: adminFactor,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || data.detail || 'Link failed');
        showToast('AdminFactor linked', 'success');
        if (input) input.value = '';
        const processedIds = Array.isArray(data.processed_link_ids) ? data.processed_link_ids : [linkId];
        const idsSet = new Set(processedIds.map((id) => String(id)));
        state.releaseLinks = state.releaseLinks.filter((item) => !idsSet.has(String(item.id)));
        render();
      } catch (err) {
        showToast(err.message || 'Link failed', 'error');
      }
    });
  });

  // Initiate trigger
  const initiateBtn = app.querySelector('[data-action="initiate-trigger"]');
  if (initiateBtn) {
    initiateBtn.addEventListener('click', async () => {
      const walletId = document.getElementById('initiateWalletId')?.value?.trim();
      const recipientIndex = parseInt(document.getElementById('initiateRecipientIndex')?.value, 10);
      const reasonCode = document.getElementById('initiateReasonCode')?.value;
      const matterId = document.getElementById('initiateMatterId')?.value?.trim();
      const evidenceHash = document.getElementById('initiateEvidenceHash')?.value?.trim();
      const notes = document.getElementById('initiateNotes')?.value?.trim();

      if (!walletId) { showToast('Wallet ID is required', 'error'); return; }
      if (isNaN(recipientIndex) || recipientIndex < 0) { showToast('A valid path index is required', 'error'); return; }
      if (!reasonCode) { showToast('Please select a reason code', 'error'); return; }
      if (!evidenceHash || evidenceHash.length !== 64) { showToast('Evidence hash must be a 64-character SHA-256 hex string', 'error'); return; }

      await submitTriggerInitiation(walletId, recipientIndex, reasonCode, matterId, evidenceHash, notes);
    });
  }

  // Withdraw (claim authority revenue on-chain)
  const withdrawBtn = app.querySelector('[data-action="withdraw"]');
  if (withdrawBtn) {
    withdrawBtn.addEventListener('click', async () => {
      try {
        const authHeaders = await getAuthHeadersAsync();
        const resp = await fetch(`${API_BASE}/revenue/withdraw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({}),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || data.detail || 'Withdraw failed');
        if (data.status === 'nothing_to_claim') {
          showToast(data.message || 'No pending revenue to claim.', 'error');
          return;
        }
        if (data.status === 'pending_signature' && data.transaction) {
          await sendTransactionInWallet(data.transaction, state.auth?.address);
          showToast('Claim transaction submitted. Confirm in your wallet.', 'success');
          await loadRevenue();
          render();
        } else {
          showToast(data.message || 'Done', 'success');
        }
      } catch (err) {
        showToast(err.message || 'Withdraw failed', 'error');
      }
    });
  }

  // Profile: View / Edit mode
  app.querySelectorAll('[data-action="profile-edit"]').forEach((el) => {
    el.addEventListener('click', () => {
      state.profileEditMode = true;
      render();
    });
  });
  app.querySelectorAll('[data-action="profile-cancel"]').forEach((el) => {
    el.addEventListener('click', () => {
      state.profileEditMode = false;
      render();
    });
  });
  app.querySelectorAll('[data-action="profile-save"]').forEach((el) => {
    el.addEventListener('click', async () => {
      const body = {
        name: document.getElementById('profileName')?.value?.trim() || '',
        jurisdiction: document.getElementById('profileJurisdiction')?.value || '',
        address: document.getElementById('profileAddress')?.value?.trim() || '',
        contact: document.getElementById('profileContact')?.value?.trim() || '',
        email: document.getElementById('profileEmail')?.value?.trim() || '',
        website: document.getElementById('profileWebsite')?.value?.trim() || '',
        bar_number: document.getElementById('profileBarNumber')?.value?.trim() || '',
      };
      try {
        const resp = await apiFetch(`${API_BASE}/authority/${encodeURIComponent(state.auth.authority_id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Save failed');
        }
        await loadProfile();
        state.profileEditMode = false;
        showToast('Profile saved', 'success');
        render();
      } catch (err) {
        showToast(err.message || 'Save failed', 'error');
      }
    });
  });
}

// ─── Utilities ───

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(message, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type || 'success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function toEvenHex(hexOrNum) {
  const hex = typeof hexOrNum === 'string' && hexOrNum.startsWith('0x')
    ? hexOrNum.slice(2)
    : BigInt(hexOrNum).toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  return '0x' + padded;
}
function normalizeHex(s) {
  if (s == null || s === '') return s;
  const h = String(s).startsWith('0x') ? String(s).slice(2) : String(s);
  return '0x' + (h.length % 2 === 0 ? h : '0' + h);
}

/** Send a transaction payload (from API) via the user's wallet. */
async function sendTransactionInWallet(transaction, fromAddress) {
  const provider = window.yallet;
  if (!provider) throw new Error('Wallet not detected.');
  const from = fromAddress && !fromAddress.startsWith('0x') ? '0x' + fromAddress : fromAddress;
  const value = toEvenHex(transaction.value ?? 0);
  const chainIdHex = transaction.chainId ? toEvenHex(Number(transaction.chainId)) : undefined;
  if (chainIdHex) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
    }
  }
  return await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: from || undefined,
      to: transaction.to ? normalizeHex(transaction.to) : undefined,
      data: transaction.data ? normalizeHex(transaction.data) : undefined,
      value: value,
    }],
  });
}

// ─── Init (unified app: register for main.js) ───
window.YaultPortals = window.YaultPortals || {};
window.YaultPortals.authority = {
  init: function () {
    initWallet();
    render();
    window.onYaultLocaleChange = function () { render(); };
  },
};
