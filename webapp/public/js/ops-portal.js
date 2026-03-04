/**
 * ops-portal.js — Yault Platform Operations Dashboard
 *
 * Admin-only dashboard for platform operators.
 * Auth: Yallet wallet login with server-side ADMIN_WALLETS allowlist.
 * Pages: Login, Dashboard, Users, Authorities, Triggers, KYC, Revenue, Vault
 */

'use strict';

function T(key) { return (typeof window.t === 'function' ? window.t(key) : key); }

const API_BASE = (typeof YAULT_ENV !== 'undefined' && YAULT_ENV?.api?.baseUrl)
  ? YAULT_ENV.api.baseUrl
  : (window.location.port === '3001' ? '/api' : (window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : 'https://api.yault.xyz/api'));

const state = {
  page: 'login',   // login | dashboard | users | authorities | triggers | kyc | revenue | vault
  authenticated: false,
  auth: null,       // { pubkey, address, walletType }
  stats: null,
  users: [],
  usersTotal: 0,
  usersPage: 1,
  usersLimit: 20,
  usersSearch: '',
  authorities: [],
  triggers: [],
  triggerPolicy: null,  // { releasePaused, highValueWalletIds } from GET /admin/trigger/policy
  kycList: [],
  revenue: null,
  vaultConfig: null,      // { vaultAddress, chainId, rpcUrl } for Vault tab
  vaultUsersWithYield: [], // { address, yield, yieldFormatted }[] for monthly harvest-for-all
  campaigns: [],
  campaignDetail: null,    // campaign object being edited
  loading: false,
  error: null,
  userDetail: null,       // { address, kyc, bindings, triggers } when viewing a user
  selectedAuthority: null, // full authority object when viewing an authority
  redeliverCandidates: [], // flat list for Redeliver button index
  redeliverPlans: [],      // [{ wallet_id, authority_id, trigger_id, recipients: [{ recipient_index, delivery_status, name }] }]
};

let wallet = null; // WalletConnector instance

const PAGES = ['dashboard', 'users', 'authorities', 'triggers', 'redeliver', 'kyc', 'revenue', 'vault', 'campaigns'];

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '';
  return addr.substring(0, 8) + '...' + addr.substring(addr.length - 4);
}

function normalizeHexAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^0x/i, '').toLowerCase();
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function redeliverCandidateKey(walletId, authorityId, recipientIndex) {
  return `${normalizeHexAddress(walletId)}|${normalizeText(authorityId)}|${Number(recipientIndex)}`;
}

function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type || 'success'}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Session-based API helpers ───

let sessionToken = null; // obtained after wallet auth via POST /admin/session

async function api(path) {
  if (!sessionToken) throw new Error('Not authenticated');
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Admin-Session': sessionToken },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `API ${resp.status}`);
  }
  return resp.json();
}

async function apiPost(path, body) {
  if (!sessionToken) throw new Error('Not authenticated');
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Session': sessionToken },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.json().catch(() => ({}));
    throw new Error(respBody.error || `API ${resp.status}`);
  }
  return resp.json();
}

async function apiPatch(path, body) {
  if (!sessionToken) throw new Error('Not authenticated');
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Session': sessionToken },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.json().catch(() => ({}));
    throw new Error(respBody.error || `API ${resp.status}`);
  }
  return resp.json();
}

// ─── Login ───

function renderLogin() {
  var walletUI = wallet ? wallet.renderLoginUI({
    title: T('connectWallet'),
    subtitle: T('signInWithYallet'),
  }) : '<p style="color:var(--text-muted);text-align:center;">' + T('loadingWallet') + '</p>';

  return `
    <div class="login-box">
      <h1>Yault Ops</h1>
      <h2>` + T('platformOps') + `</h2>
      ${state.error ? `<div class="alert alert-danger">${esc(state.error)}</div>` : ''}
      ${walletUI}
    </div>
  `;
}

// ─── Nav ───

function renderNav() {
  var labels = { dashboard: T('dashboard'), users: T('users'), authorities: T('authorities'), triggers: T('triggers'), redeliver: 'Redeliver NFT', kyc: T('kyc'), revenue: T('revenue'), vault: 'Vault', campaigns: 'Campaigns' };
  return `<div class="nav">${PAGES.map(p =>
    `<div class="nav-item ${state.page === p ? 'active' : ''}" data-page="${p}">${labels[p]}</div>`
  ).join('')}</div>`;
}

// ─── Dashboard ───

function renderDashboard() {
  const s = state.stats?.platform || {};
  const k = state.stats?.kyc || {};
  return `
    <h2>Platform Overview</h2>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${s.total_users || 0}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-value">${s.total_authorities || 0}</div><div class="stat-label">Authorities</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--success);">${s.verified_authorities || 0}</div><div class="stat-label">Verified</div></div>
      <div class="stat-card"><div class="stat-value">${s.active_bindings || 0}</div><div class="stat-label">Bindings</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--warning);">${s.pending_triggers || 0}</div><div class="stat-label">Pending Triggers</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--primary);">${s.released_triggers || 0}</div><div class="stat-label">Released</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--text-muted);">${s.aborted_triggers || 0}</div><div class="stat-label">Paused</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value" style="color:var(--warning);">${k.pending || 0}</div><div class="stat-label">KYC Pending</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--success);">${k.approved || 0}</div><div class="stat-label">KYC Approved</div></div>
      <div class="stat-card"><div class="stat-value">${k.total || 0}</div><div class="stat-label">KYC Total</div></div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:var(--text-muted);">
        Uptime: ${state.stats?.uptime ? Math.floor(state.stats.uptime / 60) + 'm' : '--'}
        &bull; ${state.stats?.timestamp || ''}
      </div>
    </div>
  `;
}

// ─── Users ───

function kycStatusLabel(kyc) {
  if (kyc === 'approved') return 'KYC Passed';
  if (kyc === 'pending') return 'KYC Pending';
  if (kyc === 'rejected') return 'KYC Rejected';
  return 'KYC None';
}

function renderUsers() {
  const total = state.usersTotal || 0;
  const page = state.usersPage || 1;
  const limit = state.usersLimit || 20;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const search = (state.usersSearch || '').trim();

  return `
    <h2>Users</h2>
    <div class="card" style="margin-bottom:16px;width:100%;max-width:100%;box-sizing:border-box;">
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px;">
        <input type="text" class="form-input" id="usersSearchInput" placeholder="Search by name or EVM address..." value="${esc(search)}" style="max-width:280px;" />
        <button type="button" class="btn btn-primary" id="usersSearchBtn">Search</button>
      </div>
      <div style="width:100%;overflow-x:auto;">
        <table style="width:100%;min-width:100%;table-layout:fixed;">
          <colgroup>
            <col style="width:18%" /><col style="width:12%" /><col style="width:12%" /><col style="width:14%" /><col style="width:8%" /><col style="width:8%" /><col style="width:10%" />
          </colgroup>
        <thead><tr><th style="text-align:left;padding:10px 12px;">Address</th><th style="text-align:left;padding:10px 12px;">Name</th><th style="text-align:left;padding:10px 12px;">Role</th><th style="text-align:left;padding:10px 12px;">Status</th><th style="text-align:left;padding:10px 12px;">Bindings</th><th style="text-align:left;padding:10px 12px;">Triggers</th><th style="text-align:left;padding:10px 12px;">Action</th></tr></thead>
        <tbody>
          ${state.users.length === 0 ? '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;">No users</td></tr>' : ''}
          ${state.users.map(u => `
            <tr>
              <td class="mono" style="padding:10px 12px;">${esc(shortAddr(u.address))}</td>
              <td style="padding:10px 12px;">${esc(u.name || '—')}</td>
              <td style="padding:10px 12px;">
                <select class="form-input" style="width:100%;min-width:0;padding:6px 8px;box-sizing:border-box;" data-action="user-role-change" data-user-addr="${esc(u.address || '')}">
                  <option value="client" ${u.role === 'client' ? 'selected' : ''}>Client</option>
                  <option value="authority" ${u.role === 'authority' ? 'selected' : ''}>Authority</option>
                </select>
              </td>
              <td style="padding:10px 12px;"><span class="badge badge-${u.kyc === 'approved' ? 'success' : u.kyc === 'pending' ? 'warning' : u.kyc === 'rejected' ? 'danger' : 'muted'}">${esc(kycStatusLabel(u.kyc))}</span></td>
              <td style="padding:10px 12px;">${Number(u.bindings) || 0}</td>
              <td style="padding:10px 12px;">${Number(u.triggers) || 0}</td>
              <td style="padding:10px 12px;"><button class="btn btn-sm" data-action="view-user" data-user-addr="${esc(u.address || '')}">View</button></td>
            </tr>
          `).join('')}
        </tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px;color:var(--text-muted);">
        <span>Total: ${total} user(s)</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <button type="button" class="btn btn-sm" id="usersPagePrev" ${page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${page} of ${totalPages}</span>
          <button type="button" class="btn btn-sm" id="usersPageNext" ${page >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    </div>
    ${state.userDetail ? renderUserDetailModal() : ''}
  `;
}

function renderUserDetailModal() {
  const u = state.userDetail;
  if (!u) return '';
  const kyc = u.kyc || {};
  const bindings = Array.isArray(u.bindings) ? u.bindings : [];
  const triggers = Array.isArray(u.triggers) ? u.triggers : [];
  return `
    <div class="modal-overlay" data-action="close-detail-modal">
      <div class="modal" onclick="event.stopPropagation();">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3>User Detail</h3>
          <button class="btn btn-sm" data-action="close-detail-modal">Close</button>
        </div>
        <div style="font-size:13px;">
          <p><strong>Address:</strong> <span class="mono">${esc(u.address || '')}</span></p>
          <p><strong>KYC:</strong> <span class="badge badge-${kyc.status === 'approved' ? 'success' : kyc.status === 'pending' ? 'warning' : kyc.status === 'rejected' ? 'danger' : 'muted'}">${esc(kyc.status || 'none')}</span></p>
          <p><strong>Bindings:</strong> ${bindings.length}</p>
          ${bindings.length > 0 ? `<ul style="margin:4px 0;padding-left:20px;">${bindings.map(b => `<li>authority: ${esc(shortAddr(b.authority_id || b.authorityId || ''))}</li>`).join('')}</ul>` : ''}
          <p><strong>Triggers:</strong> ${triggers.length}</p>
          ${triggers.length > 0 ? `<ul style="margin:4px 0;padding-left:20px;">${triggers.slice(0, 10).map(t => `<li>${esc(t.status || '')} ${t.decision || ''} ${t.triggered_at ? new Date(t.triggered_at).toLocaleDateString() : ''}</li>`).join('')}${triggers.length > 10 ? '<li>...</li>' : ''}</ul>` : ''}
        </div>
      </div>
    </div>
  `;
}

// ─── Authorities ───

function renderAuthorities() {
  return `
    <h2>Authorities</h2>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Jurisdiction</th><th>Verified</th><th>Bindings</th><th>Action</th></tr></thead>
        <tbody>
          ${state.authorities.length === 0 ? '<tr><td colspan="5" style="color:var(--text-muted);text-align:center;">No authorities</td></tr>' : ''}
          ${state.authorities.map(f => `
            <tr>
              <td>${esc(f.name)}</td>
              <td>${esc(f.jurisdiction || f.region || '')}</td>
              <td><span class="badge badge-${f.verified ? 'success' : 'warning'}">${f.verified ? 'Verified' : 'Pending'}</span></td>
              <td>${f.active_bindings || 0} / ${f.max_capacity || 100}</td>
              <td>
                <button class="btn btn-sm" data-action="view-authority" data-firm-id="${esc(f.id || f.authority_id || '')}">View</button>
                ${!f.verified ? ` <button class="btn btn-sm btn-success" data-action="verify-firm" data-firm-id="${esc(f.id || f.authority_id || '')}">Verify</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${state.selectedAuthority ? renderAuthorityDetailModal() : ''}
  `;
}

function renderAuthorityDetailModal() {
  const f = state.selectedAuthority;
  if (!f) return '';
  const fee = f.fee_structure || {};
  const spec = Array.isArray(f.specialization) ? f.specialization : [];
  const lang = Array.isArray(f.languages) ? f.languages : [];
  return `
    <div class="modal-overlay" data-action="close-detail-modal">
      <div class="modal" onclick="event.stopPropagation();">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3>Authority Detail</h3>
          <button class="btn btn-sm" data-action="close-detail-modal">Close</button>
        </div>
        <div style="font-size:13px;">
          <p><strong>Name:</strong> ${esc(f.name || '')}</p>
          <p><strong>ID:</strong> <span class="mono" style="font-size:11px;">${esc((f.id || f.authority_id || '').substring(0, 24))}...</span></p>
          <p><strong>Bar Number:</strong> ${esc(f.bar_number || '—')}</p>
          <p><strong>Jurisdiction:</strong> ${esc(f.jurisdiction || f.region || '—')}</p>
          <p><strong>Specialization:</strong> ${spec.length ? spec.map(s => esc(s)).join(', ') : '—'}</p>
          <p><strong>Languages:</strong> ${lang.length ? lang.map(l => esc(l)).join(', ') : '—'}</p>
          <p><strong>Fee:</strong> ${fee.base_fee_bps != null ? (fee.base_fee_bps / 100) + '%' : '—'} ${fee.flat_fee_usd ? '+ ' + fee.flat_fee_usd + ' ' + (fee.currency || 'USD') : ''}</p>
          <p><strong>Capacity:</strong> ${f.active_bindings || 0} / ${f.max_capacity || 100}</p>
          <p><strong>Verified:</strong> <span class="badge badge-${f.verified ? 'success' : 'warning'}">${f.verified ? 'Yes' : 'No'}</span></p>
          <p><strong>Email:</strong> ${esc(f.email || '—')}</p>
          <p><strong>Website:</strong> ${f.website ? `<a href="${esc(f.website)}" target="_blank" rel="noopener">${esc(f.website)}</a>` : '—'}</p>
        </div>
      </div>
    </div>
  `;
}

// ─── Triggers ───

function renderTriggers() {
  const policy = state.triggerPolicy || {};
  const releasePaused = !!policy.releasePaused;
  const badge = (t) => {
    if (t.status === 'released') return 'success';
    if (t.status === 'pending') return 'warning';
    if (t.status === 'cooldown') return 'info';
    if (t.status === 'aborted') return 'muted';
    if (t.status === 'attestation_blocked') return 'danger';
    return 'muted';
  };
  const remainingText = (t) => {
    if (t.status === 'cooldown' && t.effective_at) {
      const ms = Math.max(0, (t.effective_at || 0) - Date.now());
      const d = Math.floor(ms / (24 * 60 * 60 * 1000));
      const h = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      return d > 0 ? d + 'd' : h + 'h';
    }
    if (t.status === 'aborted' && t.remaining_cooldown_ms != null) {
      const d = Math.floor(t.remaining_cooldown_ms / (24 * 60 * 60 * 1000));
      return 'Resume: ' + d + 'd left';
    }
    return '—';
  };
  const actions = (t) => {
    if (t.status === 'cooldown') {
      return `<button class="btn btn-sm btn-danger" data-action="trigger-abort" data-trigger-id="${esc(t.trigger_id)}" title="Pause release (remaining time is preserved)">Abort</button>
        <button class="btn btn-sm btn-secondary" data-action="trigger-legal-confirm" data-trigger-id="${esc(t.trigger_id)}">Legal confirm</button>`;
    }
    if (t.status === 'aborted') {
      return `<button class="btn btn-sm btn-success" data-action="trigger-resume" data-trigger-id="${esc(t.trigger_id)}">Resume</button>`;
    }
    return '—';
  };
  return `
    <h2>Triggers</h2>
    ${releasePaused ? `
    <div class="alert alert-warning" style="margin-bottom:16px;">
      <strong>Release paused.</strong> Cooldown expirations will not finalize releases until the pause is lifted (server configuration).
    </div>
    ` : ''}
    <div class="card">
      <table>
        <thead><tr><th>Wallet</th><th>Path</th><th>Authority</th><th>Status</th><th>Remaining</th><th>Decision</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody>
          ${state.triggers.length === 0 ? '<tr><td colspan="8" style="color:var(--text-muted);text-align:center;">No triggers</td></tr>' : ''}
          ${state.triggers.map(t => `
            <tr>
              <td class="mono">${esc(shortAddr(t.wallet_id))}</td>
              <td>#${t.recipient_index ?? '—'}</td>
              <td class="mono">${esc(shortAddr(t.authority_id))}</td>
              <td><span class="badge badge-${badge(t)}">${esc(t.status)}</span></td>
              <td style="font-size:12px;color:var(--text-muted);">${remainingText(t)}</td>
              <td>${esc(t.decision || '—')}</td>
              <td style="font-size:12px;color:var(--text-muted);">${t.triggered_at ? new Date(t.triggered_at).toLocaleDateString() : '—'}</td>
              <td style="white-space:nowrap;">${actions(t)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="card" style="margin-top:20px;">
      <h3>Emergency release</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Only for manual emergency recovery. Creates a release trigger with a cooldown period.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:12px;align-items:end;max-width:800px;">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Wallet ID</label>
          <input class="form-input" type="text" id="emergencyWalletId" placeholder="0x..." />
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Path index</label>
          <input class="form-input" type="number" id="emergencyRecipientIndex" min="0" placeholder="0" />
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Evidence hash (64 hex)</label>
          <input class="form-input" type="text" id="emergencyEvidenceHash" placeholder="SHA-256 hex..." maxlength="66" />
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" data-action="trigger-emergency-release">Submit emergency release</button>
    </div>
  `;
}

// ─── Redeliver NFT (admin: one card per plan) ───

function renderRedeliver() {
  const plans = state.redeliverPlans || [];
  let candidateIndex = 0;

  const cards = plans.map((plan) => {
    const walletShort = (plan.wallet_id || '').substring(0, 14) + (plan.wallet_id && plan.wallet_id.length > 14 ? '...' : '');
    const authorityDisplay = plan.authority_id != null && String(plan.authority_id).trim() !== ''
      ? (plan.authority_id.substring(0, 10) + (plan.authority_id.length > 10 ? '...' : ''))
      : '—';

    const rows = (plan.recipients || []).map((rec) => {
      const status = rec.delivery_status || '—';
      const statusClass = status === 'delivered' ? 'badge-active' : (status === 'failed' || status === 'pending' ? 'badge-pending' : 'badge-muted');
      const txShort = rec.delivery_tx_id ? (rec.delivery_tx_id.substring(0, 12) + (rec.delivery_tx_id.length > 12 ? '...' : '')) : '—';
      const idx = candidateIndex++;
      const candidate = state.redeliverCandidates[idx] || null;
      const pendingApprovalId = candidate?.pending_approval_id || null;
      const awaitingOtherSigner = !!(candidate?.pending_signed_by_current && pendingApprovalId);
      const actionLabel = awaitingOtherSigner
        ? 'Awaiting Other Signer'
        : (pendingApprovalId ? 'Approve Redeliver' : 'Redeliver');
      const disabledAttr = awaitingOtherSigner ? 'disabled' : '';
      const approvalHint = pendingApprovalId
        ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Approval: ${esc(pendingApprovalId.slice(0, 10))}... (${candidate?.pending_current || 1}/${candidate?.pending_required || 2})</div>`
        : '';
      return `
        <tr>
          <td>${esc(rec.name || 'Recipient ' + rec.recipient_index)}</td>
          <td><span class="badge ${statusClass}">${esc(status)}</span></td>
          <td style="font-size:11px;color:var(--text-muted);" class="mono" title="${esc(rec.delivery_tx_id || '')}">${esc(txShort)}</td>
          <td>
            <button class="btn btn-sm btn-primary" data-action="redeliver-one" data-candidate-index="${idx}" ${disabledAttr}>${actionLabel}</button>
            ${approvalHint}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header" style="border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:12px;">
          <div style="font-weight:600;">Wallet</div>
          <div class="mono" style="font-size:13px;color:var(--text-secondary);">${esc(walletShort)}</div>
          <div style="font-weight:600;margin-top:8px;">Authority</div>
          <div class="mono" style="font-size:13px;color:var(--text-secondary);">${esc(authorityDisplay)}</div>
        </div>
        <div style="overflow-x:auto;">
          <table class="table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Delivery status</th>
                <th>Last tx</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  return `
    <h2>Redeliver RWA NFT</h2>
    <p style="color:var(--text-secondary);margin-bottom:16px;font-size:14px;">
      One card per released plan. Use when a beneficiary did not receive the RWA credential (e.g. plan created without an authority). Click Redeliver to re-send the same payload; no plan regeneration or re-signing needed.
    </p>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">
      After each Redeliver, the result and tx are shown below. If only one recipient receives: verify the payload’s leafOwner matches that recipient’s wallet and check whether the RWA upload-and-mint API treats duplicate sends as no-op.
    </p>
    ${plans.length === 0
    ? '<div class="card"><p style="color:var(--text-muted);">No released plans with recipients. Release a trigger first; then they appear here.</p></div>'
    : cards}
    <p id="redeliverResult" style="margin-top:12px;font-size:13px;display:none;"></p>
  `;
}

// ─── KYC ───

function renderKYC() {
  return `
    <h2>KYC Management</h2>
    <div class="card">
      <table>
        <thead><tr><th>Address</th><th>Level</th><th>Provider</th><th>Status</th><th>Submitted</th><th>Action</th></tr></thead>
        <tbody>
          ${state.kycList.length === 0 ? '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;">No KYC submissions</td></tr>' : ''}
          ${state.kycList.map(k => `
            <tr>
              <td class="mono">${esc(shortAddr(k.address))}</td>
              <td>${esc(k.level || 'basic')}</td>
              <td>${esc(k.provider || 'manual')}</td>
              <td><span class="badge badge-${k.status === 'approved' ? 'success' : k.status === 'rejected' ? 'danger' : 'warning'}">${esc(k.status)}</span></td>
              <td style="font-size:12px;color:var(--text-muted);">${k.submitted_at ? new Date(k.submitted_at).toLocaleDateString() : '—'}</td>
              <td>
                ${k.status === 'pending' ? `
                  <button class="btn btn-sm btn-success" data-action="kyc-approve" data-kyc-addr="${esc(k.address)}">Approve</button>
                  <button class="btn btn-sm btn-danger" data-action="kyc-reject" data-kyc-addr="${esc(k.address)}" style="margin-left:4px;">Reject</button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ─── Revenue ───

function renderRevenue() {
  const r = state.revenue || {};
  return `
    <h2>Platform Revenue</h2>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value" style="color:var(--success);">${(r.platform_revenue || 0).toFixed(4)}</div><div class="stat-label">Platform Revenue</div></div>
      <div class="stat-card"><div class="stat-value">${(r.authority_revenue || 0).toFixed(4)}</div><div class="stat-label">Authority Revenue</div></div>
      <div class="stat-card"><div class="stat-value">${(r.user_yield || 0).toFixed(4)}</div><div class="stat-label">User Yield</div></div>
      <div class="stat-card"><div class="stat-value">${r.records_count || 0}</div><div class="stat-label">Records</div></div>
    </div>
    ${(r.records || []).length > 0 ? `
      <div class="card">
        <h3>Recent Records</h3>
        <table>
          <thead><tr><th>Wallet</th><th>Amount</th><th>Date</th></tr></thead>
          <tbody>
            ${r.records.map(rec => `
              <tr>
                <td class="mono">${esc(shortAddr(rec.wallet_id))}</td>
                <td>${rec.amount || '—'}</td>
                <td style="font-size:12px;color:var(--text-muted);">${rec.created_at ? new Date(rec.created_at).toLocaleDateString() : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}
  `;
}

// ─── Vault (owner-only: sweep mistaken transfers) ───

const VAULT_ABI_SWEEP = [
  'function sweepUnderlying(uint256 amount, address to) external',
  'function sweepToken(address token, address to) external',
  'function asset() view returns (address)',
  'function owner() view returns (address)',
];

function renderVault() {
  const cfg = state.vaultConfig || {};
  const vaultAddr = (cfg.vaultAddress || '').trim();
  const noContract = !vaultAddr;

  return `
    <h2>Vault</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      Recover tokens mistakenly sent to the vault. Only the vault owner can execute. Use for customer support to return mistaken transfers.
    </p>
    ${noContract
      ? '<div class="alert alert-warning">Vault contract not configured (VAULT_ADDRESS in server .env).</div>'
      : `
    <div class="card" style="margin-bottom:16px;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Vault contract</div>
      <div class="mono" style="word-break:break-all;">${esc(vaultAddr)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Chain ID: ${esc(cfg.chainId || '')}</div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <h3 style="margin-top:0;">Sweep underlying (vault asset)</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Recover underlying token mistakenly sent to the vault. Enter amount (in smallest units, e.g. 1e6 for 1 USDC) and recipient address.</p>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;">
        <div>
          <label class="form-label">Amount</label>
          <input type="text" class="form-input" id="vaultSweepAmount" placeholder="e.g. 1000000" style="width:200px;" />
        </div>
        <div style="flex:1;min-width:200px;">
          <label class="form-label">Recipient address</label>
          <input type="text" class="form-input" id="vaultSweepTo" placeholder="0x..." style="width:100%;" />
        </div>
        <button type="button" class="btn btn-primary" id="vaultSweepUnderlyingBtn">Sweep underlying</button>
      </div>
      <div id="vaultSweepUnderlyingStatus" style="margin-top:8px;font-size:12px;"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Sweep other token</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Recover any ERC20 (other than the vault asset) mistakenly sent to the vault. Full balance will be sent to recipient.</p>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;">
        <div style="flex:1;min-width:200px;">
          <label class="form-label">Token contract address</label>
          <input type="text" class="form-input" id="vaultSweepTokenAddr" placeholder="0x..." style="width:100%;" />
        </div>
        <div style="flex:1;min-width:200px;">
          <label class="form-label">Recipient address</label>
          <input type="text" class="form-input" id="vaultSweepTokenTo" placeholder="0x..." style="width:100%;" />
        </div>
        <button type="button" class="btn btn-primary" id="vaultSweepTokenBtn">Sweep token</button>
      </div>
      <div id="vaultSweepTokenStatus" style="margin-top:8px;font-size:12px;"></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <h3 style="margin-top:0;">Monthly harvest for all (platform / law firm settlement)</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Load all customers with harvestable yield from the DB, then harvest for each for settlement. Sign with the <strong>vault owner</strong> wallet.
      </p>
      <button type="button" class="btn btn-primary" id="vaultLoadUsersWithYieldBtn" style="margin-bottom:12px;">
        Load users with yield
      </button>
      <div id="vaultUsersWithYieldStatus" style="font-size:12px;margin-bottom:8px;"></div>
      <div id="vaultUsersWithYieldTable" style="display:${(state.vaultUsersWithYield || []).length ? 'block' : 'none'};">
        <table class="table" style="font-size:13px;">
          <thead>
            <tr><th>Address</th><th>Yield (USDC)</th><th>Action</th></tr>
          </thead>
          <tbody id="vaultUsersWithYieldTbody">
            ${(state.vaultUsersWithYield || []).map((u) => `
              <tr>
                <td class="mono" style="word-break:break-all;">${esc(u.address)}</td>
                <td>${esc(u.yieldFormatted)}</td>
                <td><button type="button" class="btn btn-sm btn-primary vault-harvest-for-btn" data-address="${esc(u.address)}">Harvest for this user</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    `}
  `;
}

// ─── Campaigns ───

function renderCampaigns() {
  const editModal = state.campaignDetail ? renderCampaignEditModal() : '';
  return `
    <h2>Campaigns</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      Rebate campaign parameters. Logic not yet enforced &mdash; placeholder for referral and fee-waiver features.
    </p>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">All Campaigns</h3>
        <button class="btn btn-primary btn-sm" id="btnCreateCampaign">+ New Campaign</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Enabled</th><th>Rebate (bps)</th><th>Yield Boost (bps)</th><th>Fee Waiver (days)</th><th>Start</th><th>End</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          ${state.campaigns.length === 0
            ? '<tr><td colspan="9" style="color:var(--text-muted);text-align:center;">No campaigns</td></tr>'
            : state.campaigns.map(c => `<tr>
              <td>${esc(c.name)}</td>
              <td><span class="badge badge-${c.enabled ? 'success' : 'muted'}">${c.enabled ? 'Yes' : 'No'}</span></td>
              <td>${c.rebate_bps || 0}</td>
              <td>${c.referral_yield_boost_bps || 0}</td>
              <td>${c.invitee_fee_waiver_days || 0}</td>
              <td>${c.start_date ? new Date(c.start_date).toLocaleDateString() : '—'}</td>
              <td>${c.end_date ? new Date(c.end_date).toLocaleDateString() : '—'}</td>
              <td><span class="badge">${esc(c.status || 'draft')}</span></td>
              <td><button class="btn btn-sm" data-action="edit-campaign" data-campaign-id="${esc(c.campaign_id || '')}">Edit</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${editModal}
  `;
}

function renderCampaignEditModal() {
  const c = state.campaignDetail || {};
  const isNew = !c.campaign_id;
  const title = isNew ? 'New Campaign' : 'Edit Campaign';
  const fld = (label, id, type, value, extra = '') =>
    `<div style="display:flex;flex-direction:column;gap:5px;">
       <label style="font-size:12px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${label}</label>
       <input id="${id}" type="${type}" class="input" value="${value}" ${extra} />
     </div>`;
  return `
    <div class="modal-overlay" data-action="close-campaign-modal">
      <div class="modal-content" onclick="event.stopPropagation()">
        <h3 style="margin:0 0 20px;font-size:18px;">${esc(title)}</h3>

        ${fld('Campaign Name', 'cmpName', 'text', esc(c.name || ''), 'placeholder="e.g. Early Bird Rebate"')}

        <label style="display:inline-flex;align-items:center;gap:8px;margin:16px 0;font-size:13px;cursor:pointer;padding:8px 12px;background:var(--surface-2,#1a2236);border:1px solid var(--border);border-radius:var(--radius);">
          <input type="checkbox" id="cmpEnabled" ${c.enabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--primary);" /> Enabled
        </label>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px 20px;margin-top:4px;">
          ${fld('Rebate (bps)',              'cmpRebateBps',  'number', c.rebate_bps || 0,              'min="0" max="10000"')}
          ${fld('Max / User (bps)',          'cmpMaxPerUser', 'number', c.max_per_user_bps || 500,      'min="0" max="10000"')}
          ${fld('Referral Yield Boost (bps)','cmpYieldBoost', 'number', c.referral_yield_boost_bps || 0,'min="0" max="10000"')}
          ${fld('Invitee Fee Waiver (days)', 'cmpFeeWaiver',  'number', c.invitee_fee_waiver_days || 0, 'min="0"')}
          ${fld('Start Date',               'cmpStartDate',  'date',   c.start_date ? c.start_date.substring(0, 10) : '')}
          ${fld('End Date',                 'cmpEndDate',    'date',   c.end_date ? c.end_date.substring(0, 10) : '')}
        </div>

        <div style="display:flex;flex-direction:column;gap:5px;margin-top:16px;">
          <label style="font-size:12px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Status</label>
          <select id="cmpStatus" class="input">
            ${['draft', 'active', 'paused', 'ended'].map(s => `<option value="${s}" ${(c.status || 'draft') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:24px;padding-top:16px;border-top:1px solid var(--border);">
          <button class="btn" data-action="close-campaign-modal" style="padding:8px 20px;">Cancel</button>
          <button class="btn btn-primary" id="btnSaveCampaign" style="padding:8px 24px;">${isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Main Render ───

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (!state.authenticated) {
    app.innerHTML = renderLogin();
    attachEvents();
    // Attach wallet UI event listeners (connect button)
    if (wallet) wallet.attachEvents(app);
    return;
  }

  const errorHTML = state.error ? `<div class="alert alert-danger">${esc(state.error)}</div>` : '';
  let content = '';
  switch (state.page) {
    case 'users': content = renderUsers(); break;
    case 'authorities': content = renderAuthorities(); break;
    case 'triggers': content = renderTriggers(); break;
    case 'redeliver': content = renderRedeliver(); break;
    case 'kyc': content = renderKYC(); break;
    case 'revenue': content = renderRevenue(); break;
    case 'vault': content = renderVault(); break;
    case 'campaigns': content = renderCampaigns(); break;
    default: content = renderDashboard();
  }

  const addrDisplay = state.auth?.address ? shortAddr(state.auth.address) : '';

  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;">
      <h1>Yault Ops</h1>
      <div style="display:flex;align-items:center;gap:12px;">
        ${addrDisplay ? `<span class="mono" style="font-size:12px;color:var(--text-muted);">${esc(addrDisplay)}</span>` : ''}
        <button class="btn btn-sm" style="background:var(--surface-2);color:var(--text-muted);border:1px solid var(--border);" data-action="logout">Sign Out</button>
      </div>
    </div>
    ${renderNav()}
    ${state.loading ? '<div style="text-align:center;padding:20px;"><div class="spinner"></div></div>' : ''}
    ${errorHTML}
    ${content}
  `;
  attachEvents();
}

// ─── Data Loading ───

async function loadPage() {
  state.loading = true;
  state.error = null;
  render();
  try {
    switch (state.page) {
      case 'dashboard':
        state.stats = await api('/admin/stats');
        break;
      case 'users': {
        const q = new URLSearchParams();
        if (state.usersSearch) q.set('search', state.usersSearch);
        q.set('page', String(state.usersPage || 1));
        q.set('limit', String(state.usersLimit || 20));
        const data = await api('/admin/users?' + q.toString());
        state.users = data.users || [];
        state.usersTotal = data.total ?? 0;
        state.usersPage = data.page ?? 1;
        state.usersLimit = data.limit ?? 20;
        break;
      }
      case 'authorities':
        state.authorities = await api('/admin/authorities');
        break;
      case 'triggers':
        state.triggers = await api('/admin/triggers');
        try {
          state.triggerPolicy = await api('/admin/trigger/policy');
        } catch (_) {
          state.triggerPolicy = null;
        }
        break;
      case 'kyc':
        state.kycList = await api('/admin/kyc');
        break;
      case 'revenue':
        state.revenue = await api('/admin/revenue');
        break;
      case 'vault':
        state.vaultConfig = await api('/admin/vault-config');
        break;
      case 'campaigns':
        state.campaigns = await api('/admin/campaigns');
        break;
      case 'redeliver': {
        const data = await api('/admin/release/redeliver-candidates');
        state.redeliverPlans = Array.isArray(data.plans) ? data.plans : [];
        state.redeliverCandidates = [];
        for (const plan of state.redeliverPlans) {
          for (const rec of plan.recipients || []) {
            state.redeliverCandidates.push({
              wallet_id: plan.wallet_id,
              authority_id: plan.authority_id == null ? '' : plan.authority_id,
              recipient_index: rec.recipient_index,
              delivery_status: rec.delivery_status,
              trigger_id: plan.trigger_id,
              pending_approval_id: null,
              pending_required: null,
              pending_current: null,
              pending_signed_by_current: false,
            });
          }
        }

        // Bind pending force-redeliver approvals to candidate rows so second signer can approve.
        try {
          const pending = await api('/admin/approvals/pending');
          const pendingApprovals = Array.isArray(pending.approvals) ? pending.approvals : [];
          const byKey = new Map();
          for (const approval of pendingApprovals) {
            if (!approval || approval.action !== 'force-redeliver' || !approval.params) continue;
            const key = redeliverCandidateKey(
              approval.params.wallet_id,
              approval.params.authority_id,
              approval.params.recipient_index
            );
            byKey.set(key, approval);
          }
          const currentAdmin = normalizeHexAddress(state.auth?.address || '');
          for (const c of state.redeliverCandidates) {
            const key = redeliverCandidateKey(c.wallet_id, c.authority_id, c.recipient_index);
            const approval = byKey.get(key);
            if (!approval) continue;
            const signers = Array.isArray(approval.current_approvals) ? approval.current_approvals : [];
            const signerAddrs = signers.map((s) => normalizeHexAddress(s?.address || ''));
            c.pending_approval_id = approval.approval_id || null;
            c.pending_required = approval.required_approvals || null;
            c.pending_current = signers.length;
            c.pending_signed_by_current = currentAdmin ? signerAddrs.includes(currentAdmin) : false;
          }
        } catch (_) {
          // Non-fatal: page still works without pending approvals context.
        }
        break;
      }
    }
  } catch (err) {
    state.error = 'Failed to load: ' + err.message;
  } finally {
    state.loading = false;
    render();
  }
}

// ─── Wallet Init ───

function initWallet() {
  if (typeof WalletConnector === 'undefined') return;

  wallet = new WalletConnector({
    apiBase: API_BASE,
    onConnect: async (_info) => {
      try {
        const clientToken = wallet.authResult && wallet.authResult.session_token;
        let sessionData;
        if (clientToken) {
          const sessionResp = await fetch(`${API_BASE}/admin/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Client-Session': clientToken },
            body: JSON.stringify({}),
          });
          if (!sessionResp.ok) {
            const err = await sessionResp.json().catch(() => ({}));
            const msg = err.error || 'Admin access denied';
            let hint = '';
            if (msg.indexOf('not authorized') !== -1) hint = ' Add your wallet to ADMIN_WALLETS in the server .env (e.g. ADMIN_WALLETS=0xYourAddress).';
            if (msg.indexOf('not configured') !== -1) hint = ' Set ADMIN_WALLETS or ADMIN_TOKEN in the server .env file.';
            throw new Error(msg + hint);
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
          const sessionResp = await fetch(`${API_BASE}/admin/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challenge_id, signature: sig, wallet_type: wallet.walletType }),
          });
          if (!sessionResp.ok) {
            const err = await sessionResp.json().catch(() => ({}));
            const msg = err.error || 'Admin access denied';
            let hint = '';
            if (msg.indexOf('not authorized') !== -1) hint = ' Add your wallet to ADMIN_WALLETS in the server .env (e.g. ADMIN_WALLETS=0xYourAddress).';
            if (msg.indexOf('not configured') !== -1) hint = ' Set ADMIN_WALLETS or ADMIN_TOKEN in the server .env file.';
            throw new Error(msg + hint);
          }
          sessionData = await sessionResp.json();
        }
        sessionToken = sessionData.session_token;

        state.auth = {
          pubkey: wallet.pubkey,
          address: wallet.address,
          walletType: wallet.walletType,
        };
        state.error = null;

        // 3. Load dashboard stats (uses session token, no signing)
        state.stats = await api('/admin/stats');
        state.authenticated = true;
        state.page = 'dashboard';
        render();
      } catch (err) {
        state.error = err.message || 'Access denied: wallet not authorized as admin';
        sessionToken = null;
        wallet.disconnect();
        state.auth = null;
        render();
      }
    },
    onDisconnect: () => {
      state.authenticated = false;
      state.auth = null;
      state.page = 'login';
      render();
    },
    onError: (msg) => {
      state.error = msg;
      render();
    },
  });
}

// ─── Events ───

function attachEvents() {
  const app = document.getElementById('app');
  if (!app) return;

  // Nav
  app.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => {
      state.page = el.dataset.page;
      state.error = null;
      loadPage();
    });
  });

  // Logout
  app.querySelectorAll('[data-action="logout"]').forEach(el => {
    el.addEventListener('click', () => {
      state.authenticated = false;
      state.auth = null;
      state.page = 'login';
      sessionToken = null;
      if (wallet) wallet.disconnect();
      render();
    });
  });

  // Users: search
  const usersSearchBtn = document.getElementById('usersSearchBtn');
  if (usersSearchBtn) {
    usersSearchBtn.addEventListener('click', () => {
      const input = document.getElementById('usersSearchInput');
      state.usersSearch = input ? input.value.trim() : '';
      state.usersPage = 1;
      loadPage();
    });
  }
  const usersSearchInput = document.getElementById('usersSearchInput');
  if (usersSearchInput) {
    usersSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.usersSearch = usersSearchInput.value.trim();
        state.usersPage = 1;
        loadPage();
      }
    });
  }
  const usersPagePrev = document.getElementById('usersPagePrev');
  if (usersPagePrev) {
    usersPagePrev.addEventListener('click', () => {
      if (state.usersPage > 1) {
        state.usersPage--;
        loadPage();
      }
    });
  }
  const usersPageNext = document.getElementById('usersPageNext');
  if (usersPageNext) {
    usersPageNext.addEventListener('click', () => {
      const totalPages = Math.ceil((state.usersTotal || 0) / (state.usersLimit || 20));
      if (state.usersPage < totalPages) {
        state.usersPage++;
        loadPage();
      }
    });
  }
  // User role change (dropdown)
  app.querySelectorAll('[data-action="user-role-change"]').forEach(el => {
    el.addEventListener('change', async () => {
      const addr = el.dataset.userAddr;
      const role = el.value;
      if (!addr || !role) return;
      try {
        const resp = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(addr)}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Session': sessionToken },
          body: JSON.stringify({ role }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to update role');
        }
        const u = state.users.find(x => (x.address || '').toLowerCase() === addr.toLowerCase());
        if (u) u.role = role;
        showToast('Role updated to ' + role, 'success');
        render();
      } catch (err) {
        showToast(err.message || 'Update failed', 'error');
        loadPage();
      }
    });
  });

  // View user detail
  app.querySelectorAll('[data-action="view-user"]').forEach(el => {
    el.addEventListener('click', async () => {
      const addr = el.dataset.userAddr;
      if (!addr) return;
      try {
        state.userDetail = await api(`/admin/users/${encodeURIComponent(addr)}`);
        state.selectedAuthority = null;
        render();
      } catch (err) {
        showToast('Failed to load user: ' + err.message, 'error');
      }
    });
  });

  // View authority detail
  app.querySelectorAll('[data-action="view-authority"]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.firmId;
      if (!id) return;
      state.selectedAuthority = state.authorities.find(a => (a.id || a.authority_id) === id) || null;
      state.userDetail = null;
      render();
    });
  });

  // Close detail modal
  app.querySelectorAll('[data-action="close-detail-modal"]').forEach(el => {
    el.addEventListener('click', () => {
      state.userDetail = null;
      state.selectedAuthority = null;
      render();
    });
  });

  // Verify authority
  app.querySelectorAll('[data-action="verify-firm"]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.firmId;
      try {
        await apiPost(`/authority/${id}/verify`, { verification_proof: 'ops-dashboard' });
        showToast('Authority verified', 'success');
        state.selectedAuthority = null;
        loadPage();
      } catch (err) {
        showToast('Verify failed: ' + err.message, 'error');
      }
    });
  });

  // KYC approve/reject
  app.querySelectorAll('[data-action="kyc-approve"]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        await apiPost(`/admin/kyc/${el.dataset.kycAddr}/review`, { decision: 'approved' });
        showToast('KYC approved', 'success');
        loadPage();
      } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    });
  });
  app.querySelectorAll('[data-action="kyc-reject"]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        await apiPost(`/admin/kyc/${el.dataset.kycAddr}/review`, { decision: 'rejected' });
        showToast('KYC rejected', 'success');
        loadPage();
      } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    });
  });

  // Trigger: abort (pause cooldown; remaining time preserved for resume)
  app.querySelectorAll('[data-action="trigger-abort"]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.triggerId;
      if (!id) return;
      const reason = window.prompt('Reason for abort (optional):') || '';
      try {
        await apiPost(`/admin/trigger/${encodeURIComponent(id)}/abort`, { reason: reason.trim() });
        showToast('Trigger aborted. Remaining time is preserved for resume.', 'success');
        loadPage();
      } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    });
  });

  // Trigger: resume (restore cooldown with remaining time)
  app.querySelectorAll('[data-action="trigger-resume"]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.triggerId;
      if (!id) return;
      try {
        await apiPost(`/admin/trigger/${encodeURIComponent(id)}/resume`, {});
        showToast('Trigger resumed. Cooldown restarted with remaining time.', 'success');
        loadPage();
      } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    });
  });

  // Trigger: legal confirmation (for high-value / dual attestation)
  app.querySelectorAll('[data-action="trigger-legal-confirm"]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.triggerId;
      if (!id) return;
      try {
        await apiPost(`/admin/trigger/${encodeURIComponent(id)}/legal-confirm`, {});
        showToast('Legal confirmation recorded.', 'success');
        loadPage();
      } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    });
  });

  // Trigger: emergency release
  app.querySelectorAll('[data-action="trigger-emergency-release"]').forEach(el => {
    el.addEventListener('click', async () => {
      const walletId = (document.getElementById('emergencyWalletId') || {}).value?.trim();
      const recipientIndex = parseInt((document.getElementById('emergencyRecipientIndex') || {}).value, 10);
      let evidenceHash = (document.getElementById('emergencyEvidenceHash') || {}).value?.trim().replace(/^0x/i, '') || '';
      if (!walletId || !Number.isInteger(recipientIndex) || recipientIndex < 0) {
        showToast('Wallet ID and path index (non-negative) are required', 'error');
        return;
      }
      if (!evidenceHash || evidenceHash.length !== 64 || !/^[0-9a-fA-F]+$/.test(evidenceHash)) {
        showToast('Evidence hash must be 64 hex characters', 'error');
        return;
      }
      try {
        await apiPost('/admin/trigger/emergency-release', {
          wallet_id: walletId,
          recipient_index: recipientIndex,
          evidence_hash: evidenceHash,
        });
        showToast('Emergency release submitted. Trigger is in cooldown.', 'success');
        document.getElementById('emergencyWalletId').value = '';
        document.getElementById('emergencyRecipientIndex').value = '';
        document.getElementById('emergencyEvidenceHash').value = '';
        loadPage();
      } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    });
  });

  // Redeliver NFT (one row)
  app.querySelectorAll('[data-action="redeliver-one"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.candidateIndex, 10);
      const c = state.redeliverCandidates && state.redeliverCandidates[i];
      if (!c) return;
      const resultEl = document.getElementById('redeliverResult');
      if (resultEl) { resultEl.style.display = 'none'; resultEl.textContent = ''; }
      btn.disabled = true;
      try {
        const body = c.pending_approval_id
          ? { approval_id: c.pending_approval_id }
          : {
              wallet_id: c.wallet_id,
              authority_id: c.authority_id,
              recipient_index: c.recipient_index,
              force_redeliver: true,
            };
        const data = await apiPost('/admin/release/redeliver', body);
        if (resultEl) {
          resultEl.style.display = 'block';
          if (data.delivered) {
            resultEl.style.color = 'var(--success, #28a745)';
            resultEl.textContent = 'Redelivered. Tx: ' + (data.txId || '—');
            resultEl.title = data.txId || '';
            showToast('Redeliver succeeded', 'success');
            state.page = 'redeliver';
            loadPage();
          } else if (data.status === 'awaiting_approval' && data.approval_id) {
            c.pending_approval_id = data.approval_id;
            c.pending_required = data.required || null;
            c.pending_current = data.current || null;
            c.pending_signed_by_current = true;
            resultEl.style.color = 'var(--warning, #f59e0b)';
            resultEl.textContent = data.message || 'Awaiting additional admin approval.';
            resultEl.title = data.approval_id;
            showToast('Approval created. Waiting for another admin signature.', 'warning');
            render();
          } else {
            resultEl.style.color = 'var(--danger, #dc3545)';
            resultEl.textContent = 'Failed: ' + (data.error || 'Redeliver failed');
            resultEl.title = '';
            showToast(data.error || 'Redeliver failed', 'error');
          }
        } else {
          if (data.delivered) { showToast('Redeliver succeeded', 'success'); state.page = 'redeliver'; loadPage(); }
          else showToast(data.error || 'Redeliver failed', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Redeliver request failed', 'error');
        if (resultEl) {
          resultEl.style.display = 'block';
          resultEl.style.color = 'var(--danger, #dc3545)';
          resultEl.textContent = 'Error: ' + (err.message || 'Request failed');
        }
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Campaigns: create
  const btnCreateCampaign = document.getElementById('btnCreateCampaign');
  if (btnCreateCampaign) {
    btnCreateCampaign.addEventListener('click', () => {
      state.campaignDetail = { name: '', enabled: false, rebate_bps: 0, max_per_user_bps: 500, referral_yield_boost_bps: 0, invitee_fee_waiver_days: 0, start_date: '', end_date: '', status: 'draft' };
      render();
    });
  }
  // Campaigns: edit
  app.querySelectorAll('[data-action="edit-campaign"]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.campaignId;
      const c = state.campaigns.find(x => x.campaign_id === id);
      if (c) { state.campaignDetail = { ...c }; render(); }
    });
  });
  // Campaigns: close modal
  app.querySelectorAll('[data-action="close-campaign-modal"]').forEach(el => {
    el.addEventListener('click', () => { state.campaignDetail = null; render(); });
  });
  // Campaigns: save
  const btnSaveCampaign = document.getElementById('btnSaveCampaign');
  if (btnSaveCampaign) {
    btnSaveCampaign.addEventListener('click', async () => {
      const body = {
        name: (document.getElementById('cmpName') || {}).value || '',
        enabled: !!(document.getElementById('cmpEnabled') || {}).checked,
        rebate_bps: parseInt((document.getElementById('cmpRebateBps') || {}).value, 10) || 0,
        max_per_user_bps: parseInt((document.getElementById('cmpMaxPerUser') || {}).value, 10) || 0,
        referral_yield_boost_bps: parseInt((document.getElementById('cmpYieldBoost') || {}).value, 10) || 0,
        invitee_fee_waiver_days: parseInt((document.getElementById('cmpFeeWaiver') || {}).value, 10) || 0,
        start_date: (document.getElementById('cmpStartDate') || {}).value || null,
        end_date: (document.getElementById('cmpEndDate') || {}).value || null,
        status: (document.getElementById('cmpStatus') || {}).value || 'draft',
      };
      try {
        if (state.campaignDetail && state.campaignDetail.campaign_id) {
          await apiPatch('/admin/campaigns/' + state.campaignDetail.campaign_id, body);
          showToast('Campaign updated', 'success');
        } else {
          await apiPost('/admin/campaigns', body);
          showToast('Campaign created', 'success');
        }
        state.campaignDetail = null;
        loadPage();
      } catch (err) {
        showToast('Failed: ' + err.message, 'error');
      }
    });
  }

  // Vault: load users with yield (monthly harvest-for-all)
  const vaultLoadUsersWithYieldBtn = document.getElementById('vaultLoadUsersWithYieldBtn');
  if (vaultLoadUsersWithYieldBtn) {
    vaultLoadUsersWithYieldBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('vaultUsersWithYieldStatus');
      if (statusEl) statusEl.textContent = 'Loading...';
      vaultLoadUsersWithYieldBtn.disabled = true;
      try {
        const data = await api('/admin/vault/users-with-yield');
        state.vaultUsersWithYield = data.users || [];
        if (statusEl) statusEl.textContent = state.vaultUsersWithYield.length ? `${state.vaultUsersWithYield.length} user(s) with yield` : 'No users with harvestable yield.';
        render();
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + (err.message || '');
        showToast(err.message || 'Failed to load', 'error');
      } finally {
        vaultLoadUsersWithYieldBtn.disabled = false;
      }
    });
  }

  // Vault: harvest for one user (delegated, buttons are in table rows)
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.addEventListener('click', async (e) => {
      if (!e.target.classList.contains('vault-harvest-for-btn')) return;
      const address = e.target.getAttribute('data-address');
      if (!address) return;
      const cfg = state.vaultConfig;
      if (!cfg || !cfg.vaultAddress) {
        showToast('Vault not configured', 'error');
        return;
      }
      const provider = (wallet && wallet._yalletProvider) || window.yallet;
      if (!provider) {
        showToast('No wallet (use vault owner to sign)', 'error');
        return;
      }
      e.target.disabled = true;
      try {
        const data = await apiPost('/admin/vault/harvest-for', { user_address: address });
        if (data.status !== 'pending_signature' || !data.transaction) {
          showToast(data.error || 'No transaction returned', 'error');
          return;
        }
        const tx = data.transaction;
        const chainIdHex = '0x' + parseInt(tx.chainId || cfg.chainId, 10).toString(16);
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
        const txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{
            to: tx.to,
            data: tx.data,
            value: tx.value || '0x0',
            chainId: chainIdHex,
          }],
        });
        showToast('Harvest-for submitted: ' + txHash, 'success');
        const addrNorm = (address || '').toLowerCase();
        state.vaultUsersWithYield = state.vaultUsersWithYield.filter((u) => (u.address || '').toLowerCase() !== addrNorm);
        render();
      } catch (err) {
        showToast(err.message || 'Failed', 'error');
      } finally {
        e.target.disabled = false;
      }
    });
  }

  // Vault: sweep underlying
  const vaultSweepUnderlyingBtn = document.getElementById('vaultSweepUnderlyingBtn');
  if (vaultSweepUnderlyingBtn) {
    vaultSweepUnderlyingBtn.addEventListener('click', async () => {
      const cfg = state.vaultConfig;
      if (!cfg || !cfg.vaultAddress) {
        showToast('Vault not configured', 'error');
        return;
      }
      const amountStr = (document.getElementById('vaultSweepAmount') || {}).value.trim();
      const to = (document.getElementById('vaultSweepTo') || {}).value.trim();
      const statusEl = document.getElementById('vaultSweepUnderlyingStatus');
      if (!amountStr || !to) {
        showToast('Enter amount and recipient address', 'error');
        return;
      }
      let amount;
      try {
        amount = BigInt(amountStr);
      } catch (_) {
        showToast('Invalid amount', 'error');
        return;
      }
      if (amount <= 0n) {
        showToast('Amount must be positive', 'error');
        return;
      }
      const provider = (wallet && wallet._yalletProvider) || window.yallet;
      if (!provider) {
        showToast('No wallet provider (install Yallet extension)', 'error');
        return;
      }
      if (typeof window.ethers === 'undefined') {
        showToast('ethers not loaded', 'error');
        return;
      }
      if (statusEl) statusEl.textContent = 'Switching chain and sending tx...';
      vaultSweepUnderlyingBtn.disabled = true;
      try {
        const chainIdHex = '0x' + parseInt(cfg.chainId, 10).toString(16);
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
        const ethers = window.ethers;
        const ethersProvider = new ethers.BrowserProvider(provider);
        const signer = await ethersProvider.getSigner();
        const vault = new ethers.Contract(cfg.vaultAddress, VAULT_ABI_SWEEP, signer);
        const tx = await vault.sweepUnderlying(amount, to);
        if (statusEl) statusEl.textContent = 'Tx submitted: ' + tx.hash;
        showToast('Sweep underlying submitted: ' + tx.hash, 'success');
      } catch (err) {
        const msg = err.message || String(err);
        if (statusEl) statusEl.textContent = 'Error: ' + msg;
        showToast(msg, 'error');
      } finally {
        vaultSweepUnderlyingBtn.disabled = false;
      }
    });
  }

  // Vault: sweep token (other ERC20)
  const vaultSweepTokenBtn = document.getElementById('vaultSweepTokenBtn');
  if (vaultSweepTokenBtn) {
    vaultSweepTokenBtn.addEventListener('click', async () => {
      const cfg = state.vaultConfig;
      if (!cfg || !cfg.vaultAddress) {
        showToast('Vault not configured', 'error');
        return;
      }
      const tokenAddr = (document.getElementById('vaultSweepTokenAddr') || {}).value.trim();
      const to = (document.getElementById('vaultSweepTokenTo') || {}).value.trim();
      const statusEl = document.getElementById('vaultSweepTokenStatus');
      if (!tokenAddr || !to) {
        showToast('Enter token address and recipient address', 'error');
        return;
      }
      const provider = (wallet && wallet._yalletProvider) || window.yallet;
      if (!provider) {
        showToast('No wallet provider (install Yallet extension)', 'error');
        return;
      }
      if (typeof window.ethers === 'undefined') {
        showToast('ethers not loaded', 'error');
        return;
      }
      if (statusEl) statusEl.textContent = 'Switching chain and sending tx...';
      vaultSweepTokenBtn.disabled = true;
      try {
        const chainIdHex = '0x' + parseInt(cfg.chainId, 10).toString(16);
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
        const ethers = window.ethers;
        const ethersProvider = new ethers.BrowserProvider(provider);
        const signer = await ethersProvider.getSigner();
        const vault = new ethers.Contract(cfg.vaultAddress, VAULT_ABI_SWEEP, signer);
        const tx = await vault.sweepToken(tokenAddr, to);
        if (statusEl) statusEl.textContent = 'Tx submitted: ' + tx.hash;
        showToast('Sweep token submitted: ' + tx.hash, 'success');
      } catch (err) {
        const msg = err.message || String(err);
        if (statusEl) statusEl.textContent = 'Error: ' + msg;
        showToast(msg, 'error');
      } finally {
        vaultSweepTokenBtn.disabled = false;
      }
    });
  }
}

// ─── Init (unified app: register for main.js) ───
window.YaultPortals = window.YaultPortals || {};
window.YaultPortals.ops = {
  init: function () {
    initWallet();
    render();
    window.onYaultLocaleChange = function () { render(); };
  },
};
