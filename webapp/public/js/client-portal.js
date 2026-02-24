/**
 * app.js — Yault Client Portal (Unified)
 *
 * Merged portal for all users (asset owners and recipients).
 * Replaces the previous separate "recipient-portal".
 *
 * Pages:
 * - Login    — Wallet connect (Phantom / MetaMask / manual keys)
 * - Wallet   — Default tab: on-chain / Vault balances, send, deposit/redeem
 * - Asset Plan (protection) — bind authorities; authorization factor generated and sent only to authorities (user never sees it)
 * - Claim       — Claim released assets (step wizard)
 * - Activity    — Release history, audit trail
 * - Settings    — Connected wallet, KYC, preferences
 *
 * Terminology is intentionally neutral — no assumptions about the
 * relationship between sender and recipient (could be asset release,
 * trust, escrow, corporate transfer, etc.).
 */

'use strict';

function T(key) { return (typeof window.t === 'function' ? window.t(key) : key); }

const API_BASE = (typeof YAULT_ENV !== 'undefined' && YAULT_ENV?.api?.baseUrl)
  ? YAULT_ENV.api.baseUrl
  : (window.location.port === '3001' ? '/api' : (window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : 'https://api.yault.xyz/api'));

/** Generate a random password of given length (alphanumeric, easy to type), default 12 chars. */
function generateRandomPassphrase(len) {
  len = len || 12;
  var chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var buf = new Uint8Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (var i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  var out = '';
  for (var i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

// ─── Wallet Connector (loaded from shared module) ───
let wallet = null; // WalletConnector instance
let _e2eReady = false; // true once E2E client is initialized

// ─── State ───

const state = {
  page: 'login',          // login | wallet | accounts | protection | claim | activity | settings
  auth: null,             // { pubkey, walletType, address }
  // protection page (bind authorities; authorization factor sent to them only)
  protectionStep: 'overview', // 'overview' | 'create-plan' | 'search' | 'configure' | 'distribute'
  planStep: 'triggers',   // 'triggers' | 'recipients' | 'trigger-config' | 'review' | 'credentials'
  planType: null,         // 'wallet' | 'yield_pool' — Wallet Plan supports only one recipient; Yield Pool requires assets in the pool
  planTriggerTypes: { oracle: false, legal_authority: false, inactivity: false, oracle_with_legal_fallback: false },
  vaultBalanceForPlan: null, // { value, shares } when step = recipients & planType = yield_pool
  planRecipients: [],     // [{ label, email?, address?, percentage }] — from Related Accounts
  planTriggerConfig: {
    oracle: {},
    legalAuthority: { jurisdiction: '', selectedFirms: [], firmSearchResults: [] },
    inactivityMonths: 12,
  },
  planReviewed: false,
  planMemo: '',            // optional "letter to future heirs" — encrypted with credential, sent to recipient on release
  planSubmitConfirmModal: false, // After clicking Submit, show a modal warning about n signature prompts
  planForConfigure: null,
  savedPlan: null,         // { triggerTypes, recipients, triggerConfig } after Review Submit
  generatedPathCredentials: null, // Deprecated: no longer displays plaintext, switched to RWA NFT
  credentialMintResults: null,     // [{ recipient, creds, success, txId?, error? }] — mint results, no plaintext included
  selectedFirms: [],      // [{ id, name, jurisdiction, publicKeyHex, verified }]
  adminFactorHex: '',     // not shown to user; generated only in memory during distribute, then sent to authorities
  distributionResult: null, // { shares, fingerprint? } — fingerprint not shown to user
  firmSearchResults: [],
  boundFirms: [],         // already bound firms from server
  // wallet page
  walletTab: 'wallet',    // legacy, kept for any refs
  walletSection: 'balances', // 'balances' | 'send' | 'vault' — left sidebar selection
  walletAddresses: null,  // { evm_address, bitcoin_address, solana_address, cosmos_address, polkadot_address?, ... } from GET /api/me/addresses or login
  walletSelectedChain: 'evm', // 'evm' | 'bitcoin' | 'solana' | 'cosmos' | 'polkadot'
  walletSelectedAddress: '',
  walletBalances: { eth: '0.00', sol: '0.00', btc: '0.00' },
  walletBalancesUsdc: { ethereum: '0.00', solana: '0.00' }, // filled by GET /vault/balance
  walletBalancesWeth: { ethereum: '0.00' }, // filled by GET /vault/balance
  vaultBalances: { shares: '0.00', value: '0.00', yield: '0.00' },
  escrowBalances: { shares: '0', value: '0', recipient_indices: [] },
  vaultUnderlyingSymbol: 'USDC',  // from GET /vault/balance (VAULT_UNDERLYING_SYMBOL), e.g. 'WETH'
  // Global UI context: all balances/addresses below derive from this (Chain + Token cascading dropdowns in header)
  globalChainKey: 'ethereum',  // 'ethereum' | 'solana' | 'bitcoin'
  globalTokenKey: 'ETH',       // e.g. 'ETH', 'USDC', 'SOL', 'BTC'
  sendForm: { to: '', amount: '', chain: 'ethereum', selectedAccountIndex: null },
  vaultAction: null,      // null | 'deposit' | 'redeem'
  vaultAmount: '',
  vaultDepositLoading: false,
  vaultHarvestLoading: false,
  vaultSimulateLoading: false,
  vaultReclaimLoading: false,
  vaultRedeemLoading: false,
  activities: [],                // [{ id, type, amount, asset, tx_hash, status, created_at }]
  activitiesLoading: false,
  // Accounts page (related accounts, invite, transfer)
  accountsSection: 'accounts', // 'accounts' | 'invite' — left sidebar selection
  relatedAccountsInvites: [],  // [{ email, status: 'pending'|'accepted', label? }]
  relatedAccounts: [],         // [{ email, label, address? }] — accepted / linked accounts
  accountsInviteEmail: '',
  accountsTransferTarget: null, // index into relatedAccounts, or null when not in transfer view
  accountsTransferToken: 'ETH',
  accountsTransferAmount: '',
  // deniable accounts (context-isolated vault addresses, session-only)
  deniableAccounts: [],   // [{ context, label, addresses: { evm_address, solana_address, ... }, balances? }]
  showAddDeniable: false,
  newDeniableContext: '',  // e.g. "entity:domain:0"
  newDeniableLabel: '',
  // claim flow
  claimStep: 1,           // 1: credentials, 2: status check, 3: activation, 4: balances, 5: transfer
  walletId: '',
  pathIndex: 1,
  mnemonic: '',
  passphrase: '',         // formerly "UserCred"
  releaseKey: '',         // formerly "AdminFactor" (may be filled from claim/lookup factors)
  releaseStatus: null,
  claimLookupFactors: [], // factors[] from GET /api/claim/:wallet_id when released
  derivedKeys: null,
  balances: null,
  transferResult: null,
  // (mnemonic management removed — signing handled by Yallet extension)
  // Settings page left sidebar
  settingsSection: 'wallet', // 'wallet' | 'account' | 'kyc'
  // KYC
  kycStatus: 'none',  // 'none' | 'pending' | 'approved' | 'rejected'
  kycLevel: '',
  // trial request form
  trialForm: { name: '', email: '', xAccount: '', linkedin: '', organization: '', purpose: '' },
  trialSubmitted: false,
  // general
  releases: [],           // history of release events
  loading: false,
  error: null,
  // path claim (YaultPathClaim): owner = register/deposit/registerPath; recipient = claim (amount from blob)
  pathClaimConfig: null,  // { pathClaimAddress, assetAddress, chainId, rpcUrl, enabled }
  pathClaimWalletId: '',  // wallet id string for pool (hashed to walletIdHash)
  pathClaimDepositAmount: '',
  pathClaimPathIndex: '1',
  pathClaimPathController: '',
  pathClaimPathTotalAmount: '',
  pathClaimRemaining: null,
  pathClaimAmountFromBlob: null,  // parsed from blob (80-char hex), no amount input on page
  pathClaimControllerKey: '',     // path controller private key (hex) for signing claim; from Unseal in production
  pathClaimLoading: false,
  pathClaimError: null,
  claimMeItems: [],              // GET /api/claim/me → items (released for this recipient)
  selectedClaimItem: null,       // { wallet_id, path_index, label, admin_factor_hex, blob_hex? }
  claimPlanReleases: [],        // GET /api/claim/plan-releases → items (test flow: AdminFactor linked by evm)
  planAuthorityId: 'test-authority', // authority_id when sending release link (test)
  claimPlanDialogItem: null,    // row for which Claim dialog is open
  claimPlanDialogAdminFactor: null, // result after get-admin-factor
  escrowBalance: null,          // { configured, remainingShares, remainingAssets, underlyingSymbol, underlyingDecimals, ... }
  claimSection: 'claims',       // 'claims' | 'redeem' — left sidebar under Claim
  redeemChain: 'ethereum',
  redeemChainId: 1,
  redeemToken: '',
  redeemUserTokens: [],        // GET /api/me/tokens?chain= — custom tokens for selected chain
  redeemToAddress: '',
  redeemWalletJson: null,       // Cached from view_wallet_rev32_with_secondary_wasm result (session-scoped)
  addTokenDialogOpen: false,
  addTokenName: '',
  addTokenContract: '',
  // Profile (Client)
  clientProfile: null,   // { address, name, email, phone, address? }
  profileEditMode: false,
};

// Tokens per chain for global context dropdown (cascading: Token options depend on Chain)
var TOKENS_BY_CHAIN = {
  ethereum: [{ value: 'ETH', label: 'ETH' }, { value: 'WETH', label: 'WETH' }, { value: 'USDC', label: 'USDC' }],
  solana: [{ value: 'SOL', label: 'SOL' }, { value: 'USDC', label: 'USDC' }],
  bitcoin: [{ value: 'BTC', label: 'BTC' }],
};

// ─── Auth helper: use session token directly if available (no second signature needed), otherwise do challenge+sign ───
async function getAuthHeadersAsync() {
  if (!wallet || !wallet.connected) return {};
  if (wallet.sessionToken) {
    return { 'X-Client-Session': wallet.sessionToken };
  }
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

// ─── Redeem: chains and default tokens (top 3–4 per chain) ───
const REDEEM_CHAINS = [
  { key: 'bitcoin', label: 'Bitcoin', chainId: null, native: 'BTC' },
  { key: 'ethereum', label: 'Ethereum', chainId: 1, native: 'ETH' },
  { key: 'solana', label: 'Solana', chainId: null, native: 'SOL' },
  { key: 'bnb', label: 'BNB Smart Chain', chainId: 56, native: 'BNB' },
  { key: 'polygon', label: 'Polygon', chainId: 137, native: 'MATIC' },
  { key: 'arbitrum', label: 'Arbitrum One', chainId: 42161, native: 'ETH' },
  { key: 'optimism', label: 'Optimism', chainId: 10, native: 'ETH' },
  { key: 'base', label: 'Base', chainId: 8453, native: 'ETH' },
  { key: 'avalanche', label: 'Avalanche C-Chain', chainId: 43114, native: 'AVAX' },
  { key: 'fantom', label: 'Fantom', chainId: 250, native: 'FTM' },
  { key: 'cronos', label: 'Cronos', chainId: 25, native: 'CRO' },
];
const REDEEM_DEFAULT_TOKENS = {
  bitcoin: [{ symbol: 'BTC', name: 'Bitcoin', contract: '' }],
  ethereum: [
    { symbol: 'ETH', name: 'Ethereum', contract: '' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { symbol: 'DAI', name: 'Dai', contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
  ],
  solana: [
    { symbol: 'SOL', name: 'Solana', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { symbol: 'USDT', name: 'Tether USD', contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
    { symbol: 'RAY', name: 'Raydium', contract: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  ],
  bnb: [
    { symbol: 'BNB', name: 'BNB', contract: '' },
    { symbol: 'BUSD', name: 'Binance USD', contract: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0x55d398326f99059fF775485246999027B3197955' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  ],
  polygon: [
    { symbol: 'MATIC', name: 'Polygon', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
    { symbol: 'WETH', name: 'Wrapped Ether', contract: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
  ],
  arbitrum: [
    { symbol: 'ETH', name: 'Ethereum', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
    { symbol: 'ARB', name: 'Arbitrum', contract: '0x912CE59144191C1204E64559FE8253a0e49E6548' },
  ],
  optimism: [
    { symbol: 'ETH', name: 'Ethereum', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58' },
    { symbol: 'OP', name: 'Optimism', contract: '0x4200000000000000000000000000000000000042' },
  ],
  base: [
    { symbol: 'ETH', name: 'Ethereum', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' },
  ],
  avalanche: [
    { symbol: 'AVAX', name: 'Avalanche', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' },
    { symbol: 'WETH', name: 'Wrapped Ether', contract: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB' },
  ],
  fantom: [
    { symbol: 'FTM', name: 'Fantom', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0x049d68029688eAbF473097a2fC38ef61633A3C7A' },
  ],
  cronos: [
    { symbol: 'CRO', name: 'Cronos', contract: '' },
    { symbol: 'USDC', name: 'USD Coin', contract: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59' },
    { symbol: 'USDT', name: 'Tether USD', contract: '0x66e4282623D0A8b5090120624036A2a6569240B4' },
  ],
};

// ─── Navigation ───

const PAGES = ['wallet', 'accounts', 'protection', 'claim', 'profile', 'settings', 'activities'];

function navigate(page) {
  state.page = page;
  state.error = null;
  render();
  if (!state.auth) return;
  // Fetch tab data from API on every tab switch to stay in sync with the database
  if (page === 'wallet') {
    refreshWalletBalances();
    loadWalletAddresses().then(() => {
      if (!state.walletAddresses && wallet?.walletType === 'yallet' && wallet?.connected) {
        fetchWalletAddressesFromExtension();
      }
      render();
    });
    loadReleases();
  } else if (page === 'accounts') {
    loadAccountInvites().then(() => render());
  } else if (page === 'protection') {
    Promise.all([loadReleases(), loadWalletPlan()]).then(() => render());
  } else if (page === 'claim') {
    loadClaimMe().then(() => render());
  } else if (page === 'activities') {
    loadActivities();
  } else if (page === 'profile') {
    loadClientProfile().then(() => render());
  } else if (page === 'settings') {
    Promise.all([loadKYCStatus(), loadWalletAddresses()]).then(() => render());
  }
}

// ─── Auth ───

function initWallet() {
  wallet = new WalletConnector({
    apiBase: API_BASE,
    onConnect: async (info) => {
      try {
        // connectAndSignIn already completed verification and set wallet.authResult; use it directly, no need to call authenticate() again to avoid circular verification
        const authResult = wallet.authResult || await wallet.authenticate();
        state.auth = {
          pubkey: authResult.pubkey,
          walletType: wallet.walletType,
          address: wallet.address,
        };
        const provider = wallet._yalletProvider || window.yallet;
        if (provider && window.E2EClient) {
          try {
            _e2eReady = await window.E2EClient.initE2EClient(provider);
          } catch { /* non-fatal */ }
        }
        state.page = 'wallet';
        showToast('Connected', 'success');
        // On every login, fetch multi-chain addresses and PUT to server walletAddresses to ensure persistence
        let addressesToSave = info.allAddresses;
        if (!addressesToSave && provider && typeof WalletConnector.getYalletAllAddresses === 'function') {
          addressesToSave = await WalletConnector.getYalletAllAddresses(provider).catch(function () { return null; });
        }
        if (addressesToSave) {
          state.walletAddresses = addressesToSave;
          setDefaultWalletSelection();
          try {
            const headers = await getAuthHeadersAsync();
            const resp = await fetch(`${API_BASE}/me/addresses`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ addresses: addressesToSave }),
            });
            if (!resp.ok) console.warn('[Yault] Save wallet addresses failed:', await resp.text());
          } catch (e) {
            console.warn('[Yault] Save wallet addresses failed:', e.message);
          }
        }
        // After login, fetch all data at once (using session token, no passkey prompt); tab switches only re-render, no new requests
        await Promise.all([
          loadReleases(),
          loadKYCStatus(),
          loadAccountInvites(),
          loadWalletPlan(),
          info.allAddresses || addressesToSave ? Promise.resolve() : loadWalletAddresses(),
          refreshWalletBalances(), // Also fetch balances when opening the Wallet tab by default
        ]);
        render();
      } catch (err) {
        showToast('Auth failed: ' + err.message, 'error');
      }
    },
    onDisconnect: () => {
      state.auth = null;
      state.page = 'login';
      render();
    },
    onError: (msg) => {
      showToast(msg, 'error');
    },
  });
}

// ─── Auth Helper ───

/**
 * Make an authenticated API request.
 * Uses E2E signed fetch (via Yallet extension) when available,
 * falls back to plain fetch (for dev/unauthenticated endpoints).
 *
 * @param {string} url — Full API URL
 * @param {object} [options] — Standard fetch options
 * @returns {Promise<Response>}
 */
function _hasSessionAuth(headers) {
  if (!headers) return false;
  const get = (k) => typeof headers.get === 'function' ? headers.get(k) : headers[k];
  return get('X-Client-Session') || (get('Authorization') && String(get('Authorization')).startsWith('Bearer '));
}

async function apiFetch(url, options = {}) {
  // If session or Bearer auth already present, use plain fetch to avoid E2E override causing 401
  if (_hasSessionAuth(options.headers)) {
    return fetch(url, options);
  }
  // When logged in with session token, always use plain fetch to prevent headerless requests (e.g. loadReleases) from going through e2eFetch and triggering another passkey prompt
  if (wallet && wallet.sessionToken) {
    return fetch(url, options);
  }
  if (_e2eReady && window.E2EClient && window.E2EClient.isE2EEnabled()) {
    return window.E2EClient.e2eFetch(url, options);
  }
  return fetch(url, options);
}

// ─── Data Loading ───

async function loadReleases() {
  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    const resp = await apiFetch(`${API_BASE}/trigger/pending?wallet_id=${encodeURIComponent(state.auth?.address || '')}`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      state.releases = Array.isArray(data) ? data : (data.triggers || []);
    }
  } catch { /* non-fatal */ }
}

async function loadBoundFirms() {
  try {
    const addr = state.auth?.address || '';
    if (!addr) return;
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    const resp = await apiFetch(`${API_BASE}/release/status/${encodeURIComponent(addr)}`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      const firms = data.firms || [];
      state.boundFirms = firms.map(f => ({
        id: f.id,
        name: f.name || f.id,
        jurisdiction: f.jurisdiction || '',
        verified: !!f.verified,
        recipient_indices: f.recipient_indices || [],
        shamir_config: f.recipient_count != null ? { total_shares: firms.length } : undefined,
      }));
    }
  } catch { /* non-fatal */ }
}

async function loadKYCStatus() {
  try {
    const addr = state.auth?.address || '';
    if (!addr) return;
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    const resp = await apiFetch(`${API_BASE}/kyc/status/${encodeURIComponent(addr)}`, { headers });
    if (resp.status === 401 && wallet) wallet.sessionToken = null;
    if (resp.ok) {
      const data = await resp.json();
      state.kycStatus = data.status || 'none';
      state.kycLevel = data.level || '';
    }
  } catch { /* non-fatal */ }
}

/** Load current user profile (Client) from GET /api/me/profile */
async function loadClientProfile() {
  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    const resp = await apiFetch(`${API_BASE}/me/profile`, { headers });
    if (resp.ok) state.clientProfile = await resp.json();
    else state.clientProfile = { address: state.auth?.address || '', name: '', email: '', phone: '', physical_address: '' };
  } catch (_) {
    state.clientProfile = { address: state.auth?.address || '', name: '', email: '', phone: '', physical_address: '' };
  }
}

/** Get recipient address for a given chain from account (uses account.addresses from recipient-addresses API). */
function getAddressForChain(account, chainKey) {
  if (!account) return '';
  var addrs = account.addresses;
  if (addrs && typeof addrs === 'object') {
    if (chainKey === 'ethereum') return (addrs.evm_address && String(addrs.evm_address).trim()) || '';
    if (chainKey === 'bitcoin') return (addrs.bitcoin_address && String(addrs.bitcoin_address).trim()) || '';
    if (chainKey === 'solana') return (addrs.solana_address && String(addrs.solana_address).trim()) || '';
  }
  if (chainKey === 'ethereum' && account.address) return String(account.address).trim();
  return '';
}

/** Load invites + related accounts from API. No second signature needed when using session token. */
async function loadAccountInvites() {
  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    if (!headers.Authorization && !headers['X-Client-Session']) return;
    const url = `${API_BASE}/account-invites?_=${Date.now()}`;
    const resp = await apiFetch(url, { headers, cache: 'no-store' });
    if (resp.status === 401 && wallet) wallet.sessionToken = null;
    if (!resp.ok) return;
    const data = await resp.json();
    const list = data.invites || [];
    state.relatedAccountsInvites = list.filter((i) => (i.status || 'pending') === 'pending').map((i) => ({ id: i.id, email: i.email, status: 'pending', label: i.label }));
    state.relatedAccounts = list.filter((i) => (i.status || '') === 'accepted').map((i) => {
      const addr = i.linked_wallet_address ?? i.linkedWalletAddress ?? '';
      return { id: i.id, email: i.email, label: i.label || (i.email || '').split('@')[0], address: (addr && String(addr).trim()) ? String(addr).trim() : undefined };
    });
    var evmList = state.relatedAccounts.map(function (a) { return a.address; }).filter(Boolean);
    if (evmList.length > 0) {
      try {
        var addrResp = await apiFetch(`${API_BASE}/wallet-plan/recipient-addresses?wallets=${encodeURIComponent(evmList.join(','))}`, { headers, cache: 'no-store' });
        if (addrResp.ok) {
          var addrData = await addrResp.json();
          var addrsMap = addrData.addresses || {};
          var norm = function (s) { return (s || '').replace(/^0x/i, '').toLowerCase(); };
          state.relatedAccounts.forEach(function (acc) {
            if (!acc.address) return;
            var key = Object.keys(addrsMap).find(function (k) { return norm(k) === norm(acc.address); });
            if (key && addrsMap[key]) acc.addresses = addrsMap[key];
          });
        }
      } catch (_) { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

/** Load current user's saved multi-chain addresses (GET /api/me/addresses). */
async function loadWalletAddresses() {
  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    if (!headers.Authorization && !headers['X-Client-Session']) return;
    const resp = await apiFetch(`${API_BASE}/me/addresses`, { headers });
    if (resp.status === 401 && wallet) wallet.sessionToken = null;
    if (!resp.ok) return;
    const data = await resp.json();
    state.walletAddresses = data.addresses && typeof data.addresses === 'object' ? data.addresses : null;
    setDefaultWalletSelection();
  } catch { /* non-fatal */ }
}

/** Fetch multi-chain addresses from Yallet extension and write to state + backend (fallback when Wallet page has no addresses). */
async function fetchWalletAddressesFromExtension() {
  if (!wallet || !wallet.connected || wallet.walletType !== 'yallet') return;
  const provider = window.yallet;
  if (!provider) return;
  try {
    const addresses = await (typeof WalletConnector !== 'undefined' && WalletConnector.getYalletAllAddresses
      ? WalletConnector.getYalletAllAddresses(provider)
      : Promise.resolve(null));
    if (!addresses) return;
    state.walletAddresses = addresses;
    setDefaultWalletSelection();
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    await fetch(`${API_BASE}/me/addresses`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ addresses }),
    });
    render();
  } catch (e) {
    console.warn('[Yault] Fetch addresses from Yallet failed:', e.message);
  }
}

/** Set walletSelectedChain / walletSelectedAddress from first non-empty in walletAddresses. */
function setDefaultWalletSelection() {
  const a = state.walletAddresses;
  if (!a) {
    state.walletSelectedChain = 'evm';
    state.walletSelectedAddress = state.auth?.address || '';
    return;
  }
  const order = ['evm', 'bitcoin', 'solana', 'cosmos', 'polkadot'];
  const keyMap = { evm: 'evm_address', bitcoin: 'bitcoin_address', solana: 'solana_address', cosmos: 'cosmos_address', polkadot: 'polkadot_address' };
  for (const chain of order) {
    const addr = a[keyMap[chain]];
    if (addr && String(addr).trim()) {
      state.walletSelectedChain = chain;
      state.walletSelectedAddress = String(addr).trim();
      return;
    }
  }
  state.walletSelectedChain = 'evm';
  state.walletSelectedAddress = state.auth?.address || '';
}

/** Load saved plan from API (scoped to current globalChainKey + globalTokenKey). */
async function loadWalletPlan() {
  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    if (!headers.Authorization && !headers['X-Client-Session']) return;
    const chain = encodeURIComponent(state.globalChainKey || 'ethereum');
    const token = encodeURIComponent(state.globalTokenKey || 'ETH');
    const resp = await apiFetch(`${API_BASE}/wallet-plan?chain=${chain}&token=${token}`, { headers });
    if (resp.status === 401 && wallet) wallet.sessionToken = null;
    if (!resp.ok) return;
    const data = await resp.json();
    state.savedPlan = data.plan && (data.plan.triggerTypes || data.plan.recipients) ? {
      triggerTypes: data.plan.triggerTypes || {},
      recipients: data.plan.recipients || [],
      triggerConfig: data.plan.triggerConfig || {},
      chain_key: data.plan.chain_key || '',
      token_symbol: data.plan.token_symbol || '',
      createdAt: data.plan.createdAt,
    } : null;
  } catch { /* non-fatal */ }
}

/** Compute SHA-256 hash of mnemonic (64-char hex), as agreed with backend: UTF-8(mnemonic.trim()) */
async function hashMnemonic(mnemonic) {
  const s = (mnemonic || '').trim();
  const buf = new TextEncoder().encode(s);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const arr = Array.from(new Uint8Array(hashBuf));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Load user custom tokens for Redeem chain (GET /api/me/tokens?chain=) */
async function loadRedeemUserTokens(chainKey) {
  try {
    const headers = await getAuthHeadersAsync();
    const r = await apiFetch(API_BASE + '/me/tokens?chain=' + encodeURIComponent(chainKey || state.redeemChain), { headers });
    if (r.ok) {
      const d = await r.json();
      state.redeemUserTokens = Array.isArray(d.tokens) ? d.tokens : [];
    } else {
      state.redeemUserTokens = [];
    }
  } catch (_) {
    state.redeemUserTokens = [];
  }
}

/** Load claim/me items (released for current recipient). Called when entering the Claim tab. */
async function loadClaimMe() {
  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    if (!headers.Authorization && !headers['X-Client-Session']) return;
    const resp = await apiFetch(API_BASE + '/claim/me', { headers });
    if (resp.status === 401 && wallet) wallet.sessionToken = null;
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      state.error = data.error || 'Could not load releases.';
      return;
    }
    const data = await resp.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    state.claimMeItems = items;
    state.error = null;
    if (items.length === 1) {
      state.selectedClaimItem = items[0];
      state.walletId = items[0].wallet_id;
      state.pathIndex = items[0].path_index;
      state.releaseKey = items[0].admin_factor_hex || items[0].blob_hex || '';
    } else if (items.length > 1) {
      state.selectedClaimItem = items[0];
      state.walletId = items[0].wallet_id;
      state.pathIndex = items[0].path_index;
      state.releaseKey = items[0].admin_factor_hex || items[0].blob_hex || '';
    } else {
      state.selectedClaimItem = null;
      state.error = 'No released assets for your address. Ensure you are logged in as the designated recipient and the authority has released.';
    }
    // Plan test flow: load AdminFactor-linked rows for this evm_address
    try {
      const planResp = await apiFetch(API_BASE + '/claim/plan-releases', { headers });
      if (planResp.ok) {
        const planData = await planResp.json();
        state.claimPlanReleases = Array.isArray(planData.items) ? planData.items : [];
      } else {
        state.claimPlanReleases = [];
      }
    } catch (_) {
      state.claimPlanReleases = [];
    }
  } catch (err) {
    state.error = err.message || 'Cannot reach server.';
  }
}

// ─── Renderers ───

function renderLogin() {
  return `
    <div style="margin-top:60px;">
      <h1 style="margin-bottom:4px;">Yault</h1>
      <p style="text-align:center;color:var(--text-muted);margin-bottom:32px;font-size:14px;">
        Non-Custodial Asset Release & Vault Platform
      </p>
      ${wallet.renderLoginUI({
        title: T('connectWallet'),
        subtitle: T('signInWithYallet'),
      })}

      <div class="wallet-divider" style="display:flex;align-items:center;gap:12px;margin:28px 0;color:var(--text-muted);font-size:13px;">
        <span style="flex:1;height:1px;background:var(--border);"></span>
        <span>Don't have Yallet yet?</span>
        <span style="flex:1;height:1px;background:var(--border);"></span>
      </div>

      <div style="max-width:420px;margin:0 auto;">
        <button class="btn btn-secondary" style="width:100%;padding:12px 20px;" id="trialApplyBtn">
          Apply for Trial Access
        </button>
      </div>

      <!-- Trial Application Modal -->
      <div id="trialModal" class="hidden">
        <div class="modal-overlay" data-action="close-trial-modal">
          <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
              <h2 style="font-size:18px;">Apply for Trial Access</h2>
              <button class="modal-close" data-action="close-trial-modal">&times;</button>
            </div>
            <p style="color:var(--text-secondary);font-size:14px;margin-bottom:20px;">
              Get early access to Yault's non-custodial asset release platform.
            </p>
            <div class="form-group">
              <label class="form-label">Name</label>
              <input class="form-input" type="text" id="trialName" placeholder="Your full name" />
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <input class="form-input" type="email" id="trialEmail" placeholder="you@example.com" />
            </div>
            <div class="form-group">
              <label class="form-label">Use Case</label>
              <select class="form-input" id="trialUseCase">
                <option value="">Select a use case...</option>
                <option value="personal_release">Personal Release Plan</option>
                <option value="corporate_trust">Corporate Trust</option>
                <option value="escrow">Escrow</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Notes (optional)</label>
              <textarea class="form-input form-textarea" id="trialNotes" placeholder="Tell us about your use case..." rows="3"></textarea>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" data-action="close-trial-modal">Cancel</button>
              <button class="btn btn-primary" id="trialSubmitBtn">Submit Application</button>
            </div>
            <div id="trialFeedback" class="hidden" style="margin-top:12px;"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderNav() {
  var labels = { wallet: T('wallet'), accounts: T('accounts'), protection: T('protection'), claim: T('claim'), profile: T('profile') || 'Profile', settings: T('settings'), activities: 'Activities' };
  const items = PAGES.map((p) => {
    var label = labels[p];
    if (label === p) label = p.charAt(0).toUpperCase() + p.slice(1);
    const pendingBadge = p === 'claim' && state.releases.filter(r => r.status === 'released').length > 0
      ? ` <span class="badge badge-released">${state.releases.filter(r => r.status === 'released').length}</span>`
      : '';
    return `<div class="nav-item ${state.page === p ? 'active' : ''}" data-page="${p}">${label}${pendingBadge}</div>`;
  }).join('');
  return `<div class="nav">${items}</div>`;
}

// ─── Asset Plan (Protection) Page ───

function renderProtection() {
  switch (state.protectionStep) {
    case 'create-plan': return renderCreatePlanWizard();
    case 'search': return renderProtectionSearch();
    case 'configure': return renderProtectionConfigure();
    case 'distribute': return renderProtectionDistribute();
    default: return renderProtectionOverview();
  }
}

function renderProtectionOverview() {
  const hasBound = state.boundFirms.length > 0;

  const chainLabel = (state.globalChainKey || 'ethereum').charAt(0).toUpperCase() + (state.globalChainKey || 'ethereum').slice(1);
  const tokenLabel = state.globalTokenKey || 'ETH';

  return `
    <h2>Asset Plan</h2>

    ${!state.savedPlan ? `
    <div style="text-align:center;padding:48px 24px;">
      <p style="font-size:14px;color:var(--text-muted);margin-bottom:20px;">
        No asset plan has been created for <strong>${esc(chainLabel)} — ${esc(tokenLabel)}</strong> yet.
      </p>
      <button class="btn btn-primary" id="btnCreatePlan">Create Asset Plan</button>
    </div>
    ` : (() => {
      const t = state.savedPlan.triggerTypes;
      let triggerText = '';
      if (t.oracle) triggerText = 'Oracle Trigger (Chainlink Oracle)' + (t.oracle_with_legal_fallback ? '; Legal Authority as fallback' : '');
      else if (t.legal_authority) triggerText = 'Legal Authority Trigger';
      else if (t.inactivity) triggerText = 'Inactivity: ' + (state.savedPlan.triggerConfig.inactivityMonths === 6 ? '6 months' : state.savedPlan.triggerConfig.inactivityMonths === 12 ? '1 year' : state.savedPlan.triggerConfig.inactivityMonths === 24 ? '2 years' : state.savedPlan.triggerConfig.inactivityMonths === 36 ? '3 years' : state.savedPlan.triggerConfig.inactivityMonths === 60 ? '5 years' : state.savedPlan.triggerConfig.inactivityMonths + ' months');
      else triggerText = '—';
      const planChain = state.savedPlan.chain_key ? (state.savedPlan.chain_key.charAt(0).toUpperCase() + state.savedPlan.chain_key.slice(1)) : chainLabel;
      const planToken = state.savedPlan.token_symbol || tokenLabel;
      return `
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
        Manage the release plan for <strong>${esc(planChain)} — ${esc(planToken)}</strong>.
      </p>
      <button class="btn btn-primary" id="btnCreatePlan" style="margin-bottom:20px;">Modify Plan</button>
      <button class="btn btn-secondary btn-sm" id="btnSimulateChainlinkOverview" style="margin-left:12px;margin-bottom:20px;vertical-align:middle;">Simulate Chainlink Event</button>
      <span id="chainlinkOverviewHint" style="display:none;font-size:12px;color:var(--text-muted);margin-left:10px;vertical-align:middle;"></span>
      <div class="card">
        <h3>Current Plan <span style="font-size:12px;color:var(--text-muted);font-weight:400;">[${esc(planChain)} — ${esc(planToken)}]</span></h3>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${triggerText}</p>
        <h4 style="margin-top:12px;">Recipients</h4>
        ${(state.savedPlan.recipients || []).map(r => `
          <div style="padding:4px 0;">${esc(r.label || r.name || '')} — ${r.percentage}%</div>
        `).join('')}
        ${(state.savedPlan.triggerConfig.legalAuthority?.selectedFirms || []).length > 0 ? `
          <h4 style="margin-top:12px;">Authorities</h4>
          ${state.savedPlan.triggerConfig.legalAuthority.selectedFirms.map(f => `<div style="padding:4px 0;">${esc(f.name)}</div>`).join('')}
        ` : ''}
      </div>
    `;
    })()}

    ${hasBound ? `
      <div class="card">
        <h3>Existing Plans / Bound Authorities</h3>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          These authorities hold the authorization factor. No single authority can access your assets alone.
        </p>
        ${state.boundFirms.map((f, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;${i < state.boundFirms.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
            <div>
              <div style="font-weight:600;">${esc(f.name)}${f.verified ? ' <span style="color:var(--success);">&#10003;</span>' : ''}</div>
              <div style="font-size:12px;color:var(--text-muted);">${esc(f.jurisdiction || '')}</div>
            </div>
            <span class="badge badge-active">Bound</span>
          </div>
        `).join('')}
        <button type="button" class="btn btn-secondary btn-sm" id="btnRefreshBoundFirms" style="margin-top:12px;">Refresh</button>
      </div>
    ` : ''}

    ${state.distributionResult ? `
      <div class="card" style="margin-top:16px;">
        <h3>Last distribution</h3>
        ${(state.distributionResult.shares || []).map(s => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;">
            <span>${esc(s.firmName || s.authorityId)}</span>
            <span class="badge ${s.delivered ? 'badge-active' : 'badge-pending'}">${s.delivered ? 'Delivered' : 'Failed'}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

  `;
}

function renderProtectionSearch() {
  return `
    <h2>Find Authorities</h2>
    <button class="btn btn-secondary" id="btnBackToProtection" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>

    <div class="card">
      <div class="form-group">
        <label class="form-label">Region</label>
        <select class="form-input" id="firmSearchRegion">
          <option value="">All Regions</option>
          <option value="US">United States</option>
          <option value="UK">United Kingdom</option>
          <option value="EU">European Union</option>
          <option value="SG">Singapore</option>
          <option value="HK">Hong Kong</option>
          <option value="JP">Japan</option>
          <option value="CH">Switzerland</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Language</label>
        <select class="form-input" id="firmSearchLang">
          <option value="">Any</option>
          <option value="en">English</option>
          <option value="zh">Chinese</option>
          <option value="ja">Japanese</option>
          <option value="de">German</option>
        </select>
      </div>
      <button class="btn btn-primary" id="btnDoFirmSearch" ${state.loading ? 'disabled' : ''}>
        ${state.loading ? 'Searching...' : 'Search'}
      </button>
    </div>

    ${state.firmSearchResults.length > 0 ? `
      <h3 style="margin-top:16px;">Results (${state.firmSearchResults.length})</h3>
      ${state.firmSearchResults.map((f, i) => {
        const alreadySelected = state.selectedFirms.some(s => s.id === f.id);
        return `
          <div class="card" style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:600;">${esc(f.name)}${f.verified ? ' <span style="color:var(--success);">&#10003;</span>' : ''}</div>
              <div style="font-size:12px;color:var(--text-muted);">
                ${esc(f.jurisdiction || f.region || '')}
                ${f.active_bindings != null ? ' &bull; ' + f.active_bindings + '/' + (f.max_capacity || 100) + ' clients' : ''}
              </div>
            </div>
            <button class="btn ${alreadySelected ? 'btn-secondary' : 'btn-primary'}" style="width:auto;padding:8px 14px;font-size:13px;"
              ${alreadySelected ? 'disabled' : ''}
              data-action="select-firm" data-firm-index="${i}">
              ${alreadySelected ? 'Selected' : 'Select'}
            </button>
          </div>
        `;
      }).join('')}
    ` : ''}
  `;
}

function renderProtectionConfigure() {
  const n = state.selectedFirms.length;
  const fromPlan = state.planRecipients && state.planRecipients.length > 0;
  const planSummary = state.planForConfigure
    ? `Trigger: ${state.planForConfigure.triggerType}${state.planForConfigure.tlockMonths ? '; Inactivity: ' + state.planForConfigure.tlockMonths + ' months' : ''}`
    : '';

  return `
    <h2>Configure protection</h2>
    <button class="btn btn-secondary" id="btnBackToProtection" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>

    ${fromPlan ? `
      <div class="card">
        <h3>Plan summary</h3>
        <p style="font-size:12px;color:var(--text-muted);">${esc(planSummary)}</p>
        <h4 style="margin-top:10px;">Recipients</h4>
        ${state.planRecipients.map((r, i) => `
          <div style="padding:4px 0;">${esc(r.label || r.name || '')} — ${r.percentage}%</div>
        `).join('')}
      </div>
    ` : ''}

    <div class="card">
      <h3>Selected Authorities (${n})</h3>
      ${state.selectedFirms.map((f, i) => `
        <div style="padding:6px 0;${i < n - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <span style="font-weight:600;">${i + 1}. ${esc(f.name)}</span>
          <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">${esc(f.jurisdiction || '')}</span>
        </div>
      `).join('')}
    </div>

    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      An authorization factor will be generated automatically and shared only with your selected authorities. You will not see or store it.
    </p>

    <button class="btn btn-success" id="btnDistribute" ${state.loading ? 'disabled' : ''}>
      ${state.loading ? 'Distributing...' : 'Split & Distribute to ' + n + ' Firms'}
    </button>
  `;
}

function renderProtectionDistribute() {
  const r = state.distributionResult;
  if (!r) return '';

  return `
    <h2>Distribution Complete</h2>

    <div class="alert alert-success">
      Protection is set up. An authorization factor has been generated and sent only to your selected ${r.totalShares} authority(ies). Only they hold it; you do not have access to it.
    </div>

    <div class="card">
      <h3>Delivery status</h3>
      ${(r.shares || []).map((s, i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;${i < (r.shares || []).length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="font-weight:500;">${esc(s.firmName || s.authorityId)}</div>
          <span class="badge ${s.delivered ? 'badge-active' : 'badge-pending'}">
            ${s.delivered ? 'Delivered' : 'Failed — retry needed'}
          </span>
        </div>
      `).join('')}
    </div>

    <button class="btn btn-primary" id="btnBackToProtection" style="margin-top:8px;">
      ${T('backToAssetPlan')}
    </button>
  `;
}

// ─── Create Plan Wizard ───

const INACTIVITY_OPTIONS = [
  { value: 6, label: '6 months' },
  { value: 12, label: '1 year' },
  { value: 24, label: '2 years' },
  { value: 36, label: '3 years' },
  { value: 60, label: '5 years' },
];

function renderCreatePlanWizard() {
  switch (state.planStep) {
    case 'triggers': return renderPlanStepTriggers();
    case 'recipients': return renderPlanStepRecipients();
    case 'trigger-config': return renderPlanStepTriggerConfig();
    case 'review': return renderPlanStepReview();
    case 'credentials': return renderPlanStepCredentials();
    default: return renderPlanStepTriggers();
  }
}

function renderPlanStepTriggers() {
  const t = state.planTriggerTypes;
  const planType = state.planType || '';
  const mainChoice = t.oracle ? 'oracle' : (t.legal_authority ? 'legal_authority' : (t.inactivity ? 'inactivity' : ''));
  return `
    <h2>Create Plan — Step 1: Plan Type & Trigger</h2>
    <button class="btn btn-secondary" id="btnPlanWizardBack" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>
    <div class="card" style="margin-bottom:20px;">
      <h3 style="font-size:15px;margin-bottom:10px;">Plan Type</h3>
      <div class="form-group">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:8px 0;">
          <input type="radio" name="planType" value="wallet" id="planTypeWallet" ${planType === 'wallet' ? 'checked' : ''} style="margin-top:3px;" />
          <span>
            <strong>Wallet Plan</strong><br/>
            <span style="font-size:12px;color:var(--text-muted);">Allocates assets in your personal wallet; after trigger the recipient gains wallet access. Assets stay in your wallet and can be operated anytime; no yield. One recipient only.</span>
          </span>
        </label>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:8px 0;">
          <input type="radio" name="planType" value="yield_pool" id="planTypeYieldPool" ${planType === 'yield_pool' ? 'checked' : ''} style="margin-top:3px;" />
          <span>
            <strong>Yielding Vault Plan</strong><br/>
            <span style="font-size:12px;color:var(--text-muted);">Allocates your share in the yielding pool (Vault); after trigger, shares are released to recipients by ratio. Supports multiple recipients and allocation ratios; supports yield. You must have assets in Vault first; the next step will verify pool balance.</span>
          </span>
        </label>
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:10px;">Trigger Type</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">Choose one trigger type. When the condition is met, release can be initiated.</p>
      <div class="form-group">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:8px 0;">
          <input type="radio" name="planTriggerMain" value="oracle" id="planTriggerOracle" ${mainChoice === 'oracle' ? 'checked' : ''} style="margin-top:3px;" />
          <span>
            <strong>Oracle Trigger</strong> — Chain/oracle attestation (e.g. court record). <span style="font-size:12px;color:var(--text-muted);">Provider: Chainlink Oracle.</span>
            <div style="margin-top:8px;margin-left:24px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="planTriggerOracleLegalFallback" ${t.oracle_with_legal_fallback ? 'checked' : ''} />
                <span>Legal Authority Trigger as fallback</span>
              </label>
            </div>
          </span>
        </label>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 0;">
          <input type="radio" name="planTriggerMain" value="legal_authority" id="planTriggerLegal" ${mainChoice === 'legal_authority' ? 'checked' : ''} style="margin-top:0;" />
          <span><strong>Legal Authority Trigger</strong> — Law firm or notary verifies and initiates release</span>
        </label>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 0;">
          <input type="radio" name="planTriggerMain" value="inactivity" id="planTriggerInactivity" ${mainChoice === 'inactivity' ? 'checked' : ''} style="margin-top:0;" />
          <span><strong>Inactivity Detection Trigger</strong> — No activity for a period, then release can be initiated</span>
        </label>
      </div>
    </div>
    <button class="btn btn-primary" id="btnPlanStepNext" style="margin-top:16px;">Next: Set Recipients & Ratio</button>
  `;
}

function renderPlanStepRecipients() {
  const related = state.relatedAccounts || [];
  const list = state.planRecipients;
  const totalPct = list.reduce((s, r) => s + (Number(r.percentage) || 0), 0);
  const planType = state.planType || 'wallet';
  const isWalletPlan = planType === 'wallet';
  const vb = state.vaultBalanceForPlan;
  const vaultValue = vb && vb.value != null ? parseFloat(vb.value) : null;
  const hasVaultBalance = vaultValue != null && vaultValue > 0;

  if (related.length === 0) {
    return `
    <h2>Create Plan — Step 2: Designated Recipients</h2>
    <button class="btn btn-secondary" id="btnPlanWizardBack" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>
    <div class="card">
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">Add related accounts in the Accounts page first (e.g. invite family); they must have Yallet and be registered on Yault.</p>
      <p style="font-size:12px;color:var(--danger);">No related accounts yet; you cannot select recipients.</p>
    </div>
    `;
  }
  const key = (acc) => (acc.address || acc.email || acc.id || '').toString();
  const selectedWalletRecipientKey = isWalletPlan && list.length === 1 ? key(list[0]) : '';
  const yieldPoolBalanceBlock = planType === 'yield_pool' ? `
    <div class="card" style="margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Vault allocatable balance</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">Yielding Vault Plan allocates your pool share by ratio; supports multiple recipients and allocation ratios, and yield. Ensure you have assets in the pool first.</p>
      <button type="button" class="btn btn-secondary" id="btnPlanLoadVaultBalance" style="margin-bottom:10px;">Check pool balance</button>
      <div id="planVaultBalanceResult">
        ${vb === null ? '<span style="font-size:13px;color:var(--text-muted);">Click above to check</span>' : (hasVaultBalance ? `<p style="font-size:14px;margin:0;"><strong>Allocatable:</strong> ${esc(String(vb.value))} ${esc(vb.underlying_symbol || 'Vault shares')}</p><p style="font-size:12px;color:var(--text-muted);margin-top:4px;">Redeemable balance (after yield). You can set recipient ratios and proceed to next step.</p>` : '<p style="font-size:13px;color:var(--danger);margin:0;">Balance is 0. Please go to <strong>Wallet → Vault</strong> to deposit.</p>')}
      </div>
    </div>
  ` : '';
  const walletPlanUi = isWalletPlan ? `
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;"><strong>Wallet Plan:</strong> Assets stay in your personal wallet and can be operated anytime; no yield. One recipient only — select one below; share is 100%.</p>
    <div class="form-group">
      <label class="form-label">Recipient</label>
      <select class="form-input" id="planWalletRecipientSelect" style="max-width:360px;">
        <option value="">— Select one recipient —</option>
        ${related.map((acc, idx) => {
          const planKey = key(acc) || 'idx-' + idx;
          const selected = selectedWalletRecipientKey && (planKey === selectedWalletRecipientKey || (list[0] && key(list[0]) === planKey));
          const addrNote = acc.address && String(acc.address).trim() ? ' (' + shortEvm(acc.address) + ')' : ' (no wallet)';
          return `<option value="${esc(planKey)}" ${selected ? 'selected' : ''}>${esc(acc.label || acc.email || '')}${addrNote}</option>`;
        }).join('')}
      </select>
    </div>
    <p style="font-size:13px;color:var(--text-muted);margin-top:8px;">Share: <strong>100%</strong></p>
  ` : '';
  const yieldPoolRecipientsUi = !isWalletPlan ? `
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">Select recipients from the list below and set each share (total 100%). Accounts must have Yallet and be registered on Yault.</p>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;"><strong>Yielding Vault Plan:</strong> Supports multiple recipients and allocation ratios; supports yield.</p>
    <div id="planRecipientsList">
      ${related.map((acc, idx) => {
        const planKey = key(acc) || 'idx-' + idx;
        const pct = list.find((r) => key(r) === key(acc))?.percentage ?? '';
        const addrSpan = acc.address && String(acc.address).trim() ? ' <span class="mono" style="font-size:11px;color:var(--text-muted);">' + esc(shortEvm(acc.address)) + '</span>' : ' <span style="font-size:11px;color:var(--danger);">(no wallet)</span>';
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
          <span style="flex:1;">${esc(acc.label || acc.email || '')}${addrSpan}</span>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
            <span>Share (%)</span>
            <input type="number" class="form-input" name="planPct" data-plan-key="${esc(planKey)}" data-plan-idx="${idx}" min="0" max="100" placeholder="0" value="${pct !== '' ? esc(String(pct)) : ''}" style="width:80px;" />
          </label>
        </div>`;
      }).join('')}
    </div>
    <p style="font-size:12px;margin-top:12px;">Total: <span id="planRecipientsTotal">${totalPct}</span>%<span id="planRecipientsTotalWarn" style="color:var(--danger);${totalPct === 100 ? 'display:none;' : ''}"> (must be 100%)</span></p>
  ` : '';
  return `
    <h2>Create Plan — Step 2: Designated Recipients</h2>
    <button class="btn btn-secondary" id="btnPlanWizardBack" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>
    ${yieldPoolBalanceBlock}
    <div class="card">
      ${isWalletPlan ? walletPlanUi : yieldPoolRecipientsUi}
    </div>
    <button class="btn btn-primary" id="btnPlanStepNext" style="margin-top:12px;">Next: Trigger Configuration</button>
  `;
}

function renderPlanStepTriggerConfig() {
  const t = state.planTriggerTypes;
  const leg = state.planTriggerConfig.legalAuthority;
  const firms = leg.firmSearchResults || [];
  const selected = leg.selectedFirms || [];
  let html = `
    <h2>Create Plan — Step 3: Trigger Configuration</h2>
    <button class="btn btn-secondary" id="btnPlanWizardBack" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>
  `;
  if (t.oracle) {
    html += `
      <div class="card">
        <h3>Oracle Trigger</h3>
        <p style="font-size:12px;color:var(--text-muted);">Provider: <strong>Chainlink Oracle</strong>. Attestation (e.g. CRE, death registry) is configured at platform level.</p>
      </div>
    `;
  }
  const needAuthorities = t.legal_authority || (t.oracle && t.oracle_with_legal_fallback);
  const singleAuthorityOnly = needAuthorities;
  if (needAuthorities) {
    if (singleAuthorityOnly && selected.length > 1) {
      state.planTriggerConfig.legalAuthority.selectedFirms = selected.slice(0, 1);
    }
    const selectedNorm = state.planTriggerConfig.legalAuthority.selectedFirms || [];
    const searchDisabled = selectedNorm.length >= 1;
    html += `
      <div class="card">
        <h3>${t.legal_authority ? 'Legal Authority' : 'Authorities'}</h3>
        <p style="font-size:12px;color:var(--text-muted);">${t('firmSelectHint')}</p>
        <div class="form-group">
          <label class="form-label">Jurisdiction</label>
          <select class="form-input" id="planLegalJurisdiction">
            <option value="">Select jurisdiction</option>
            <option value="US" ${leg.jurisdiction === 'US' ? 'selected' : ''}>United States</option>
            <option value="UK" ${leg.jurisdiction === 'UK' ? 'selected' : ''}>United Kingdom</option>
            <option value="EU" ${leg.jurisdiction === 'EU' ? 'selected' : ''}>European Union</option>
            <option value="SG" ${leg.jurisdiction === 'SG' ? 'selected' : ''}>Singapore</option>
            <option value="HK" ${leg.jurisdiction === 'HK' ? 'selected' : ''}>Hong Kong</option>
            <option value="JP" ${leg.jurisdiction === 'JP' ? 'selected' : ''}>Japan</option>
            <option value="CH" ${leg.jurisdiction === 'CH' ? 'selected' : ''}>Switzerland</option>
          </select>
        </div>
        <button class="btn btn-secondary" id="btnPlanSearchFirms" ${state.loading || searchDisabled ? 'disabled' : ''}>Search Law Firms</button>
        ${searchDisabled ? `<p style="font-size:12px;color:var(--text-muted);margin-top:8px;">${t('firmAlreadySelected')}</p>` : ''}
        ${selectedNorm.length > 0 ? `
          <h4 style="margin-top:14px;">Selected (${selectedNorm.length})</h4>
          ${selectedNorm.map((f, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;">
              <span>${esc(f.name)}</span>
              <button type="button" class="btn btn-secondary" style="width:auto;padding:4px 8px;font-size:12px;" data-action="remove-plan-firm" data-firm-index="${i}">Remove</button>
            </div>
          `).join('')}
        ` : ''}
        ${firms.length > 0 ? `
          <h4 style="margin-top:14px;">Search Results</h4>
          ${firms.map((f, i) => {
            const already = selectedNorm.some(s => s.id === f.id);
            const disableSelect = selectedNorm.length >= 1 && !already;
            return `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;">
                <span>${esc(f.name)} ${f.verified ? ' &#10003;' : ''}</span>
                <button type="button" class="btn ${already || disableSelect ? 'btn-secondary' : 'btn-primary'}" style="width:auto;padding:4px 10px;font-size:12px;" data-action="select-plan-firm" data-firm-index="${i}" ${already || disableSelect ? 'disabled' : ''}>${already ? 'Selected' : disableSelect ? 'Already selected one' : 'Select'}</button>
              </div>
            `;
          }).join('')}
        ` : ''}
      </div>
    `;
  }
  if (t.inactivity) {
    const months = state.planTriggerConfig.inactivityMonths || 12;
    html += `
      <div class="card">
        <h3>Inactivity Detection</h3>
        <p style="font-size:12px;color:var(--text-muted);">If no activity for the selected period, release can be initiated.</p>
        <div class="form-group">
          <label class="form-label">Time period</label>
          <select class="form-input" id="planInactivityMonths">
            ${INACTIVITY_OPTIONS.map(o => `<option value="${o.value}" ${o.value === months ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
  }
  if (!t.oracle && !t.legal_authority && !t.inactivity) {
    html += `<div class="alert alert-warning">Select at least one trigger type in Step 1.</div>`;
  } else {
    const needAuthForNext = t.legal_authority || (t.oracle && t.oracle_with_legal_fallback);
    const selectedCount = (state.planTriggerConfig.legalAuthority.selectedFirms || []).length;
    html += needAuthForNext && selectedCount < 1
      ? `<p style="font-size:13px;color:var(--warning);margin-top:12px;">${t('firmRequiredWarning')}</p><button class="btn btn-primary" id="btnPlanStepNext" style="margin-top:12px;" disabled>Next: Review Plan</button>`
      : `<button class="btn btn-primary" id="btnPlanStepNext" style="margin-top:12px;">Next: Review Plan</button>`;
  }
  return html;
}

function renderPlanStepReview() {
  const t = state.planTriggerTypes;
  const recipients = state.planRecipients;
  const leg = state.planTriggerConfig.legalAuthority;
  const totalPct = recipients.reduce((s, r) => s + (Number(r.percentage) || 0), 0);
  const planTypeLabel = state.planType === 'yield_pool' ? 'Yielding Vault Plan' : 'Wallet Plan';
  let triggerSummary = '';
  if (t.oracle) triggerSummary = 'Oracle Trigger (Chainlink Oracle)' + (t.oracle_with_legal_fallback ? '; Legal Authority as fallback' : '');
  else if (t.legal_authority) triggerSummary = 'Legal Authority';
  else if (t.inactivity) triggerSummary = 'Inactivity: ' + (INACTIVITY_OPTIONS.find(o => o.value === state.planTriggerConfig.inactivityMonths)?.label || state.planTriggerConfig.inactivityMonths + ' months');
  else triggerSummary = 'None';
  const needAuthoritiesForReview = t.legal_authority || (t.oracle && t.oracle_with_legal_fallback);
  const firmsOk = !needAuthoritiesForReview || (leg.selectedFirms || []).length >= 1;

  return `
    <h2>Create Plan — Review & Submit</h2>
    <button class="btn btn-secondary" id="btnPlanWizardBack" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>
    ${!firmsOk ? `<div class="alert alert-warning" style="margin-bottom:16px;">${t('firmRequiredReview')}</div>` : ''}
    <div class="card">
      <h3>Plan type</h3>
      <p>${esc(planTypeLabel)}</p>
      <h3 style="margin-top:14px;">Trigger type</h3>
      <p>${triggerSummary}</p>
      <h3 style="margin-top:14px;">Recipients</h3>
      ${recipients.map(r => `<div>${esc(r.label || r.name || '')} — ${r.percentage}%</div>`).join('')}
      <p style="font-size:12px;margin-top:6px;">Total: ${totalPct}%</p>
      ${needAuthoritiesForReview && (leg.selectedFirms || []).length > 0 ? `
        <h3 style="margin-top:14px;">Authority</h3>
        ${(leg.selectedFirms || []).map(f => `<div>${esc(f.name)}</div>`).join('')}
      ` : ''}
    </div>
    <div class="card">
      <label for="planMemoTextarea" style="display:block;margin-bottom:8px;font-weight:600;">Memo: </label>
      <textarea id="planMemoTextarea" rows="4" placeholder="e.g. Instructions, wishes, or a personal note for the recipient…" style="width:100%;max-width:560px;padding:10px;font-size:14px;border:1px solid var(--border);border-radius:8px;resize:vertical;" maxlength="10000">${esc(state.planMemo || '')}</textarea>
      <p style="font-size:11px;color:var(--text-muted);margin-top:4px;">Max 10,000 characters. Stored encrypted; recipient(s) can read it after release.</p>
    </div>
    <div class="card">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 0;">
        <input type="checkbox" id="planReviewedCheckbox" ${state.planReviewed ? 'checked' : ''} />
        <span>I have reviewed this plan and confirm the trigger types, recipients, and percentages are correct.</span>
      </label>
    </div>
    <button class="btn btn-success" id="btnPlanSubmit" ${!state.planReviewed || totalPct !== 100 || !firmsOk ? 'disabled' : ''}>
      Submit & Create Plan
    </button>
    ${state.planSubmitConfirmModal ? `
    <div id="planSubmitConfirmModal" class="modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;">
      <div class="card" style="max-width:460px;margin:16px;min-width:340px;" onclick="event.stopPropagation()">
        <div id="signModalInitial">
          <h3 style="margin:0 0 12px;">Credential Signing</h3>
          <p style="margin:0 0 8px;font-size:14px;color:var(--text-muted);">
            You will need to approve <strong>${recipients.length}</strong> signature(s) via passkey — one for each recipient.
          </p>
          <div style="margin:0 0 16px;font-size:13px;color:var(--text-muted);">
            ${recipients.map((r, i) => `<div style="padding:3px 0;">${i + 1}. ${esc(r.label || r.name || 'Recipient ' + (i + 1))} — ${r.percentage}%</div>`).join('')}
          </div>
          <button type="button" class="btn btn-primary" id="btnPlanSubmitConfirmGo">Continue</button>
        </div>
        <div id="signModalProgress" style="display:none;">
          <h3 style="margin:0 0 12px;">Signing in progress...</h3>
          <div id="signProgressList" style="margin:0 0 16px;font-size:14px;"></div>
          <p id="signProgressHint" style="margin:0;font-size:12px;color:var(--text-muted);">Please approve the passkey prompt when it appears.</p>
        </div>
        <div id="signModalDone" style="display:none;">
          <h3 style="margin:0 0 8px;color:var(--success);">All signatures complete!</h3>
          <div id="signDoneList" style="margin:0 0 16px;font-size:14px;"></div>
          <p style="margin:0 0 16px;font-size:13px;color:var(--text-muted);">Encrypted credentials will be stored securely. Recipients will only receive them when the trigger fires.</p>
          <button type="button" class="btn btn-primary" id="btnSignModalClose">Done</button>
        </div>
      </div>
    </div>
    ` : ''}
  `;
}

function renderPlanStepCredentials() {
  const list = state.credentialMintResults || [];
  return `
    <h2>Path credentials generated</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      Mnemonic + passphrase generated for each recipient. Credentials are minted as encrypted cNFT to the recipient's Solana address when RWA SDK is available.
    </p>
    ${list.map((item, i) => {
      const r = item.recipient || {};
      const label = r.label || r.name || 'Recipient ' + (i + 1);
      const ok = item.success;
      const statusText = ok ? (item.mintTxId ? 'Minted' : (item.mintSkipped === 'no_solana_address' ? 'Generated (no Solana address)' : (item.mintSkipped === 'no_rwa_sdk' ? 'Generated (RWA SDK not loaded)' : 'OK'))) : 'Failed';
      const statusClass = ok ? (item.mintTxId ? 'badge-success' : 'badge-muted') : 'badge-danger';
      return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span>${esc(label)}</span>
          <span class="badge ${statusClass}">${esc(statusText)}</span>
        </div>
        ${item.mintTxId ? '<p style="font-size:12px;color:var(--text-muted);margin-top:8px;">Tx: ' + esc(String(item.mintTxId).slice(0, 20)) + '…</p>' : ''}
        ${!ok && item.error ? '<p style="font-size:12px;color:var(--danger);margin-top:8px;">' + esc(item.error) + '</p>' : ''}
      </div>`;
    }).join('')}
    <button class="btn btn-primary" id="btnPlanCredentialsDone">Done</button>
    <button class="btn btn-secondary btn-sm" id="btnSimulateChainlink" style="margin-left:12px;vertical-align:middle;">Simulate Chainlink Event</button>
    <span id="chainlinkEventHint" style="display:none;font-size:12px;color:var(--text-muted);margin-left:10px;vertical-align:middle;"></span>
  `;
}

// ─── Wallet Page ───

/** Collapsed connection status in top-right: short address for current context chain + refresh button */
function renderWalletHeaderCompact() {
  const addr = getGlobalContextAddress();
  const shortAddr = addr.length > 16 ? addr.substring(0, 8) + '…' + addr.slice(-4) : addr;
  return `
    <div style="display:flex;align-items:center;gap:8px;" title="Context: ${esc(state.globalChainKey || 'ethereum')} / ${esc(state.globalTokenKey || 'ETH')}&#10;${esc(addr)}">
      <span style="font-size:12px;color:var(--text-muted);font-family:monospace;">${esc(shortAddr)}</span>
      <button class="btn btn-secondary" id="btnRefreshBalances" style="width:auto;padding:4px 10px;font-size:12px;" title="Refresh balances">&#8635;</button>
    </div>
  `;
}

function renderDeniableAccounts() {
  const shortAddr = (a) => a ? a.substring(0, 8) + '...' + a.substring(a.length - 4) : '';

  return `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <h3 style="margin:0;">Deniable Accounts</h3>
        <button class="btn btn-primary" id="btnToggleAddDeniable"
          style="width:auto;padding:6px 14px;font-size:13px;">
          ${state.showAddDeniable ? 'Cancel' : '+ Add Account'}
        </button>
      </div>
      <div class="alert alert-warning" style="padding:8px 12px;font-size:12px;margin-bottom:12px;">
        Session only &mdash; these accounts disappear on logout or page refresh.
        Each context produces completely independent addresses via HKDF isolation.
      </div>

      ${state.showAddDeniable ? `
        <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:12px;background:var(--bg-card);">
          <div class="form-group" style="margin-bottom:8px;">
            <label class="form-label">Context</label>
            <input class="form-input" type="text" id="newDeniableContextInput"
              placeholder="entity:domain:index  (e.g. corp-abc:OperatingFund:0)"
              value="${esc(state.newDeniableContext)}" />
            <div class="form-hint">Deterministic: same context = same 7 addresses. Different context = completely different.</div>
          </div>
          <div class="form-group" style="margin-bottom:8px;">
            <label class="form-label">Label (optional)</label>
            <input class="form-input" type="text" id="newDeniableLabelInput"
              placeholder="Human-readable name for this account"
              value="${esc(state.newDeniableLabel)}" />
          </div>
          <button class="btn btn-success" id="btnDeriveDeniable" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Deriving via Yallet...' : 'Derive via Yallet'}
          </button>
        </div>
      ` : ''}

      ${state.deniableAccounts.length > 0 ? `
        ${state.deniableAccounts.map((acct, i) => `
          <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <div>
                <div style="font-weight:600;font-size:14px;">${esc(acct.label || acct.context)}</div>
                ${acct.label ? `<div style="font-size:11px;color:var(--text-muted);font-family:monospace;">${esc(acct.context)}</div>` : ''}
              </div>
              <button class="btn btn-secondary" style="width:auto;padding:4px 10px;font-size:12px;"
                data-action="remove-deniable" data-deniable-index="${i}">&times;</button>
            </div>
            <div style="font-size:12px;line-height:1.8;">
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">EVM</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.evm_address))}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">Solana</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.solana_address))}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">Bitcoin</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.bitcoin_address))}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">Cosmos</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.cosmos_address))}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">Polkadot</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.polkadot_address))}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">X25519</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.xaddress))}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:var(--text-muted);">ML-DSA</span>
                <span style="font-family:monospace;">${esc(shortAddr(acct.addresses?.xidentity))}</span>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;">
              <button class="btn btn-secondary" style="flex:1;padding:6px 0;font-size:12px;"
                data-action="query-deniable-balance" data-deniable-index="${i}">Query Balance</button>
              <button class="btn btn-primary" style="flex:1;padding:6px 0;font-size:12px;"
                data-action="send-from-deniable" data-deniable-index="${i}">Transfer</button>
            </div>
            ${acct.balances ? `
              <div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">
                Balance: ${esc(acct.balances.eth || '0')} ETH
              </div>
            ` : ''}
          </div>
        `).join('')}
      ` : `
        <div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px;">
          No deniable accounts yet. Click "+ Add Account" to derive one.
        </div>
      `}
    </div>
  `;
}

// Left sidebar menu keys for Wallet page
const WALLET_SECTIONS = [
  { key: 'balances', label: 'Balances' },
  { key: 'send', label: 'Transfer' },
  { key: 'vault', label: 'Vault' },
  { key: 'deniable', label: 'Deniable Accounts' },
];

const WALLET_CHAIN_OPTIONS = [
  { key: 'evm', label: 'EVM (Ethereum / BSC / Polygon …)', addrKey: 'evm_address' },
  { key: 'bitcoin', label: 'Bitcoin', addrKey: 'bitcoin_address' },
  { key: 'solana', label: 'Solana', addrKey: 'solana_address' },
  { key: 'cosmos', label: 'Cosmos', addrKey: 'cosmos_address' },
  { key: 'polkadot', label: 'Polkadot', addrKey: 'polkadot_address' },
];

function renderWalletAddressSelector() {
  const a = state.walletAddresses;
  const options = a ? WALLET_CHAIN_OPTIONS.filter((o) => a[o.addrKey] && String(a[o.addrKey]).trim()).map((o) => ({
    key: o.key,
    label: o.label,
    address: String(a[o.addrKey]).trim(),
  })) : [];
  if (options.length === 0) return '';
  const selected = options.find((o) => o.key === state.walletSelectedChain) || options[0];
  const displayAddr = state.walletSelectedAddress || selected?.address || '';
  const shortAddr = (s) => (s && s.length > 20 ? s.substring(0, 10) + '…' + s.slice(-8) : s || '');
  return `
    <div class="card">
      <h3 style="margin-top:0;">${t('selectChainAddress')}</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${t('selectChainDesc')}</p>
      <div class="form-group">
        <label class="form-label">${t('currentAddress')}</label>
        <select class="form-input" id="walletAddressChainSelect">
          ${options.map((o) => `<option value="${o.key}" ${o.key === state.walletSelectedChain ? 'selected' : ''}>${esc(o.label)} — ${esc(shortAddr(o.address))}</option>`).join('')}
        </select>
      </div>
      <div style="margin-top:12px;padding:10px;background:var(--bg);border-radius:var(--radius);font-size:13px;">
        <div style="color:var(--text-muted);margin-bottom:4px;">${t('currentAddress')}</div>
        <div style="font-family:monospace;word-break:break-all;">${esc(displayAddr)}</div>
      </div>
      <div style="margin-top:12px;padding:10px;background:var(--bg);border-radius:var(--radius);">
        <div style="color:var(--text-muted);margin-bottom:4px;">${t('chainAssets')} ${esc(formatChainToken())}</div>
        <div style="font-size:18px;font-weight:600;">${esc(getGlobalContextBalance())}</div>
      </div>
    </div>
  `;
}

/** Current address and balance from global context (header Chain + Token). */
function getGlobalContextAddress() {
  const a = state.walletAddresses;
  const k = state.globalChainKey;
  if (k === 'ethereum') return a?.evm_address || state.auth?.address || '';
  if (k === 'solana') return a?.solana_address || '';
  if (k === 'bitcoin') return a?.bitcoin_address || '';
  return a?.evm_address || state.auth?.address || '';
}

/** Balance for current global token on current chain (native + USDC from API). */
function getGlobalContextBalance() {
  const b = state.walletBalances;
  const tok = state.globalTokenKey;
  if (tok === 'ETH') return b?.eth ?? '0.00';
  if (tok === 'SOL') return b?.sol ?? '0.00';
  if (tok === 'BTC') return b?.btc ?? '0.00';
  if (tok === 'USDC') return (state.walletBalancesUsdc && state.walletBalancesUsdc[state.globalChainKey]) ?? '0.00';
  if (tok === 'WETH') return (state.walletBalancesWeth && state.walletBalancesWeth[state.globalChainKey]) ?? '0.00';
  return '0.00';
}

/** Display string for current chain + token, e.g. "[Ethereum - USDC]". */
function formatChainToken() {
  const chainLabel = state.globalChainKey === 'ethereum' ? 'Ethereum' : state.globalChainKey === 'solana' ? 'Solana' : 'Bitcoin';
  const token = state.globalTokenKey || 'ETH';
  return '[' + chainLabel + ' - ' + token + ']';
}

/** Balances section: driven by header Chain + Token context (no separate chain/address selector card). */
function renderWalletBalancesSection() {
  const addr = getGlobalContextAddress();
  const balance = getGlobalContextBalance();
  const addrShort = (x) => (x && x.length > 16 ? x.substring(0, 8) + '…' + x.slice(-4) : (x || '—'));
  const chainToken = formatChainToken();
  return `
    <div class="card">
      <h2>On-Chain Balances</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Context: <strong>${esc(chainToken)}</strong></p>
      <div class="balance-card balance-card-lg" style="display:inline-block;">
        <div class="balance-value" style="font-size:22px;">${esc(balance)}</div>
        <div class="balance-label" style="font-size:13px;">${esc(state.globalTokenKey)}</div>
        <div class="balance-address" style="font-size:13px;color:var(--text-muted);font-family:monospace;margin-top:8px;word-break:break-all;" title="${esc(addr)}">${esc(addrShort(addr))}</div>
      </div>
      <div class="balance-shortcuts" style="display:flex;gap:8px;margin-top:16px;">
        <button type="button" class="btn btn-primary" data-wallet-section="send">
          Transfer Funds
        </button>
        <button type="button" class="btn btn-primary" data-wallet-section="vault">
          Deposit to Vault
        </button>
        <button type="button" class="btn btn-primary" data-wallet-section="deniable">
          Manage Deniables
        </button>
      </div>
    </div>
  `;
}

/** Send section: chain from header context only; show available balance. Recipient address follows context chain. */
function renderWalletSendSection() {
  const availBalance = getGlobalContextBalance();
  const chainToken = formatChainToken();
  const relatedAccounts = state.relatedAccounts || [];
  const chainKey = state.globalChainKey || 'ethereum';
  const selIdx = state.sendForm.selectedAccountIndex;
  const placeholder = chainKey === 'bitcoin' ? 'bc1... or 1... or 3...' : chainKey === 'solana' ? 'base58 address' : '0x...';
  return `
    <div class="card">
      <h3>Transfer</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Available: <strong>${esc(availBalance)} ${esc(state.globalTokenKey || 'ETH')}</strong> ${esc(chainToken)}
      </p>
      <div class="form-group">
        <label class="form-label">Send to account</label>
        <select class="form-input" id="walletSendToAccount" style="cursor:pointer;">
          <option value="">— Select account or enter address below —</option>
          ${relatedAccounts.map((acc, i) => {
            const label = (acc.label || acc.email || 'Account').trim();
            const addrForChain = getAddressForChain(acc, chainKey);
            const hasAddr = !!addrForChain;
            return `<option value="${i}" ${!hasAddr ? 'disabled' : ''} ${selIdx === i ? 'selected' : ''}>${esc(label)}${!hasAddr ? ' (no ' + (chainKey === 'ethereum' ? 'EVM' : chainKey) + ' address)' : ''}</option>`;
          }).join('')}
        </select>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:4px 0 8px 0;">or</p>
      <div class="form-group">
        <label class="form-label">Recipient Address ${esc(chainToken)}</label>
        <input class="form-input" type="text" id="walletSendTo"
          placeholder="${esc(placeholder)}" value="${esc(state.sendForm.to)}" />
      </div>
      <div class="form-group">
        <label class="form-label">Amount</label>
        <input class="form-input" type="text" id="walletSendAmount"
          placeholder="0.0" value="${esc(state.sendForm.amount)}" />
      </div>
      <button class="btn btn-primary" id="btnWalletSend" ${state.loading ? 'disabled' : ''}>
        ${state.loading ? 'Signing via Yallet...' : 'Sign & Send via Yallet'}
      </button>
      <div class="form-hint" style="margin-top:8px;">
        Transaction will be signed by your Yallet extension. Your keys never leave the extension.
      </div>
    </div>
  `;
}

function renderVaultTab() {
  const s = state.vaultBalances;
  return `
    <div class="card">
      <h3 style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <span>Vault Position</span>
        <button type="button" class="btn btn-secondary btn-sm" id="btnRefreshVaultBalance" title="Refresh from chain">Refresh</button>
      </h3>
      <div class="balance-grid">
        <div class="balance-card">
          <div class="balance-value">${esc(formatVaultShares(s.shares))}</div>
          <div class="balance-label">Shares</div>
        </div>
        <div class="balance-card">
          <div class="balance-value">${esc(formatVaultNum(s.value))}</div>
          <div class="balance-label">Value (${esc(state.vaultUnderlyingSymbol || 'USDC')})</div>
        </div>
        <div class="balance-card">
          <div class="balance-value" style="color:var(--success);">${esc(formatVaultNum(s.yield))}</div>
          <div class="balance-label">Yield</div>
        </div>
      </div>
    </div>

    ${parseFloat(state.escrowBalances.shares) > 0 ? `
    <div class="card" style="border-left:3px solid var(--warning);">
      <h3 style="display:flex;align-items:center;gap:8px;">
        <span style="color:var(--warning);">&#128274;</span> Escrow (Plan Locked)
      </h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Vault shares locked in escrow for your Asset Plan. These shares continue earning yield and will be released to recipients when the trigger fires.
      </p>
      <div class="balance-grid">
        <div class="balance-card">
          <div class="balance-value">${esc(formatVaultShares(state.escrowBalances.shares))}</div>
          <div class="balance-label">Locked Shares</div>
        </div>
        <div class="balance-card">
          <div class="balance-value">${esc(formatVaultNum(state.escrowBalances.value))}</div>
          <div class="balance-label">Value (${esc(state.vaultUnderlyingSymbol || 'USDC')})</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" id="btnReclaimEscrow" ${state.vaultReclaimLoading ? 'disabled' : ''}
        style="margin-top:12px;" title="Reclaim all shares from escrow back to your wallet (only before trigger fires)">
        ${state.vaultReclaimLoading ? 'Reclaiming...' : 'Reclaim from Escrow'}
      </button>
    </div>
    ` : ''}

    <div class="card">
      <h3>Harvest Yield</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Claim accumulated yield from the vault. Yield distribution is handled automatically by protocol rules.
      </p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-success" id="btnHarvestYield" ${state.vaultHarvestLoading ? 'disabled' : ''}>
          ${state.vaultHarvestLoading ? 'Harvesting...' : 'Harvest Yield'}
        </button>
        <button class="btn btn-secondary btn-sm" id="btnSimulateYield" ${state.vaultSimulateLoading ? 'disabled' : ''} title="Inject test yield into vault (testnet only)">
          ${state.vaultSimulateLoading ? 'Simulating...' : 'Simulate Yield'}
        </button>
      </div>
    </div>

    <div class="card">
      <h3>Redeem to Wallet</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Withdraw funds from the vault back to your self-custody wallet.
      </p>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Your shares: <strong>${esc(formatVaultShares(state.vaultBalances?.shares || '0'))}</strong></p>
      <div class="form-group">
        <label class="form-label">Shares to Redeem</label>
        <input class="form-input" type="text" id="redeemFromVaultAmount"
          placeholder='Number of shares or "max"'
          value="${state.vaultAction === 'redeem' ? esc(state.vaultAmount) : ''}" />
        <div class="form-hint">Enter a number ≤ your shares, or "max" to redeem all.</div>
      </div>
      <button class="btn btn-primary" id="btnRedeemFromVault" ${state.vaultRedeemLoading ? 'disabled' : ''}>
        ${state.vaultRedeemLoading ? 'Processing...' : 'Redeem to Wallet'}
      </button>
    </div>
  `;
}

/** Vault section: Deposit to Vault + Vault Position + Harvest + Redeem. Labels follow header context. */
// ─── Activities Section ───

function renderWalletActivities() {
  var items = state.activities || [];
  var loading = state.activitiesLoading;

  var rows = '';
  if (loading && items.length === 0) {
    rows = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted);">Loading activities...</td></tr>';
  } else if (items.length === 0) {
    rows = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted);">No activities yet. Actions like login, deposit, harvest, and redeem will appear here.</td></tr>';
  } else {
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var typeLabel = activityTypeLabel(a.type);
      var typeIcon = activityTypeIcon(a.type);
      var amountStr = a.amount ? (parseFloat(a.amount).toFixed(4) + ' ' + (a.asset || '')) : (a.detail ? esc(a.detail) : '\u2014');
      var dateStr = a.created_at ? new Date(a.created_at).toLocaleString() : '\u2014';
      var statusBadge = a.status === 'confirmed'
        ? '<span style="color:#22c55e;font-weight:600;">OK</span>'
        : a.status === 'failed'
        ? '<span style="color:#ef4444;font-weight:600;">Failed</span>'
        : '<span style="color:#f59e0b;font-weight:600;">Pending</span>';
      var explorerLink = '';
      if (a.tx_hash) {
        var chainId = a.chain_id || '11155111';
        var url = getExplorerTxUrl(chainId, a.tx_hash);
        explorerLink = '<a href="' + url + '" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none;font-size:12px;" title="' + esc(a.tx_hash) + '">' + esc(a.tx_hash.slice(0, 8)) + '\u2026' + esc(a.tx_hash.slice(-6)) + '</a>';
      } else {
        explorerLink = '<span style="color:var(--text-muted);font-size:12px;">\u2014</span>';
      }
      rows += '<tr style="border-bottom:1px solid var(--border);">' +
        '<td style="padding:10px 8px;white-space:nowrap;">' + typeIcon + ' ' + esc(typeLabel) + '</td>' +
        '<td style="padding:10px 8px;font-family:monospace;font-size:13px;">' + amountStr + '</td>' +
        '<td style="padding:10px 8px;">' + statusBadge + '</td>' +
        '<td style="padding:10px 8px;">' + explorerLink + '</td>' +
        '<td style="padding:10px 8px;color:var(--text-muted);font-size:12px;white-space:nowrap;">' + esc(dateStr) + '</td>' +
        '</tr>';
    }
  }

  return '<div class="card" style="padding:20px;">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">' +
    '<h3 style="margin:0;">Activities</h3>' +
    '<button class="btn btn-secondary" id="btnRefreshActivities" style="font-size:12px;padding:4px 12px;">Refresh</button>' +
    '</div>' +
    '<div style="overflow-x:auto;">' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
    '<thead><tr style="border-bottom:2px solid var(--border);text-align:left;">' +
    '<th style="padding:8px;">Type</th>' +
    '<th style="padding:8px;">Detail</th>' +
    '<th style="padding:8px;">Status</th>' +
    '<th style="padding:8px;">Transaction</th>' +
    '<th style="padding:8px;">Time</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>' +
    '</div>' +
    '</div>';
}

function activityTypeLabel(type) {
  var labels = {
    login: 'Login',
    deposit: 'Deposit',
    redeem: 'Redeem',
    harvest: 'Harvest',
    approve: 'Approve',
    escrow_deposit: 'Escrow Deposit',
    escrow_register: 'Escrow Register',
    claim: 'Claim',
    plan_created: 'Plan Created',
    plan_distributed: 'Plan Distributed',
    trigger_initiated: 'Trigger Initiated',
    simulate_chainlink: 'Chainlink Event (Simulated)',
  };
  return labels[type] || type;
}

function activityTypeIcon(type) {
  var icons = {
    login: '\uD83D\uDD11',          // 🔑
    deposit: '\u2B07\uFE0F',        // ⬇️
    redeem: '\u2B06\uFE0F',         // ⬆️
    harvest: '\uD83C\uDF3E',        // 🌾
    approve: '\u2705',               // ✅
    escrow_deposit: '\uD83D\uDD12', // 🔒
    escrow_register: '\uD83D\uDCDD',// 📝
    claim: '\uD83C\uDFC6',          // 🏆
    plan_created: '\uD83D\uDCC4',   // 📄
    plan_distributed: '\uD83D\uDCE8',// 📨
    trigger_initiated: '\u26A1',     // ⚡
    simulate_chainlink: '\uD83D\uDD17', // 🔗
  };
  return icons[type] || '\uD83D\uDD35'; // 🔵
}

/** Fetch activities from server and update state. */
async function loadActivities() {
  if (!state.auth?.address) return;
  state.activitiesLoading = true;
  try {
    var authHeaders = await getAuthHeadersAsync().catch(function () { return {}; });
    var resp = await apiFetch(API_BASE + '/activities/' + encodeURIComponent(state.auth.address), {
      headers: authHeaders,
    });
    if (resp.ok) {
      var data = await resp.json();
      state.activities = data.activities || [];
    }
  } catch (e) {
    console.warn('[activities] load failed:', e.message);
  } finally {
    state.activitiesLoading = false;
    if (state.page === 'activities') render();
  }
}

/** Report a completed activity to the server. */
async function reportActivity(type, txHash, amount, extra) {
  if (!state.auth?.address) return;
  try {
    var authHeaders = await getAuthHeadersAsync().catch(function () { return {}; });
    await apiFetch(API_BASE + '/activities', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(Object.assign({
        address: state.auth.address,
        type: type,
        tx_hash: txHash || null,
        amount: amount || null,
        asset: state.vaultUnderlyingSymbol || 'WETH',
        chain_id: String(state.vaultChainId || '11155111'),
        status: 'confirmed',
      }, extra || {})),
    });
    // Refresh activities list in background
    loadActivities();
  } catch (e) {
    console.warn('[activities] report failed:', e.message);
  }
}

function renderVaultSection() {
  var vaultChainToken = formatChainToken();
  var vaultAvail = getGlobalContextBalance();
  var tokenKey = state.globalTokenKey || 'USDC';
  var depositValue = (state.vaultAction === 'deposit' && state.vaultAmount !== undefined && state.vaultAmount !== '') ? state.vaultAmount : vaultAvail;
  return `
    <div class="card">
      <h3>Deposit to Vault</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Move funds into the managed vault to earn yield. You will receive vault share tokens in return.
        <br>On first deposit or when allowance is insufficient, approve the underlying token (e.g. USDC or WETH) for the Vault in your wallet first, then click Deposit.
      </p>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        Available: <strong>${esc(vaultAvail)} ${esc(tokenKey)}</strong> ${esc(vaultChainToken)}
      </p>
      <div class="form-group">
        <label class="form-label">Amount ${esc(vaultChainToken)}</label>
        <input class="form-input" type="text" id="depositToVaultAmount"
          placeholder="0.0" value="${esc(depositValue)}" />
      </div>
      <button class="btn btn-success" id="btnDepositToVault" ${state.vaultDepositLoading ? 'disabled' : ''}>
        ${state.vaultDepositLoading ? 'Processing...' : 'Deposit to Vault'}
      </button>
    </div>
    ${renderVaultTab()}
  `;
}

function renderWallet() {
  if (!state.auth) {
    return `
      <h2>Wallet</h2>
      <div class="alert alert-warning">Please connect your Yallet wallet first.</div>
    `;
  }

  const sectionContent =
    state.walletSection === 'balances' ? renderWalletBalancesSection() :
    state.walletSection === 'send' ? renderWalletSendSection() :
    state.walletSection === 'deniable' ? renderDeniableAccounts() :
    renderVaultSection();

  const sidebarItems = WALLET_SECTIONS.map((s) => `
    <button class="btn ${state.walletSection === s.key ? 'btn-primary' : 'btn-secondary'}"
      data-wallet-section="${s.key}"
      style="display:block;width:100%;text-align:left;margin-bottom:6px;border-radius:var(--radius);">
      ${esc(s.label)}
    </button>
  `).join('');

  return `
    <div class="wallet-layout" style="display:flex;gap:24px;align-items:flex-start;">
      <aside class="wallet-sidebar" style="flex-shrink:0;width:160px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);">
        <nav style="display:flex;flex-direction:column;">
          ${sidebarItems}
        </nav>
      </aside>
      <div class="wallet-content" style="flex:1;min-width:0;">
        ${sectionContent}
      </div>
    </div>
  `;
}

// ─── Accounts Page (Related Accounts, Invite, Transfer) ───

const TOKEN_OPTIONS = ['ETH', 'SOL', 'BTC', 'USDC'];
const ACCOUNTS_SECTIONS = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'invite', label: 'Invite' },
];

function renderAccountsRelatedSection() {
  if (state.accountsTransferTarget !== null) {
    const target = state.relatedAccounts[state.accountsTransferTarget];
    const token = state.accountsTransferToken;
    const amount = state.accountsTransferAmount;
    return `
      <h2>Transfer to Account</h2>
      <button class="btn btn-secondary" id="btnAccountsTransferBack" style="margin-bottom:16px;width:auto;padding:8px 14px;font-size:13px;">&larr; Back</button>
      <div class="card">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Sending from this account to:</p>
        <div style="font-weight:600;">${target ? esc(target.label || target.email) : ''}</div>
        ${target?.email ? `<div style="font-size:12px;color:var(--text-muted);">${esc(target.email)}</div>` : ''}
      </div>
      <div class="card">
        <div class="form-group">
          <label class="form-label">Token</label>
          <select class="form-input" id="accountsTransferTokenSelect">
            ${TOKEN_OPTIONS.map(t => `<option value="${t}" ${t === token ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Amount</label>
          <input type="text" class="form-input" id="accountsTransferAmountInput" placeholder="0.0" value="${esc(amount)}" />
        </div>
        <button class="btn btn-primary" id="btnAccountsTransferSubmit">Transfer</button>
      </div>
    `;
  }
  const accepted = state.relatedAccounts;
  return `
    <h2>Related Accounts</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Accounts that have accepted your invitation. Click Transfer to send tokens to them.</p>
    <div class="card">
      <h3>Related Accounts</h3>
      ${accepted.length > 0 ? `
        ${accepted.map((acc, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;${i < accepted.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
            <div>
              <div style="font-weight:600;">${esc(acc.label || acc.email)}</div>
              <div style="font-size:12px;color:var(--text-muted);">${esc(acc.email)}${acc.address ? ' <span class="mono" style="font-size:11px;opacity:0.85;">' + esc(shortEvm(acc.address)) + '</span>' : ''}</div>
            </div>
            <button type="button" class="btn btn-primary" style="width:auto;padding:6px 14px;font-size:13px;" data-action="accounts-transfer" data-index="${i}">Transfer</button>
          </div>
        `).join('')}
      ` : `
        <p style="color:var(--text-muted);font-size:13px;">No related accounts yet. Use Invite to send invitations; when they accept, they will appear here.</p>
      `}
    </div>
  `;
}

function renderAccountsInviteSection() {
  const pending = state.relatedAccountsInvites.filter(i => i.status === 'pending');
  return `
    <h2>Invite to Platform</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Send an invitation email. When the recipient signs up and accepts, they will appear in your accounts list.</p>
    <div class="card">
      <h3>Invite to Platform</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Send an invitation email. When the recipient signs up and accepts, they will appear in your accounts list.</p>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input type="email" class="form-input" id="accountsInviteEmailInput" placeholder="email@example.com" value="${esc(state.accountsInviteEmail)}" />
      </div>
      <div class="form-group" style="margin-top:8px;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="accountsInviteSubAccount" />
          <span style="font-size:13px;">Add as my sub-account</span>
        </label>
      </div>
      <button class="btn btn-primary" id="btnAccountsSendInvite" style="margin-top:12px;">Send Invitation</button>
    </div>
    ${pending.length > 0 ? `
      <div class="card">
        <h3>Pending Invitations</h3>
        ${pending.map((inv, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;${i < pending.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
            <span>${esc(inv.email)}</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="badge badge-pending">Pending</span>
              <button type="button" class="btn btn-secondary" style="width:auto;padding:4px 8px;font-size:11px;" data-action="accounts-accept-invite" data-id="${esc(inv.id || '')}" data-email="${esc(inv.email)}">Accept (demo)</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderAccounts() {
  if (!state.auth) {
    return `
      <h2>Accounts</h2>
      <div class="alert alert-warning">Please connect your wallet first.</div>
    `;
  }
  // Section content is rendered by main render() when using sidebar layout
  return '';
}

// ─── Claim Flow (Step Wizard) ───

function renderClaimStepIndicator() {
  const steps = [
    { num: 1, label: 'Credentials' },
    { num: 2, label: 'Balance' },
    { num: 3, label: 'Transfer' },
  ];
  return `
    <div style="display:flex;align-items:flex-start;justify-content:center;gap:0;margin-bottom:8px;">
      ${steps.map((s, i) => {
        let cls = 'step-pending';
        if (s.num < state.claimStep) cls = 'step-done';
        if (s.num === state.claimStep) cls = 'step-active';
        const line = i < steps.length - 1 ? '<div class="step-line" style="align-self:flex-start;margin-top:15px;"></div>' : '';
        return `
          <div style="display:flex;flex-direction:column;align-items:center;min-width:70px;">
            <div class="step ${cls}">${s.num < state.claimStep ? '&#10003;' : s.num}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${s.label}</div>
          </div>
          ${line}`;
      }).join('')}
    </div>
  `;
}

function renderClaimStep1() {
  // Use claimMeItems as sole source — /api/claim/me merges trigger + plan releases.
  // Deduplicate by admin_factor_hex (same AF may appear from both trigger and plan flow).
  const rawItems = (state.claimMeItems || []).filter(it => it.admin_factor_hex || it.blob_hex);
  const seenAF = new Set();
  const meItems = [];
  for (const item of rawItems) {
    const afKey = item.admin_factor_hex || item.blob_hex || '';
    if (afKey && seenAF.has(afKey)) continue;
    if (afKey) seenAF.add(afKey);
    meItems.push(item);
  }
  const merged = meItems.map((item, i) => ({
    label: item.label || ('Release #' + (item.path_index || '')),
    walletId: item.wallet_id || item.plan_wallet_id || '',
    af: item.admin_factor_hex || item.blob_hex || '',
    created_at: item.created_at || null,
    _meIdx: i,
  }));
  const hasReleases = merged.length > 0;
  // Pre-fill admin_factor from selected release if available
  const prefilledAF = state.releaseKey || '';

  return `
    <div class="card">
      <h2>Enter Credentials</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
        Enter the 3 factors from your credential NFT to view your balance and claim assets.
      </p>
      ${hasReleases ? `
        <div style="margin-bottom:20px;padding:12px;background:var(--surface);border-radius:8px;border:1px solid var(--border);">
          <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;text-transform:uppercase;">Your Releases</div>
          ${merged.map((item, i) => `
            <div style="padding:6px 0;${i > 0 ? 'border-top:1px solid var(--border);' : ''}">
              <span style="font-weight:500;">${esc(item.label || 'Release')}</span>
              <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${item.walletId ? esc(item.walletId.substring(0, 12)) + '...' : ''}</span>
              ${item.created_at ? '<span style="font-size:10px;color:var(--text-muted);margin-left:8px;">' + esc(new Date(typeof item.created_at === 'number' ? item.created_at : item.created_at).toLocaleString()) + '</span>' : ''}
              ${!item.af ? '<span style="font-size:11px;color:var(--text-muted);margin-left:8px;">Pending</span>' : ''}
            </div>
          `).join('')}
        </div>
      ` : !state.loading ? `
        <div style="margin-bottom:16px;padding:12px;background:var(--surface);border-radius:8px;border:1px solid var(--border);text-align:center;">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">No releases found for your address.</p>
          <button type="button" class="btn btn-secondary" id="btnClaimLoadMe" style="font-size:12px;">Refresh Releases</button>
        </div>
      ` : ''}
      <div class="form-group">
        <label class="form-label">Mnemonic (24 words)</label>
        <textarea class="form-input form-textarea" id="claimMnemonic" rows="2" placeholder="Enter your 24-word mnemonic from the credential NFT...">${esc(state.mnemonic || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Passphrase</label>
        <input type="password" class="form-input" id="claimPassphrase" placeholder="Passphrase from the credential NFT" value="${esc(state.passphrase || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">AdminFactor (hex)</label>
        <textarea class="form-input form-textarea" id="claimAdminFactor" rows="2" placeholder="64-character hex from the credential NFT">${esc(prefilledAF)}</textarea>
      </div>
      <button type="button" class="btn btn-primary" id="btnClaimContinue3F" ${state.loading ? 'disabled' : ''}>
        ${state.loading ? 'Deriving wallet...' : 'Continue'}
      </button>
    </div>
  `;
}

function renderClaimStep2() {
  const wj = state.redeemWalletJson;
  if (!wj) return `<div class="card"><p style="color:var(--text-muted);">Deriving wallet...</p></div>`;

  const evmAddr = wj.evm_address || '';
  const rawConnected = wallet && wallet.connected ? wallet.address : '';
  // Ensure 0x prefix for EVM addresses (wallet connector may store without it)
  const connectedAddr = rawConnected && !rawConnected.startsWith('0x') && /^[0-9a-fA-F]{40}$/.test(rawConnected)
    ? '0x' + rawConnected : rawConnected;

  // Path Claim section
  const releaseKeyHex = (state.releaseKey || '').replace(/^0x/i, '').trim();
  const isBlob = releaseKeyHex.length === 80;
  const pathClaimEnabled = state.pathClaimConfig?.enabled;

  // Escrow balance
  const eb = state.escrowBalance;
  let balanceDisplay = '';
  if (eb && eb.configured && (eb.remainingShares || eb.remainingAssets)) {
    const decimals = eb.underlyingDecimals || 18;
    const symbol = eb.underlyingSymbol || 'TOKEN';
    const remainShares = BigInt(eb.remainingShares || '0');
    const allocShares = BigInt(eb.allocatedShares || '0');
    const remainAssets = BigInt(eb.remainingAssets || '0');
    const allocAssets = BigInt(eb.allocatedAssets || '0');
    // Format: divide by 10^decimals, show up to 6 decimal places
    const formatVal = (wei) => {
      const divisor = 10n ** BigInt(decimals);
      const whole = wei / divisor;
      const frac = wei % divisor;
      const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '') || '0';
      return whole.toString() + '.' + fracStr;
    };
    balanceDisplay = `
      <div class="card" style="margin-top:16px;border:1px solid var(--success);background:var(--surface);">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px;">
          <span style="font-size:13px;color:var(--text-muted);">Claimable</span>
          <span style="font-size:24px;font-weight:700;color:var(--success);">${formatVal(remainShares)} shares</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">
          Value: ~${formatVal(remainAssets)} ${esc(symbol)}
        </div>
        ${allocShares > remainShares ? `
          <div style="font-size:12px;color:var(--text-muted);">
            Total allocated: ${formatVal(allocShares)} shares (~${formatVal(allocAssets)} ${esc(symbol)})
          </div>
        ` : ''}
      </div>
    `;
  } else if (eb && eb.configured && eb.remainingShares === '0') {
    balanceDisplay = `
      <div class="card" style="margin-top:16px;">
        <p style="color:var(--text-muted);font-size:13px;">No shares allocated for this recipient yet. Owner needs to deposit into escrow.</p>
      </div>
    `;
  } else if (eb && !eb.configured) {
    balanceDisplay = `
      <div class="card" style="margin-top:16px;">
        <p style="color:var(--text-muted);font-size:13px;">Escrow not configured. ${esc(eb.error || '')}</p>
      </div>
    `;
  } else {
    balanceDisplay = `
      <div class="card" style="margin-top:16px;">
        <p style="color:var(--text-muted);font-size:13px;">Loading balance...</p>
      </div>
    `;
  }

  return `
    <div class="card">
      <h2>Your Claim</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
        Derived signing key: <code style="font-size:11px;">${esc(evmAddr)}</code>
      </p>
    </div>
    ${balanceDisplay}
    <div class="card" style="margin-top:16px;">
      <h3>Transfer</h3>
      <div class="form-group">
        <label class="form-label">From (derived path wallet)</label>
        <input type="text" class="form-input" readonly
          value="${esc(evmAddr)}" style="opacity:0.7;font-family:monospace;font-size:12px;" />
      </div>
      <div class="form-group">
        <label class="form-label">To (your wallet)</label>
        <input type="text" class="form-input" id="claimTransferTo"
          placeholder="Your wallet address" value="${esc(state.redeemToAddress || connectedAddr)}" />
        <div class="form-hint">${connectedAddr ? 'Pre-filled from your connected wallet. You may change it.' : 'Enter your personal wallet address.'}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button type="button" class="btn btn-primary" id="btnClaimTransfer" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? 'Preparing...' : 'Transfer'}
        </button>
        <button type="button" class="btn btn-secondary" id="btnClaimBack">Back</button>
      </div>
    </div>
    ${isBlob && pathClaimEnabled ? `
    <div class="card" style="margin-top:16px;">
      <h3>On-Chain Path Claim (EVM)</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Claim from the YaultPathClaim contract (amount from 80-char blob).</p>
      ${state.pathClaimAmountFromBlob != null ? `
        <p style="margin-bottom:8px;"><strong>Amount from blob:</strong> <code>${esc(String(state.pathClaimAmountFromBlob))}</code> (wei)</p>
        ${state.pathClaimRemaining != null ? `<p style="margin-bottom:8px;"><strong>Remaining on chain:</strong> <code>${esc(String(state.pathClaimRemaining))}</code></p>` : ''}
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">Path controller key (hex)</label>
          <input type="password" class="form-input" id="inputPathClaimControllerKey" placeholder="0x..."
            value="${esc(state.pathClaimControllerKey || '')}" />
        </div>
        <button type="button" class="btn btn-primary" id="btnPathClaimClaim" ${state.pathClaimLoading ? 'disabled' : ''}>
          ${state.pathClaimLoading ? 'Sending claim...' : 'Claim to my wallet'}
        </button>
      ` : `
        <button type="button" class="btn btn-secondary" id="btnPathClaimGetAmount">Get amount from blob</button>
      `}
      ${state.pathClaimError ? `<p class="alert alert-warning" style="margin-top:12px;">${esc(state.pathClaimError)}</p>` : ''}
    </div>
    ` : isBlob && !pathClaimEnabled ? `
    <div class="card" style="margin-top:16px;">
      <button type="button" class="btn btn-secondary" id="btnPathClaimLoadConfigClaim">Load path claim config</button>
    </div>
    ` : ''}
  `;
}

function renderClaimStep3() {
  const r = state.transferResult;
  if (!r) return '';
  const isSubmitted = r.status === 'submitted' && r.txHash;
  const alertClass = isSubmitted ? 'alert-success' : 'alert-info';
  const alertMsg = isSubmitted
    ? 'Claim transaction submitted to the blockchain!'
    : 'Transaction prepared. Review the details below.';
  const explorerLink = isSubmitted
    ? `<a href="https://sepolia.etherscan.io/tx/${esc(r.txHash)}" target="_blank" rel="noopener" style="word-break:break-all;font-family:monospace;font-size:12px;">${esc(r.txHash)}</a>`
    : '';
  return `
    <div class="card">
      <h2>Claim Result</h2>
      <div class="alert ${alertClass}">${alertMsg}</div>
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="color:var(--text-muted);font-size:13px;">Chain</span>
          <span>${esc(r.chain)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="color:var(--text-muted);font-size:13px;">To</span>
          <span style="font-family:monospace;font-size:12px;">${esc((r.to || '').substring(0, 20))}...</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="color:var(--text-muted);font-size:13px;">Amount</span>
          <span style="color:var(--success);font-weight:600;">${esc(r.amount)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span style="color:var(--text-muted);font-size:13px;">Status</span>
          <span style="color:var(--success);">${esc(r.status)}</span>
        </div>
        ${isSubmitted ? `<div style="margin-top:8px;"><span style="color:var(--text-muted);font-size:13px;">Tx Hash</span><br/>${explorerLink}</div>` : ''}
      </div>
      <p style="font-size:13px;color:var(--text-secondary);">${esc(r.message || '')}</p>
      <button class="btn btn-secondary" id="btnClaimBackToBalance" style="margin-top:12px;">Back</button>
    </div>
  `;
}

function renderClaim() {
  const step = state.claimStep || 1;
  let stepContent = '';
  if (step === 1) stepContent = renderClaimStep1();
  else if (step === 2) stepContent = renderClaimStep2();
  else if (step === 3) stepContent = renderClaimStep3();
  else stepContent = renderClaimStep1();

  return `
    ${renderClaimStepIndicator()}
    <div style="margin-top:16px;">${stepContent}</div>
  `;
}

function renderRedeem() {
  const chainKey = state.redeemChain || 'ethereum';
  const defaultTokens = REDEEM_DEFAULT_TOKENS[chainKey] || [];
  const userTokensRaw = state.redeemUserTokens || [];
  const userTokens = userTokensRaw.map((t) => ({ symbol: t.token_name || t.symbol, name: t.token_name || t.name, contract: t.contract_address || t.contract || '' }));
  const allTokens = [...defaultTokens, ...userTokens];
  return `
    <div class="card" style="margin-top:0;">
      <div class="form-group">
        <label class="form-label">Mnemonic</label>
        <textarea class="form-input form-textarea" id="redeemMnemonic" rows="2" placeholder="24 words..."></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Passphrase</label>
        <input type="password" class="form-input" id="redeemPassphrase" placeholder="Passphrase" />
      </div>
      <div class="form-group">
        <label class="form-label">AdminFactor</label>
        <div style="display:flex;align-items:flex-end;gap:12px;">
          <textarea class="form-input form-textarea" id="redeemAdminFactor" rows="2" placeholder="AdminFactor hex" style="flex:1;"></textarea>
          <button type="button" class="btn btn-secondary" id="btnRedeemFetch">Fetch</button>
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <div class="form-group" style="flex:1;min-width:180px;">
          <label class="form-label">From (chain)</label>
          <select class="form-input" id="redeemChain">
            ${REDEEM_CHAINS.map((c) => `
              <option value="${esc(c.key)}" ${c.key === chainKey ? 'selected' : ''}>${esc(c.label)}</option>
            `).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:180px;">
          <label class="form-label">Token</label>
          <select class="form-input" id="redeemToken">
            ${allTokens.map((t) => `
              <option value="${esc(t.contract || t.symbol)}">${esc(t.symbol)} ${t.name ? ' — ' + t.name : ''}</option>
            `).join('')}
            <option value="__add_new__">Add New Token Address</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">From address</label>
        <input type="text" class="form-input" id="redeemFromAddress" readonly placeholder="(derived)" />
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">Balance: 0</p>
      </div>
      <div class="form-group">
        <label class="form-label">To address</label>
        <input type="text" class="form-input" id="redeemToAddress" placeholder="Your Yallet address or paste another" value="${esc(state.redeemToAddress || '')}" />
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">Default: your saved Yallet address for this chain.</p>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:20px;">
        <button type="button" class="btn btn-primary" id="btnRedeemTransfer">Transfer</button>
      </div>
    </div>
    <!-- Add New Token dialog -->
    <div id="addTokenDialog" class="modal-overlay hidden" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;">
      <div class="modal card" style="max-width:400px;width:90%;" onclick="event.stopPropagation()">
        <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">Add New Token</h3>
          <button type="button" class="modal-close" id="btnAddTokenDialogClose">&times;</button>
        </div>
        <div class="form-group">
          <label class="form-label">Token name</label>
          <input type="text" class="form-input" id="addTokenName" placeholder="e.g. My Token" />
        </div>
        <div class="form-group">
          <label class="form-label">Contract address</label>
          <input type="text" class="form-input" id="addTokenContract" placeholder="0x... or Solana address" />
        </div>
        <button type="button" class="btn btn-primary" id="btnAddTokenSubmit">Submit</button>
      </div>
    </div>
  `;
}

function renderActivity() {
  if (state.releases.length === 0) {
    return `
      <h2>Activity</h2>
      <div class="card" style="text-align:center;color:var(--text-muted);padding:40px;">
        No activity yet.
      </div>
    `;
  }
  return `
    <h2>Activity</h2>
    ${state.releases.map(r => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-family:monospace;font-size:13px;">${esc((r.wallet_id || '').substring(0, 16))}...</span>
          <span class="badge badge-${r.status === 'released' ? 'released' : r.status === 'pending' ? 'pending' : 'active'}">
            ${esc(r.status)}
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">
          Path #${r.recipient_index != null ? r.recipient_index : '--'}
          &bull; Decision: ${esc(r.decision || 'pending')}
          ${r.decided_at ? ' &bull; ' + new Date(r.decided_at).toLocaleString() : ''}
        </div>
      </div>
    `).join('')}
  `;
}

const SETTINGS_SECTIONS = [
  { key: 'wallet', label: 'Connected Wallet' },
  { key: 'account', label: 'Account' },
  { key: 'kyc', label: 'Identity (KYC)' },
];

function renderSettingsWalletSection() {
  return `
    <h2>Connected Wallet</h2>
    <div class="card">
      <h3>Connected Wallet</h3>
      ${wallet && wallet.connected ? wallet.renderConnectedStatus() : '<p style="color:var(--text-muted);">No wallet connected.</p>'}
    </div>
  `;
}

function renderSettingsAccountSection() {
  return `
    <h2>Account</h2>
    <div class="card">
      <h3>Account</h3>
      <div class="form-group">
        <label class="form-label">Address / Public Key</label>
        <input class="form-input" type="text" value="${esc(state.auth?.address || state.auth?.pubkey || '')}" readonly style="opacity:0.6;" />
      </div>
      <div class="form-group">
        <label class="form-label">Wallet Type</label>
        <input class="form-input" type="text" value="${esc(state.auth?.walletType || '')}" readonly style="opacity:0.6;" />
      </div>
      <button class="btn btn-danger" data-action="logout" style="margin-top:8px;">Disconnect & Sign Out</button>
    </div>
  `;
}

function renderSettingsKYCSection() {
  const kycBadgeClass = state.kycStatus === 'approved' ? 'badge-active'
    : state.kycStatus === 'pending' ? 'badge-pending'
    : state.kycStatus === 'rejected' ? 'badge-released' : '';
  return `
    <h2>Identity Verification (KYC)</h2>
    <div class="card">
      <h3>Identity Verification (KYC)</h3>
      ${state.kycStatus === 'approved' ? `
        <div class="alert alert-success">
          Identity verified. <span class="badge ${kycBadgeClass}">${esc(state.kycStatus)}</span>
          ${state.kycLevel ? ' &bull; Level: ' + esc(state.kycLevel) : ''}
        </div>
      ` : state.kycStatus === 'pending' ? `
        <div class="alert alert-warning">
          Verification in progress. <span class="badge ${kycBadgeClass}">Pending Review</span>
        </div>
      ` : state.kycStatus === 'rejected' ? `
        <div class="alert alert-danger">
          Verification was rejected. You can resubmit.
        </div>
        <button class="btn btn-primary" id="btnSubmitKYC">Resubmit Verification</button>
      ` : `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">
          Complete identity verification to unlock full platform features.
          Required for institutional accounts and high-value operations.
        </p>
        <div class="form-group">
          <label class="form-label">Verification Level</label>
          <select class="form-input" id="kycLevelSelect">
            <option value="basic">Basic (Individual)</option>
            <option value="enhanced">Enhanced (High Value)</option>
            <option value="institutional">Institutional (Entity / Corporate)</option>
          </select>
          <div class="form-hint">Institutional KYC includes entity verification and authorized representative checks.</div>
        </div>
        <button class="btn btn-primary" id="btnSubmitKYC">Start Verification</button>
      `}
    </div>
  `;
}

function renderProfileContent() {
  const p = state.clientProfile || { address: '', name: '', email: '', phone: '', physical_address: '' };
  const editMode = state.profileEditMode === true;

  if (editMode) {
    return `
      <h2>Profile</h2>
      <div class="card">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Update your profile. This information is used for account and support.</p>
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" type="text" id="clientProfileName" value="${esc(p.name || '')}" placeholder="Your name or display name" />
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" type="email" id="clientProfileEmail" value="${esc(p.email || '')}" placeholder="email@example.com" />
        </div>
        <div class="form-group">
          <label class="form-label">Phone</label>
          <input class="form-input" type="text" id="clientProfilePhone" value="${esc(p.phone || '')}" placeholder="Phone or Telegram" />
        </div>
        <div class="form-group">
          <label class="form-label">Address</label>
          <input class="form-input" type="text" id="clientProfileAddress" value="${esc(p.physical_address || '')}" placeholder="Physical or mailing address (optional)" />
        </div>
        <div style="display:flex;gap:12px;margin-top:16px;">
          <button type="button" class="btn btn-primary" data-action="client-profile-save">Save</button>
          <button type="button" class="btn btn-secondary" data-action="client-profile-cancel">Cancel</button>
        </div>
      </div>
    `;
  }
  return `
    <h2>Profile</h2>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">Profile</h3>
        <button type="button" class="btn btn-secondary" data-action="client-profile-edit">Edit</button>
      </div>
      <dl style="display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-size:14px;">
        <dt style="color:var(--text-muted);margin:0;">Wallet</dt>
        <dd style="margin:0;"><span class="mono" style="font-size:12px;">${esc((p.address || '').substring(0, 6))}...${esc((p.address || '').slice(-4))}</span></dd>
        <dt style="color:var(--text-muted);margin:0;">Name</dt>
        <dd style="margin:0;">${esc(p.name || '—')}</dd>
        <dt style="color:var(--text-muted);margin:0;">Email</dt>
        <dd style="margin:0;">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}</dd>
        <dt style="color:var(--text-muted);margin:0;">Phone</dt>
        <dd style="margin:0;">${esc(p.phone || '—')}</dd>
        <dt style="color:var(--text-muted);margin:0;">Address</dt>
        <dd style="margin:0;">${esc(p.physical_address || '—')}</dd>
      </dl>
    </div>
  `;
}

function renderSettings() {
  // Section content is rendered by main render() when using sidebar layout
  return '';
}

// ─── Sidebar layout (shared by Wallet, Accounts, Protection, Claim, Activity, Settings) ───
const SIDEBAR_GRID_STYLE = 'display:grid;grid-template-columns:120px 1fr;gap:0 20px;align-items:start;margin-bottom:0;';
const SIDEBAR_ASIDE_STYLE = 'margin-left:-90px;margin-top:65px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:0 var(--radius) var(--radius) 0;';

function renderPageWithSidebar(sections, dataAttr, activeKey, sectionContentHtml) {
  const sidebarItems = sections.map((s) => `
    <button class="btn ${activeKey === s.key ? 'btn-primary' : 'btn-secondary'}"
      data-${dataAttr}="${s.key}"
      style="display:block;width:100%;text-align:left;margin-bottom:6px;border-radius:var(--radius);">
      ${esc(s.label)}
    </button>
  `).join('');
  return `
    <div class="wallet-page-wrap" style="${SIDEBAR_GRID_STYLE}">
      <aside class="wallet-sidebar" style="${SIDEBAR_ASIDE_STYLE}">
        <nav style="display:flex;flex-direction:column;">${sidebarItems}</nav>
      </aside>
      <div class="wallet-main-col" style="min-width:0;">
        <header class="app-header" style="margin-bottom:16px;">${renderNav()}</header>
        ${state.error && state.page !== 'claim' ? `<div class="alert alert-danger">${esc(state.error)}</div>` : ''}
        <div class="wallet-content">${sectionContentHtml}</div>
      </div>
    </div>
  `;
}

// ─── Main Render ───

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (state.page === 'login') {
    app.innerHTML = renderLogin();
    if (wallet) wallet.attachEvents(app);
    // Trial application modal
    const trialApplyBtn = app.querySelector('#trialApplyBtn');
    if (trialApplyBtn) {
      trialApplyBtn.addEventListener('click', () => {
        const modal = app.querySelector('#trialModal');
        if (modal) modal.classList.remove('hidden');
      });
    }
    app.querySelectorAll('[data-action="close-trial-modal"]').forEach(el => {
      el.addEventListener('click', () => {
        const modal = app.querySelector('#trialModal');
        if (modal) modal.classList.add('hidden');
      });
    });
    const trialSubmitBtn = app.querySelector('#trialSubmitBtn');
    if (trialSubmitBtn) {
      trialSubmitBtn.addEventListener('click', async () => {
        const name = app.querySelector('#trialName')?.value?.trim();
        const email = app.querySelector('#trialEmail')?.value?.trim();
        const useCase = app.querySelector('#trialUseCase')?.value;
        const notes = app.querySelector('#trialNotes')?.value?.trim();
        const feedback = app.querySelector('#trialFeedback');
        if (!name || !email || !useCase) {
          if (feedback) {
            feedback.className = 'alert alert-warning';
            feedback.textContent = 'Please fill in all required fields.';
          }
          return;
        }
        trialSubmitBtn.disabled = true;
        trialSubmitBtn.textContent = 'Submitting...';
        try {
          const resp = await fetch(`${API_BASE}/trial/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, useCase, notes }),
          });
          const data = await resp.json();
          if (resp.ok && data.success) {
            if (feedback) {
              feedback.className = 'alert alert-success';
              feedback.innerHTML = '<strong>Application submitted!</strong> We\'ll be in touch soon.';
            }
            trialSubmitBtn.textContent = 'Submitted';
          } else {
            throw new Error(data.error || 'Submission failed');
          }
        } catch (err) {
          if (feedback) {
            feedback.className = 'alert alert-danger';
            feedback.textContent = err.message;
          }
          trialSubmitBtn.disabled = false;
          trialSubmitBtn.textContent = 'Submit Application';
        }
      });
    }
    return;
  }

  const errorHTML = state.error
    ? `<div class="alert alert-danger">${esc(state.error)}</div>`
    : '';

  let content = '';
  switch (state.page) {
    case 'wallet': content = renderWallet(); break;
    case 'accounts': content = renderAccounts(); break;
    case 'protection': content = renderProtection(); break;
    case 'claim': content = renderClaim(); break;
    case 'activities': content = renderWalletActivities(); break;
    case 'profile': content = renderProfileContent(); break;
    case 'settings': content = renderSettings(); break;
    default: content = renderWallet();
  }

  // Pages with left sidebar (same layout as Wallet)
  if (state.page === 'wallet' && state.auth) {
    const sectionContent =
      state.walletSection === 'balances' ? renderWalletBalancesSection() :
      state.walletSection === 'send' ? renderWalletSendSection() :
      state.walletSection === 'activities' ? renderWalletActivities() :
      state.walletSection === 'deniable' ? renderDeniableAccounts() :
      renderVaultSection();
    app.innerHTML = renderPageWithSidebar(WALLET_SECTIONS, 'wallet-section', state.walletSection, sectionContent);
  } else if (state.page === 'accounts' && state.auth) {
    const sectionContent = state.accountsSection === 'invite' ? renderAccountsInviteSection() : renderAccountsRelatedSection();
    app.innerHTML = renderPageWithSidebar(ACCOUNTS_SECTIONS, 'accounts-section', state.accountsSection, sectionContent);
  } else if (state.page === 'protection') {
    app.innerHTML = renderPageWithSidebar([{ key: 'plan', label: 'Plan' }], 'protection-section', 'plan', renderProtection());
  } else if (state.page === 'claim') {
    const claimContent = state.claimSection === 'redeem' ? renderRedeem() : renderClaim();
    app.innerHTML = renderPageWithSidebar(
      [{ key: 'claims', label: 'Claims' }, { key: 'redeem', label: 'Redeem' }],
      'claim-section',
      state.claimSection,
      claimContent
    );
  } else if (state.page === 'activities') {
    app.innerHTML = renderPageWithSidebar([{ key: 'activities', label: 'Activities' }], 'activities-section', 'activities', renderWalletActivities());
  } else if (state.page === 'profile') {
    app.innerHTML = renderPageWithSidebar([{ key: 'profile', label: 'Profile' }], 'profile-section', 'profile', renderProfileContent());
  } else if (state.page === 'settings') {
    const sectionContent =
      state.settingsSection === 'wallet' ? renderSettingsWalletSection() :
      state.settingsSection === 'account' ? renderSettingsAccountSection() :
      renderSettingsKYCSection();
    app.innerHTML = renderPageWithSidebar(SETTINGS_SECTIONS, 'settings-section', state.settingsSection, sectionContent);
  } else {
    app.innerHTML = `
      <header class="app-header" style="display:flex;align-items:center;margin-bottom:16px;">${renderNav()}</header>
      ${errorHTML}
      ${content}
    `;
  }

  const shellAddr = document.getElementById('shell-wallet-addr');
  if (shellAddr) shellAddr.innerHTML = state.auth ? renderWalletHeaderCompact() : '';

  attachAppEvents();
}

// ─── Event Handlers ───

function attachAppEvents() {
  const app = document.getElementById('app');
  if (!app) return;

  // Navigation
  app.querySelectorAll('.nav-item[data-page]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  // Disconnect in wallet status bar
  app.querySelectorAll('[data-action="wallet-disconnect"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (wallet) wallet.disconnect();
    });
  });

  // Logout
  app.querySelectorAll('[data-action="logout"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (wallet) wallet.disconnect();
    });
  });

  // ── KYC submit ──

  const btnSubmitKYC = document.getElementById('btnSubmitKYC');
  if (btnSubmitKYC) {
    btnSubmitKYC.addEventListener('click', async () => {
      const level = document.getElementById('kycLevelSelect')?.value || 'basic';
      state.loading = true;
      state.error = null;
      render();
      try {
        const authHeaders = await getAuthHeadersAsync();
        const resp = await fetch(`${API_BASE}/kyc/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            address: state.auth?.address || '',
            level,
            provider: 'manual', // stub — will be replaced with real provider
          }),
        });
        const data = await resp.json();
        state.kycStatus = data.status || 'pending';
        state.kycLevel = level;
        showToast('KYC submitted', 'success');
      } catch (err) {
        state.error = 'KYC submission failed: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  // ── Protection page events ──

  const btnCreatePlan = document.getElementById('btnCreatePlan');
  if (btnCreatePlan) {
    btnCreatePlan.addEventListener('click', async () => {
      state.protectionStep = 'create-plan';
      state.planStep = 'triggers';
      state.planType = null;
      state.vaultBalanceForPlan = null;
      state.planTriggerTypes = { oracle: false, legal_authority: false, inactivity: false, oracle_with_legal_fallback: false };
      state.planRecipients = [];
      state.planTriggerConfig = {
        oracle: {},
        legalAuthority: { jurisdiction: '', selectedFirms: [], firmSearchResults: [] },
        inactivityMonths: 12,
      };
      state.planReviewed = false;
      state.planMemo = '';
      await loadAccountInvites();
      render();
    });
  }

  const btnSimChainOverview = document.getElementById('btnSimulateChainlinkOverview');
  if (btnSimChainOverview) {
    btnSimChainOverview.addEventListener('click', async () => {
      const hint = document.getElementById('chainlinkOverviewHint');
      btnSimChainOverview.disabled = true;
      btnSimChainOverview.textContent = 'Submitting...';
      if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
      try {
        const headers = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/trigger/simulate-chainlink`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || resp.statusText);
        }
        const data = await resp.json();
        const mins = data.cooldown_minutes || 10;
        btnSimChainOverview.textContent = 'Event Triggered';
        if (hint) {
          hint.style.display = 'inline';
          hint.textContent = 'Oracle event has been triggered. Please wait ' + mins + ' minutes before claiming.';
        }
        reportActivity('simulate_chainlink', null, null, { detail: (data.triggers || []).length + ' triggers created' });
      } catch (err) {
        btnSimChainOverview.textContent = 'Simulate Chainlink Event';
        btnSimChainOverview.disabled = false;
        if (hint) {
          hint.style.display = 'inline';
          hint.style.color = 'var(--danger)';
          hint.textContent = 'Failed: ' + err.message;
        }
      }
    });
  }

  // Path Claim Pool (Protection): load config, register wallet, deposit, register path
  const btnPathClaimLoadConfig = document.getElementById('btnPathClaimLoadConfig');
  if (btnPathClaimLoadConfig) {
    btnPathClaimLoadConfig.addEventListener('click', async () => {
      try {
        const c = await (typeof YaultPathClaim !== 'undefined' ? YaultPathClaim.getConfig(API_BASE) : fetch(API_BASE + '/path-claim/config').then(r => r.json()));
        state.pathClaimConfig = c;
        state.pathClaimError = null;
      } catch (e) {
        state.pathClaimConfig = { enabled: false };
        state.pathClaimError = e.message;
      }
      render();
    });
  }
  const btnPathClaimRegisterWallet = document.getElementById('btnPathClaimRegisterWallet');
  if (btnPathClaimRegisterWallet) {
    btnPathClaimRegisterWallet.addEventListener('click', async () => {
      state.pathClaimWalletId = document.getElementById('inputPathClaimWalletId')?.value?.trim() || '';
      if (!state.pathClaimWalletId || !state.pathClaimConfig?.enabled) {
        state.pathClaimError = 'Pool Wallet ID required and path claim must be enabled.';
        render();
        return;
      }
      state.pathClaimLoading = true;
      state.pathClaimError = null;
      render();
      try {
        const ethers = window.ethers;
        const walletIdHashHex = ethers.keccak256(ethers.toUtf8Bytes(state.pathClaimWalletId));
        const tx = YaultPathClaim.buildRegisterWalletTx(state.pathClaimConfig, walletIdHashHex);
        const provider = window.yallet;
        if (!provider) throw new Error('No wallet provider');
        const ethersProvider = new ethers.BrowserProvider(provider);
        const signer = await ethersProvider.getSigner();
        const txResp = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
        await txResp.wait();
        state.pathClaimError = null;
        showToast && showToast('Wallet registered', 'success');
      } catch (e) {
        state.pathClaimError = e.message || 'Register wallet failed';
      } finally {
        state.pathClaimLoading = false;
        render();
      }
    });
  }
  const btnPathClaimDeposit = document.getElementById('btnPathClaimDeposit');
  if (btnPathClaimDeposit) {
    btnPathClaimDeposit.addEventListener('click', async () => {
      state.pathClaimWalletId = document.getElementById('inputPathClaimWalletId')?.value?.trim() || state.pathClaimWalletId;
      state.pathClaimDepositAmount = document.getElementById('inputPathClaimDepositAmount')?.value?.trim() || '';
      if (!state.pathClaimWalletId || !state.pathClaimDepositAmount || !state.pathClaimConfig?.enabled) {
        state.pathClaimError = 'Wallet ID, amount required. Approve pool to spend token first if needed.';
        render();
        return;
      }
      state.pathClaimLoading = true;
      state.pathClaimError = null;
      render();
      try {
        const ethers = window.ethers;
        const walletIdHashHex = ethers.keccak256(ethers.toUtf8Bytes(state.pathClaimWalletId));
        const amountWei = BigInt(state.pathClaimDepositAmount);
        const tx = YaultPathClaim.buildDepositTx(state.pathClaimConfig, walletIdHashHex, amountWei);
        const provider = window.yallet;
        if (!provider) throw new Error('No wallet provider');
        const ethersProvider = new ethers.BrowserProvider(provider);
        const signer = await ethersProvider.getSigner();
        const txResp = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
        await txResp.wait();
        state.pathClaimError = null;
        showToast && showToast('Deposit sent', 'success');
      } catch (e) {
        state.pathClaimError = e.message || 'Deposit failed';
      } finally {
        state.pathClaimLoading = false;
        render();
      }
    });
  }
  const btnPathClaimRegisterPath = document.getElementById('btnPathClaimRegisterPath');
  if (btnPathClaimRegisterPath) {
    btnPathClaimRegisterPath.addEventListener('click', async () => {
      state.pathClaimWalletId = document.getElementById('inputPathClaimWalletId')?.value?.trim() || state.pathClaimWalletId;
      state.pathClaimPathIndex = document.getElementById('inputPathClaimPathIndex')?.value?.trim() || '1';
      state.pathClaimPathController = document.getElementById('inputPathClaimPathController')?.value?.trim() || '';
      state.pathClaimPathTotalAmount = document.getElementById('inputPathClaimPathTotal')?.value?.trim() || '';
      if (!state.pathClaimWalletId || !state.pathClaimPathController || !state.pathClaimPathTotalAmount || !state.pathClaimConfig?.enabled) {
        state.pathClaimError = 'Wallet ID, path controller address, and total amount required.';
        render();
        return;
      }
      state.pathClaimLoading = true;
      state.pathClaimError = null;
      render();
      try {
        const ethers = window.ethers;
        const walletIdHashHex = ethers.keccak256(ethers.toUtf8Bytes(state.pathClaimWalletId));
        const tx = YaultPathClaim.buildRegisterPathTx(
          state.pathClaimConfig,
          walletIdHashHex,
          state.pathClaimPathIndex,
          state.pathClaimPathController,
          BigInt(state.pathClaimPathTotalAmount)
        );
        const provider = window.yallet;
        if (!provider) throw new Error('No wallet provider');
        const ethersProvider = new ethers.BrowserProvider(provider);
        const signer = await ethersProvider.getSigner();
        const txResp = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
        await txResp.wait();
        state.pathClaimError = null;
        showToast && showToast('Path registered', 'success');
      } catch (e) {
        state.pathClaimError = e.message || 'Register path failed';
      } finally {
        state.pathClaimLoading = false;
        render();
      }
    });
  }

  const btnLoadBoundFirms = document.getElementById('btnLoadBoundFirms');
  const btnRefreshBoundFirms = document.getElementById('btnRefreshBoundFirms');
  [btnLoadBoundFirms, btnRefreshBoundFirms].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await loadBoundFirms();
        showToast('Loaded', 'success');
      } catch (err) {
        showToast(err.message || 'Load failed', 'error');
      } finally {
        btn.disabled = false;
        render();
      }
    });
  });

  const btnPlanLoadVaultBalance = document.getElementById('btnPlanLoadVaultBalance');
  if (btnPlanLoadVaultBalance) {
    btnPlanLoadVaultBalance.addEventListener('click', async () => {
      const evmAddr = state.auth?.address?.startsWith('0x') ? state.auth.address : ('0x' + (state.auth?.pubkey || ''));
      if (!evmAddr || evmAddr === '0x') {
        showToast(t('cannotGetAddress'), 'error');
        return;
      }
      btnPlanLoadVaultBalance.disabled = true;
      try {
        const headers = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await fetch(`${API_BASE}/vault/balance/${encodeURIComponent(evmAddr)}`, { headers });
        if (!resp.ok) throw new Error('Vault balance request failed');
        const data = await resp.json();
        const value = parseFloat(data.vault?.value ?? data.vault?.assets ?? 0) || 0;
        const shares = data.vault?.shares ?? '0';
        const symbol = data.vault?.underlying_symbol || 'Vault shares';
        state.vaultBalanceForPlan = {
          value: String(data.vault?.value ?? data.vault?.assets ?? '0'),
          shares: String(shares),
          underlying_symbol: symbol,
        };
        if (value > 0) {
          showToast('Balance loaded. You can set recipient ratios and proceed.', 'success');
        } else {
          showToast('Balance is 0. Please go to Wallet → Vault to deposit.', 'error');
        }
      } catch (err) {
        showToast('Failed to check balance: ' + (err.message || 'Please try again'), 'error');
      } finally {
        btnPlanLoadVaultBalance.disabled = false;
        render();
      }
    });
  }

  const btnPlanWizardBack = document.getElementById('btnPlanWizardBack');
  if (btnPlanWizardBack) {
    btnPlanWizardBack.addEventListener('click', () => {
      if (state.planStep === 'triggers') {
        state.protectionStep = 'overview';
      } else if (state.planStep === 'recipients') {
        state.planStep = 'triggers';
      } else if (state.planStep === 'trigger-config') {
        state.planStep = 'recipients';
      } else if (state.planStep === 'review') {
        state.planStep = 'trigger-config';
      }
      render();
    });
  }

  const btnPlanStepNext = document.getElementById('btnPlanStepNext');
  if (btnPlanStepNext) {
    btnPlanStepNext.addEventListener('click', async () => {
      if (state.planStep === 'triggers') {
        const planTypeEl = document.querySelector('input[name="planType"]:checked');
        const planTypeVal = planTypeEl ? planTypeEl.value : '';
        if (!planTypeVal || (planTypeVal !== 'wallet' && planTypeVal !== 'yield_pool')) {
          showToast('Please select a plan type (Wallet Plan or Yielding Vault Plan)', 'error');
          return;
        }
        const mainEl = document.querySelector('input[name="planTriggerMain"]:checked');
        const main = mainEl ? mainEl.value : '';
        if (!main || (main !== 'oracle' && main !== 'legal_authority' && main !== 'inactivity')) {
          showToast('Please select a trigger type (Oracle, Legal Authority, or Inactivity)', 'error');
          return;
        }
        state.planType = planTypeVal;
        state.planTriggerTypes = {
          oracle: main === 'oracle',
          legal_authority: main === 'legal_authority',
          inactivity: main === 'inactivity',
          oracle_with_legal_fallback: !!document.getElementById('planTriggerOracleLegalFallback')?.checked,
        };
        state.planStep = 'recipients';
        state.vaultBalanceForPlan = null;
      } else if (state.planStep === 'recipients') {
        const related = state.relatedAccounts || [];
        if (related.length === 0) {
          showToast('Add related accounts in the Accounts page first', 'error');
          return;
        }
        const planType = state.planType || 'wallet';
        const isWalletPlan = planType === 'wallet';
        const key = (acc) => (acc.address || acc.email || acc.id || '').toString();
        let nextList = [];
        if (isWalletPlan) {
          const selectEl = document.getElementById('planWalletRecipientSelect');
          const selectedKey = selectEl ? (selectEl.value || '').trim() : '';
          if (!selectedKey) {
            showToast('Please select one recipient', 'error');
            return;
          }
          const acc = selectedKey.startsWith('idx-') ? related[parseInt(selectedKey.slice(4), 10)] : related.find((a) => key(a) === selectedKey);
          if (!acc) {
            showToast('Selected recipient not found', 'error');
            return;
          }
          nextList = [{
            label: acc.label || acc.email || '',
            email: acc.email || undefined,
            address: acc.address || undefined,
            percentage: 100,
          }];
        } else {
          const inputs = document.querySelectorAll('input[name="planPct"]');
          inputs.forEach((input) => {
            const planKey = (input.dataset.planKey || '').trim();
            const pct = parseInt(input.value, 10);
            if (!Number.isFinite(pct) || pct <= 0) return;
            const acc = planKey.startsWith('idx-') ? related[parseInt(planKey.slice(4), 10)] : related.find((a) => key(a) === planKey);
            if (!acc) return;
            nextList.push({
              label: acc.label || acc.email || '',
              email: acc.email || undefined,
              address: acc.address || undefined,
              percentage: Math.min(100, pct),
            });
          });
          if (nextList.length === 0) {
            showToast('Select at least one recipient and set share', 'error');
            return;
          }
          const total = nextList.reduce((s, r) => s + (Number(r.percentage) || 0), 0);
          if (total !== 100) {
            showToast('Total share must be 100%', 'error');
            return;
          }
        }
        if (planType === 'yield_pool') {
          let value = state.vaultBalanceForPlan != null ? parseFloat(state.vaultBalanceForPlan.value) : NaN;
          if (Number.isNaN(value)) {
            const evmAddr = state.auth?.address?.startsWith('0x') ? state.auth.address : ('0x' + (state.auth?.pubkey || ''));
            if (!evmAddr || evmAddr === '0x') {
              showToast('Unable to get wallet address', 'error');
              return;
            }
            state.loading = true;
            render();
            try {
              const headers = await getAuthHeadersAsync().catch(() => ({}));
              const resp = await fetch(`${API_BASE}/vault/balance/${encodeURIComponent(evmAddr)}`, { headers });
              if (!resp.ok) throw new Error('Vault balance request failed');
              const data = await resp.json();
              value = parseFloat(data.vault?.value || data.vault?.assets || 0);
              state.vaultBalanceForPlan = {
                value: String(data.vault?.value ?? data.vault?.assets ?? '0'),
                shares: data.vault?.shares ?? '0',
                underlying_symbol: data.vault?.underlying_symbol || 'Vault shares',
              };
            } catch (err) {
              state.loading = false;
              render();
              showToast('Failed to check pool balance: ' + (err.message || 'Please try again'), 'error');
              return;
            }
            state.loading = false;
            render();
          }
          if (value <= 0) {
            showToast('Balance is 0. Please go to Wallet → Vault to deposit.', 'error');
            return;
          }
        }
        const withoutAddress = nextList.filter((r) => !r.address || !String(r.address).trim());
        if (withoutAddress.length > 0) {
          showToast(t('recipientNoWallet'), 'error');
          return;
        }
        state.planRecipients = nextList;
        state.planStep = 'trigger-config';
      } else if (state.planStep === 'trigger-config') {
        state.planTriggerConfig.oracle = { source: 'Chainlink Oracle' };
        state.planTriggerConfig.legalAuthority.jurisdiction = document.getElementById('planLegalJurisdiction')?.value || '';
        const inactivityEl = document.getElementById('planInactivityMonths');
        if (inactivityEl) state.planTriggerConfig.inactivityMonths = parseInt(inactivityEl.value, 10) || 12;
        state.planStep = 'review';
      }
      render();
    });
  }

  // Real-time percentage input total (only update DOM, no full page re-render)
  if (!app.dataset.planPctTotalBound) {
    app.dataset.planPctTotalBound = '1';
    app.addEventListener('input', (e) => {
      if (!e.target.matches('input[name="planPct"]')) return;
      const inputs = document.querySelectorAll('input[name="planPct"]');
      let total = 0;
      inputs.forEach((inp) => {
        const v = parseInt(inp.value, 10);
        if (Number.isFinite(v) && v > 0) total += v;
      });
      const totalEl = document.getElementById('planRecipientsTotal');
      const warnEl = document.getElementById('planRecipientsTotalWarn');
      if (totalEl) totalEl.textContent = total;
      if (warnEl) warnEl.style.display = total === 100 ? 'none' : 'inline';
    });
  }

  const btnPlanSearchFirms = document.getElementById('btnPlanSearchFirms');
  if (btnPlanSearchFirms) {
    btnPlanSearchFirms.addEventListener('click', async () => {
      const jurisdiction = document.getElementById('planLegalJurisdiction')?.value || '';
      state.loading = true;
      state.error = null;
      render();
      try {
        const params = new URLSearchParams();
        if (jurisdiction) params.set('region', jurisdiction);
        const resp = await fetch(`${API_BASE}/authority/search?${params.toString()}`);
        if (resp.ok) {
          const data = await resp.json();
          state.planTriggerConfig.legalAuthority.firmSearchResults = Array.isArray(data) ? data : (data.results || []);
        } else {
          state.planTriggerConfig.legalAuthority.firmSearchResults = [];
        }
      } catch {
        state.planTriggerConfig.legalAuthority.firmSearchResults = [];
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  app.querySelectorAll('[data-action="select-plan-firm"]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.firmIndex, 10);
      const firm = state.planTriggerConfig.legalAuthority.firmSearchResults[idx];
      if (!firm) return;
      const selected = state.planTriggerConfig.legalAuthority.selectedFirms || [];
      const alreadySelected = selected.some(s => s.id === firm.id);
      if (alreadySelected) return;
      const needAuthorities = state.planTriggerTypes.legal_authority || (state.planTriggerTypes.oracle && state.planTriggerTypes.oracle_with_legal_fallback);
      const newFirm = {
        id: firm.id || firm.authority_id,
        name: firm.name || 'Unknown',
        jurisdiction: firm.jurisdiction || firm.region || '',
        publicKeyHex: firm.public_key_hex || firm.pubkey || '',
        verified: !!firm.verified,
      };
      if (needAuthorities) {
        state.planTriggerConfig.legalAuthority.selectedFirms = [newFirm];
      } else {
        state.planTriggerConfig.legalAuthority.selectedFirms = [...selected, newFirm];
      }
      render();
    });
  });

  app.querySelectorAll('[data-action="remove-plan-firm"]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.firmIndex, 10);
      state.planTriggerConfig.legalAuthority.selectedFirms.splice(idx, 1);
      render();
    });
  });

  const planReviewedCheckbox = document.getElementById('planReviewedCheckbox');
  if (planReviewedCheckbox) {
    planReviewedCheckbox.addEventListener('change', () => {
      state.planReviewed = !!planReviewedCheckbox.checked;
      render();
    });
  }
  const planMemoTextarea = document.getElementById('planMemoTextarea');
  if (planMemoTextarea) {
    planMemoTextarea.addEventListener('input', () => {
      state.planMemo = planMemoTextarea.value || '';
    });
  }

  const btnPlanSubmit = document.getElementById('btnPlanSubmit');
  if (btnPlanSubmit) {
    btnPlanSubmit.addEventListener('click', async () => {
      var memoEl = document.getElementById('planMemoTextarea');
      if (memoEl) state.planMemo = memoEl.value || '';
      const leg = state.planTriggerConfig.legalAuthority;
      const selected = leg.selectedFirms || [];
      const totalPct = state.planRecipients.reduce((s, r) => s + (Number(r.percentage) || 0), 0);
      if (totalPct !== 100) {
        showToast('Recipient percentages must total 100%', 'error');
        return;
      }
      const needAuth = state.planTriggerTypes.legal_authority || (state.planTriggerTypes.oracle && state.planTriggerTypes.oracle_with_legal_fallback);
      if (needAuth && selected.length < 1) {
        showToast('At least 1 authority is required', 'error');
        return;
      }
      if (!state.planReviewed) {
        showToast('Please confirm you have reviewed the plan', 'error');
        return;
      }
      state.planSubmitConfirmModal = true;
      render();
    });
  }

  const btnPlanSubmitConfirmGo = document.getElementById('btnPlanSubmitConfirmGo');
  if (btnPlanSubmitConfirmGo) {
    btnPlanSubmitConfirmGo.addEventListener('click', async () => {
      // Switch modal from initial to progress view (don't close)
      var initEl = document.getElementById('signModalInitial');
      var progEl = document.getElementById('signModalProgress');
      if (initEl) initEl.style.display = 'none';
      if (progEl) progEl.style.display = 'block';
      await executePlanSubmit();
    });
  }
  var btnSignModalClose = document.getElementById('btnSignModalClose');
  if (btnSignModalClose) {
    btnSignModalClose.addEventListener('click', function () {
      state.planSubmitConfirmModal = false;
      // Apply deferred navigation from signing flow
      if (state._signDeferredNav) {
        if (state._signDeferredNav.planStep) state.planStep = state._signDeferredNav.planStep;
        if (state._signDeferredNav.protectionStep) state.protectionStep = state._signDeferredNav.protectionStep;
        state._signDeferredNav = null;
      }
      render();
    });
  }

  async function executePlanSubmit() {
      const planData = {
        triggerTypes: { ...state.planTriggerTypes },
        recipients: state.planRecipients.map(r => ({ ...r })),
        triggerConfig: {
          oracle: { ...state.planTriggerConfig.oracle },
          legalAuthority: {
            jurisdiction: state.planTriggerConfig.legalAuthority.jurisdiction,
            selectedFirms: (state.planTriggerConfig.legalAuthority.selectedFirms || []).map(f => ({ id: f.id, name: f.name })),
          },
          inactivityMonths: state.planTriggerConfig.inactivityMonths,
        },
        createdAt: new Date().toISOString(),
      };
      state.savedPlan = planData;
      const btnPlanSubmit = document.getElementById('btnPlanSubmit');
      if (btnPlanSubmit) btnPlanSubmit.disabled = true;
      try {
        const headers = await getAuthHeadersAsync();
        const resp = await apiFetch(`${API_BASE}/wallet-plan`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            triggerTypes: planData.triggerTypes,
            recipients: planData.recipients,
            triggerConfig: planData.triggerConfig,
            chain_key: state.globalChainKey || 'ethereum',
            token_symbol: state.globalTokenKey || 'ETH',
          }),
        });
        if (resp.status === 401 && wallet) wallet.sessionToken = null;
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to save plan');
        }
        showToast('Plan saved', 'success');
        reportActivity('plan_created', null, null, {
          detail: (planData.recipients || []).length + ' recipients',
        });

        // If custody WASM exists and there are recipients, call the extension to generate mnemonic+passphrase for each recipient and log to server console (not minting NFT yet).
        // Note: currently each yallet_changePassphraseWithAdmin triggers an approve popup with passkey verification, so N recipients will trigger N passkey prompts.
        // To verify only once, the extension would need to support a "batch" API (unlock once, then generate mnemonics for multiple paths consecutively).
        const recipients = state.planRecipients || [];
        if (recipients.length > 0 && window.YaultWasm) {
          try {
            await window.YaultWasm.init();
            if (window.YaultWasm.custody) {
              const provider = (wallet && wallet._yalletProvider) || window.yallet;
              function normAddr(addr) {
                if (!addr || !String(addr).trim()) return '';
                return String(addr).replace(/^0x/i, '').toLowerCase();
              }
              const walletList = recipients.map(function (r) { return r.address; }).filter(Boolean);
              const inviteIdList = recipients.map(function (r) { return r.id; }).filter(Boolean);
              let recipientAddressData = { addresses: {}, inviteIdToEvm: {} };
              if (walletList.length > 0 || inviteIdList.length > 0) {
                try {
                  const headers = await getAuthHeadersAsync();
                  var qs = [];
                  if (walletList.length > 0) qs.push('wallets=' + encodeURIComponent(walletList.join(',')));
                  if (inviteIdList.length > 0) qs.push('invite_ids=' + encodeURIComponent(inviteIdList.join(',')));
                  const addrResp = await apiFetch(`${API_BASE}/wallet-plan/recipient-addresses?${qs.join('&')}`, { headers });
                  if (addrResp.ok) recipientAddressData = await addrResp.json();
                } catch (_) {}
              }
              var addresses = recipientAddressData.addresses || {};
              var inviteIdToEvm = recipientAddressData.inviteIdToEvm || {};
              var selectedFirmsForPlan = state.planTriggerConfig.legalAuthority.selectedFirms || [];
              var authorityIdForMint = (selectedFirmsForPlan.length > 0 && selectedFirmsForPlan[0].id) ? selectedFirmsForPlan[0].id : null;
              var authorityProfile = null;
              if (authorityIdForMint) {
                try {
                  const arResp = await fetch(`${API_BASE}/authority/${encodeURIComponent(authorityIdForMint)}`);
                  if (arResp.ok) authorityProfile = await arResp.json();
                } catch (_) {}
              }
              const mintResults = [];
              state.planAdminFactors = [];
              state.planMnemonicHashes = [];
              state.planMnemonics = [];
              state.planPassphrases = [];
              // Helper: update signing progress modal
              function _signProgress(idx, total, recipientLabel, status, detail) {
                var listEl = document.getElementById('signProgressList');
                var hintEl = document.getElementById('signProgressHint');
                if (!listEl) return;
                var icon = status === 'ok' ? '<span style="color:var(--success);">&#10003;</span>'
                         : status === 'fail' ? '<span style="color:var(--danger);">&#10007;</span>'
                         : '<span style="color:var(--warning);">&#9679;</span>';
                var rowId = 'signRow_' + idx;
                var existingRow = document.getElementById(rowId);
                var text = icon + ' ' + recipientLabel + (detail ? ' <span style="font-size:12px;color:var(--text-muted);">— ' + detail + '</span>' : '');
                if (existingRow) {
                  existingRow.innerHTML = text;
                } else {
                  listEl.insertAdjacentHTML('beforeend', '<div id="' + rowId + '" style="padding:4px 0;">' + text + '</div>');
                }
                if (hintEl) {
                  if (status === 'waiting') hintEl.textContent = 'Signing ' + (idx + 1) + ' of ' + total + ': please approve the passkey prompt.';
                  else if (status === 'ok') hintEl.textContent = (idx + 1) + ' of ' + total + ' done.';
                }
              }
              // Helper: switch modal to "done" state via direct DOM manipulation.
              // MUST NOT call render() here — render() rebuilds the modal HTML from
              // scratch which resets it to the initial "Continue" prompt, causing the
              // signing loop to restart.
              function _showSignModalDone(results, headerText) {
                var progEl = document.getElementById('signModalProgress');
                var doneEl = document.getElementById('signModalDone');
                var doneList = document.getElementById('signDoneList');
                if (progEl) progEl.style.display = 'none';
                if (doneEl) doneEl.style.display = 'block';
                if (doneList) {
                  doneList.innerHTML = results.map(function (mr) {
                    var rLabel = (mr.recipient.label || mr.recipient.name || 'Recipient');
                    if (mr.success) return '<div style="padding:3px 0;"><span style="color:var(--success);">&#10003;</span> ' + rLabel + '</div>';
                    return '<div style="padding:3px 0;"><span style="color:var(--danger);">&#10007;</span> ' + rLabel + ' — ' + (mr.error || 'failed') + '</div>';
                  }).join('');
                }
                if (headerText) {
                  var headerEl = doneEl ? doneEl.querySelector('h3') : null;
                  if (headerEl) { headerEl.textContent = headerText; headerEl.style.color = 'var(--warning)'; }
                }
              }
              for (let i = 0; i < recipients.length; i++) {
                const r = recipients[i];
                const label = (r.label || r.name || '').trim() || ('Recipient ' + (i + 1));
                const index = i + 1;
                _signProgress(i, recipients.length, label, 'waiting', 'generating credentials...');
                const afResult = window.YaultWasm.custody.custody_generate_admin_factor();
                if (afResult && afResult.error) {
                  _signProgress(i, recipients.length, label, 'fail', afResult.message || 'AdminFactor failed');
                  mintResults.push({ recipient: r, success: false, error: afResult.message || 'AdminFactor failed' });
                  continue;
                }
                const adminFactorHex = afResult && afResult.admin_factor_hex ? afResult.admin_factor_hex : null;
                if (!adminFactorHex) {
                  _signProgress(i, recipients.length, label, 'fail', 'No admin_factor_hex');
                  mintResults.push({ recipient: r, success: false, error: 'No admin_factor_hex' });
                  continue;
                }
                const newPassphrase = generateRandomPassphrase(12);
                let newMnemonic = null;
                _signProgress(i, recipients.length, label, 'waiting', 'waiting for passkey approval...');
                if (provider && typeof provider.request === 'function') {
                  try {
                    newMnemonic = await provider.request({
                      method: 'yallet_changePassphraseWithAdmin',
                      params: [newPassphrase, adminFactorHex],
                    });
                  } catch (e) {
                    _signProgress(i, recipients.length, label, 'fail', e.message || 'Plugin rejected');
                    mintResults.push({ recipient: r, success: false, error: e.message || 'Plugin rejected or failed' });
                    continue;
                  }
                } else {
                  _signProgress(i, recipients.length, label, 'fail', 'Yallet not connected');
                  mintResults.push({ recipient: r, success: false, error: 'Yallet not connected' });
                  continue;
                }
                _signProgress(i, recipients.length, label, 'ok', 'signed');
                try {
                  const headers = await getAuthHeadersAsync();
                  await apiFetch(`${API_BASE}/wallet-plan/admin-factor`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ recipientIndex: index, label, admin_factor_hex: adminFactorHex }),
                  });
                } catch (_) {}
                var mnemonicHashHex = '';
                try {
                  mnemonicHashHex = await hashMnemonic(newMnemonic);
                } catch (_) {}
                var evmForRecipient = (r.id && inviteIdToEvm[r.id]) ? inviteIdToEvm[r.id] : normAddr(r.address);
                if (!evmForRecipient && evmKey) evmForRecipient = evmKey;
                if (evmForRecipient && !evmForRecipient.startsWith('0x')) evmForRecipient = '0x' + evmForRecipient;
                try {
                  const headers = await getAuthHeadersAsync();
                  await apiFetch(`${API_BASE}/wallet-plan/path-credentials`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      recipientIndex: index,
                      label,
                      mnemonic: newMnemonic,
                      passphrase: newPassphrase,
                      mnemonic_hash: mnemonicHashHex,
                      evm_address: evmForRecipient,
                      admin_factor_hex: adminFactorHex,
                    }),
                  });
                } catch (_) {}
                if (mnemonicHashHex && adminFactorHex) {
                  state.planAdminFactors.push(adminFactorHex);
                  state.planMnemonicHashes.push(mnemonicHashHex);
                  state.planMnemonics.push(newMnemonic);
                  state.planPassphrases.push(newPassphrase);
                  var baseUrl = (API_BASE || '').replace(/\/api\/?$/, '') || window.location.origin;
                  var releaseLink = baseUrl + '/api/authority/AdminFactor/release?recipient_id=' + encodeURIComponent(mnemonicHashHex);
                  var selectedFirms = state.planTriggerConfig.legalAuthority.selectedFirms || [];
                  var authorityId = (selectedFirms.length > 0 && selectedFirms[0].id) ? selectedFirms[0].id : (state.planAuthorityId || 'test-authority');
                  try {
                    const headers = await getAuthHeadersAsync();
                    await apiFetch(`${API_BASE}/wallet-plan/send-release-link`, {
                      method: 'POST',
                      headers: { ...headers, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        authority_id: authorityId,
                        release_link: releaseLink,
                        recipient_id: mnemonicHashHex,
                        evm_address: evmForRecipient,
                      }),
                    });
                  } catch (_) {}
                  if (authorityProfile && authorityProfile.solana_address && authorityProfile.xidentity && window.YaultRwaSdk && typeof window.YaultRwaSdk.mintCredentialNft === 'function' && window.YAULT_RWA_CONFIG && window.YAULT_RWA_CONFIG.uploadAndMintApiUrl) {
                    try {
                      await window.YaultRwaSdk.mintCredentialNft(authorityProfile.solana_address, {
                        type: 'authority_release_link',
                        release_link: releaseLink,
                        recipient_id: mnemonicHashHex,
                        label: label,
                        index: index,
                        evm_address: evmForRecipient,
                      }, { xidentity: authorityProfile.xidentity });
                    } catch (_) {}
                  }
                }
                // No immediate cNFT mint — all credentials (mnemonic, passphrase, admin_factor)
                // are bundled into Arweave payload below and delivered only at trigger time.
                mintResults.push({
                  recipient: r,
                  success: true,
                  mintDeferred: true,
                });
              }
              state.credentialMintResults = mintResults;

              // ---------------------------------------------------------------
              // Escrow deposit: move vault shares into VaultShareEscrow BEFORE
              // uploading credentials to Arweave. This ensures shares are locked
              // before any recipient can receive their 3-factor NFT.
              // ---------------------------------------------------------------
              if (window.YaultEscrow && mintResults.some(function (mr) { return mr.success; })) {
                try {
                  var hintEl = document.getElementById('signProgressHint');
                  var headerEl = document.querySelector('#signModalProgress h3');
                  if (headerEl) headerEl.textContent = 'Securing vault shares...';
                  if (hintEl) hintEl.textContent = 'Depositing vault shares into escrow with per-recipient allocations...';

                  var escrowAuthHeaders = await getAuthHeadersAsync().catch(function () { return {}; });
                  var escrowCfg = await window.YaultEscrow.getConfig(API_BASE, { headers: escrowAuthHeaders });
                  if (escrowCfg.enabled && escrowCfg.escrowAddress && escrowCfg.vaultAddress) {
                    var ownerAddr = (state.auth?.address && state.auth.address.startsWith('0x'))
                      ? state.auth.address
                      : ('0x' + (state.auth?.pubkey || ''));
                    var escrowIndices = [];
                    var escrowWeights = [];
                    for (var ei = 0; ei < recipients.length; ei++) {
                      if (mintResults[ei] && mintResults[ei].success) {
                        escrowIndices.push(ei + 1);
                        escrowWeights.push(Number(recipients[ei].percentage) || Math.floor(100 / recipients.length));
                      }
                    }
                    if (escrowIndices.length > 0 && provider && typeof provider.request === 'function') {
                      var escrowResult = await window.YaultEscrow.depositAllToEscrow(
                        provider, escrowCfg, ownerAddr, escrowIndices, escrowWeights,
                        function (step, total, detail) {
                          if (hintEl) hintEl.textContent = '(' + step + '/' + total + ') ' + detail;
                        }
                      );
                      if (escrowResult.success) {
                        showToast('Vault shares deposited into escrow (' + escrowResult.txHashes.length + ' tx confirmed).', 'success');
                        console.log('[Plan] Escrow deposit success:', escrowResult);
                        var lastEscrowTx = escrowResult.txHashes[escrowResult.txHashes.length - 1] || null;
                        reportActivity('escrow_deposit', lastEscrowTx, escrowResult.totalShares, {
                          detail: escrowIndices.length + ' recipients',
                        });
                      } else {
                        // CRITICAL: Halt flow if escrow deposit fails.
                        // The invariant "escrow deposit ≺ credential delivery" MUST hold:
                        // if shares are not locked in escrow, we MUST NOT upload credentials
                        // to Arweave, because the recipient could use the 3 factors to
                        // access the owner's vault shares directly.
                        console.error('[Plan] Escrow deposit FAILED — halting distribution:', escrowResult.error);
                        showToast('Escrow deposit failed: ' + (escrowResult.error || 'unknown') + '. Distribution halted — shares must be locked before credentials are stored. Please retry.', 'error');
                        // Show "done" modal via DOM (do NOT call render() — it rebuilds the
                        // modal from scratch and resets to the initial "Continue" prompt,
                        // causing an infinite re-signing loop).
                        _showSignModalDone(mintResults, 'Signing complete (escrow failed)');
                        state._signDeferredNav = { planStep: 'credentials' };
                        return;
                      }
                    }
                  } else {
                    console.log('[Plan] VaultShareEscrow not configured, skipping escrow deposit.');
                  }
                } catch (escrowErr) {
                  // CRITICAL: Halt flow on escrow exception (same invariant as above).
                  console.error('[Plan] Escrow deposit exception — halting distribution:', escrowErr);
                  showToast('Escrow deposit failed: ' + (escrowErr.message || 'unknown') + '. Distribution halted — shares must be locked before credentials are stored.', 'error');
                  _showSignModalDone(mintResults, 'Signing complete (escrow failed)');
                  state._signDeferredNav = { planStep: 'credentials' };
                  return;
                }
              }

              // Update progress modal: signing done, now uploading
              (function _showArweavePhase() {
                var hintEl = document.getElementById('signProgressHint');
                var headerEl = document.querySelector('#signModalProgress h3');
                if (headerEl) headerEl.textContent = 'Storing credentials...';
                if (hintEl) hintEl.textContent = 'Signatures complete. Encrypting and uploading to Arweave...';
              })();

              // Oracle-only: encrypt AdminFactor with recipient's xidentity, construct payload in the same format as RWA SDK NFT note, store without sending; after attestation triggers, the platform POSTs to upload-and-mint so the recipient can receive the NFT.
              const isOracleOnly = planData.triggerTypes && planData.triggerTypes.oracle && !planData.triggerTypes.legal_authority;
              const collected = state.planAdminFactors && state.planMnemonicHashes && state.planAdminFactors.length === recipients.length && state.planMnemonicHashes.length === recipients.length;
              if (isOracleOnly && collected && recipients.length > 0) {
                try {
                  const authHeaders = await getAuthHeadersAsync();
                  const oracleResp = await fetch(`${API_BASE}/release/oracle-authority`, { headers: authHeaders });
                  if (oracleResp.ok) {
                    const oracleAuthority = await oracleResp.json();
                    const walletId = (state.auth?.address && state.auth.address.startsWith('0x')) ? state.auth.address : ('0x' + (state.auth?.pubkey || ''));
                    const packagesPerPath = [];
                    const hasPrepare = window.YaultRwaSdk && typeof window.YaultRwaSdk.prepareCredentialNftPayload === 'function';
                    for (let i = 0; i < state.planAdminFactors.length; i++) {
                      const r = recipients[i];
                      const label = r.label || r.name || ('Recipient ' + (i + 1));
                      const evmKey = (r.id && inviteIdToEvm[r.id]) ? inviteIdToEvm[r.id] : normAddr(r.address);
                      const addrRec = addresses[evmKey] || {};
                      const solanaAddress = addrRec.solana_address;
                      const xidentity = addrRec.xidentity;
                      if (hasPrepare && solanaAddress && xidentity) {
                        try {
                          const prepared = await window.YaultRwaSdk.prepareCredentialNftPayload(solanaAddress, {
                            admin_factor: state.planAdminFactors[i],
                            mnemonic: state.planMnemonics[i],
                            passphrase: state.planPassphrases[i],
                            index: i + 1,
                            label: label,
                            memo: (state.planMemo && state.planMemo.trim()) ? state.planMemo.trim() : undefined,
                          }, { xidentity: xidentity });
                          packagesPerPath.push({
                            index: i + 1,
                            recipient_solana_address: prepared.recipientSolanaAddress,
                            rwa_upload_body: prepared.body,
                          });
                        } catch (e) {
                          console.warn('[Plan] Oracle prepareCredentialNftPayload for recipient ' + (i + 1) + ' failed:', e);
                        }
                      }
                    }
                    const fingerprints = state.planAdminFactors.map(function (afHex) {
                      const bytes = new Uint8Array(afHex.match(/.{2}/g).map(function (b) { return parseInt(b, 16); }));
                      return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
                        return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
                      });
                    });
                    const fingerprintsResolved = await Promise.all(fingerprints);
                    if (packagesPerPath.length > 0) {
                      const paths = recipients.map((r, i) => ({
                        index: i + 1,
                        label: r.label || r.name || ('Recipient ' + (i + 1)),
                        weight: Number(r.percentage) || Math.floor(100 / recipients.length),
                        admin_factor_fingerprint: fingerprintsResolved[i],
                        recipient_mnemonic_hash: state.planMnemonicHashes[i] || undefined,
                        email: r.email || undefined,
                        recipient_evm_address: (r.address && String(r.address).trim()) ? r.address.trim() : undefined,
                        recipient_solana_address: (addresses[(r.id && inviteIdToEvm[r.id]) ? inviteIdToEvm[r.id] : normAddr(r.address)] || {}).solana_address || undefined,
                      }));
                      const configureResp = await fetch(`${API_BASE}/release/configure`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({ wallet_id: walletId, paths, trigger_type: 'oracle' }),
                      });
                      if (!configureResp.ok) {
                        const cfgErr = await configureResp.json().catch(() => ({}));
                        showToast('Failed to configure release paths: ' + (cfgErr.error || configureResp.statusText), 'error');
                      } else {
                        const distHeaders = await getAuthHeadersAsync();
                        const distResp = await fetch(`${API_BASE}/release/distribute`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', ...distHeaders },
                          body: JSON.stringify({
                            wallet_id: walletId,
                            authority_id: oracleAuthority.id,
                            encrypted_packages: packagesPerPath,
                          }),
                        });
                        if (distResp.ok) {
                          showToast('Release paths and binding configured for Oracle (per-recipient credentials stored to Arweave).', 'success');
                          // Clear sensitive credential data from memory after successful Arweave storage
                          state.planMnemonics = [];
                          state.planPassphrases = [];
                        } else {
                          const distErr = await distResp.json().catch(() => ({}));
                          showToast('Failed to distribute packages: ' + (distErr.error || distResp.statusText), 'error');
                        }
                      }
                    }
                  } else {
                    const oracleErr = await oracleResp.json().catch(() => ({}));
                    showToast('Oracle authority not available: ' + (oracleErr.error || oracleResp.statusText), 'error');
                  }
                } catch (oracleErr) {
                  console.warn('[Plan] Oracle configure+distribute failed:', oracleErr);
                  showToast('Oracle binding setup failed: ' + (oracleErr.message || 'Unknown error'), 'error');
                }
              }

              // Switch modal to "done" view — all signing + Arweave complete
              _showSignModalDone(mintResults);
              reportActivity('plan_distributed', null, null, {
                detail: mintResults.filter(function (r) { return r && r.success; }).length + ' credentials minted',
              });

              // Defer navigation — user will click "Done" on the modal to proceed
              state._signDeferredNav = { planStep: 'credentials' };
              // Don't render() here; modal is showing "done" state
              return;
            } else {
              state.protectionStep = 'overview';
              state.planStep = 'triggers';
            }
          } catch (wasmErr) {
            console.warn('[Plan] WASM credential generation failed:', wasmErr);
            state.planSubmitConfirmModal = false;
            state.protectionStep = 'overview';
            state.planStep = 'triggers';
          }
        } else {
          state.planSubmitConfirmModal = false;
          state.protectionStep = 'overview';
          state.planStep = 'triggers';
        }
      } catch (err) {
        state.planSubmitConfirmModal = false;
        showToast(err.message || 'Failed to save plan', 'error');
      } finally {
        const btn = document.getElementById('btnPlanSubmit');
        if (btn) btn.disabled = false;
        if (!state._signDeferredNav) render();
      }
  }

  const btnPlanCredentialsDone = document.getElementById('btnPlanCredentialsDone');
  if (btnPlanCredentialsDone) {
    btnPlanCredentialsDone.addEventListener('click', () => {
      state.credentialMintResults = null;
      state.planStep = 'triggers';
      state.protectionStep = 'overview';
      showToast('Done. Credentials were sent via NFT where RWA SDK was available.', 'success');
      render();
    });
  }

  const btnSimulateChainlink = document.getElementById('btnSimulateChainlink');
  if (btnSimulateChainlink) {
    btnSimulateChainlink.addEventListener('click', async () => {
      const hint = document.getElementById('chainlinkEventHint');
      btnSimulateChainlink.disabled = true;
      btnSimulateChainlink.textContent = 'Submitting...';
      if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
      try {
        const headers = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/trigger/simulate-chainlink`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || resp.statusText);
        }
        const data = await resp.json();
        const mins = data.cooldown_minutes || 10;
        btnSimulateChainlink.textContent = 'Event Triggered';
        if (hint) {
          hint.style.display = 'inline';
          hint.textContent = 'Oracle event has been triggered. Please wait ' + mins + ' minutes before claiming.';
        }
        reportActivity('simulate_chainlink', null, null, { detail: (data.triggers || []).length + ' triggers created' });
      } catch (err) {
        btnSimulateChainlink.textContent = 'Simulate Chainlink Event';
        btnSimulateChainlink.disabled = false;
        if (hint) {
          hint.style.display = 'inline';
          hint.style.color = 'var(--danger)';
          hint.textContent = 'Failed: ' + err.message;
        }
      }
    });
  }

  const btnSearchFirms = document.getElementById('btnSearchFirms');
  if (btnSearchFirms) {
    btnSearchFirms.addEventListener('click', () => {
      state.protectionStep = 'search';
      state.firmSearchResults = [];
      render();
    });
  }

  const btnBackToProtection = document.getElementById('btnBackToProtection');
  if (btnBackToProtection) {
    btnBackToProtection.addEventListener('click', () => {
      state.protectionStep = 'overview';
      render();
    });
  }

  const btnDoFirmSearch = document.getElementById('btnDoFirmSearch');
  if (btnDoFirmSearch) {
    btnDoFirmSearch.addEventListener('click', async () => {
      state.loading = true;
      state.error = null;
      render();
      try {
        const region = document.getElementById('firmSearchRegion')?.value || '';
        const language = document.getElementById('firmSearchLang')?.value || '';
        const params = new URLSearchParams();
        if (region) params.set('region', region);
        if (language) params.set('language', language);
        const resp = await fetch(`${API_BASE}/authority/search?${params.toString()}`);
        if (resp.ok) {
          const data = await resp.json();
          state.firmSearchResults = Array.isArray(data) ? data : (data.results || []);
        } else {
          state.firmSearchResults = [];
          state.error = 'Search failed.';
        }
      } catch {
        state.firmSearchResults = [];
        state.error = 'Cannot reach server.';
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  // Select firm from search results
  app.querySelectorAll('[data-action="select-firm"]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.firmIndex, 10);
      const firm = state.firmSearchResults[idx];
      if (firm && !state.selectedFirms.some(s => s.id === firm.id)) {
        state.selectedFirms.push({
          id: firm.id || firm.authority_id || ('firm-' + idx),
          name: firm.name || 'Unknown',
          jurisdiction: firm.jurisdiction || firm.region || '',
          publicKeyHex: firm.public_key_hex || firm.pubkey || '',
          verified: !!firm.verified,
        });
        showToast(`Added ${firm.name}`, 'success');
        render();
      }
    });
  });

  // Remove firm from selected
  app.querySelectorAll('[data-action="remove-firm"]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.firmIndex, 10);
      state.selectedFirms.splice(idx, 1);
      render();
    });
  });

  // Go to configure step
  const btnGoToConfigure = document.getElementById('btnGoToConfigure');
  if (btnGoToConfigure) {
    btnGoToConfigure.addEventListener('click', () => {
      state.protectionStep = 'configure';
      render();
    });
  }

  // Distribute: generate AdminFactor internally, never show to user; only send to authority
  const btnDistribute = document.getElementById('btnDistribute');
  if (btnDistribute) {
    btnDistribute.addEventListener('click', async () => {
      if (state.selectedFirms.length < 1) {
        state.error = 'Need at least 1 firm.';
        render();
        return;
      }

      // Generate AdminFactor only in memory for this request; user never sees it
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const afHex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

      state.loading = true;
      state.error = null;
      render();

      try {
        const authHeaders = await getAuthHeadersAsync();
        const resp = await apiFetch(`${API_BASE}/release/prepare-distribute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            admin_factor_hex: afHex,
            firms: state.selectedFirms.map(f => ({
              id: f.id,
              name: f.name,
              public_key_hex: f.publicKeyHex,
            })),
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Distribution failed');

        state.distributionResult = { ...data, shares: data.packages || data.shares || [] };
        const fingerprint = data.fingerprint; // used only for backend/paths, not shown to user
        const packages = data.packages || data.shares || [];
        const walletId = state.auth?.address || '';
        if (!walletId) throw new Error('Not authenticated');

        const plan = state.planForConfigure;
        const usePlanRecipients = state.planRecipients && state.planRecipients.length > 0;
        const paths = usePlanRecipients
          ? state.planRecipients.map((r, i) => ({
              index: i + 1,
              label: r.label || r.name || ('Recipient ' + (i + 1)),
              weight: Number(r.percentage) || Math.floor(100 / state.planRecipients.length),
              admin_factor_fingerprint: fingerprint,
              email: r.email || undefined,
              recipient_evm_address: (r.address && r.address.trim()) ? r.address.trim() : undefined,
            }))
          : state.selectedFirms.map((f, i) => {
              const pathWeight = Math.floor(100 / state.selectedFirms.length) || 1;
              return {
                index: i + 1,
                label: f.name || f.id || ('Authority ' + (i + 1)),
                weight: i < state.selectedFirms.length - 1 ? pathWeight : (100 - pathWeight * (state.selectedFirms.length - 1)),
                admin_factor_fingerprint: fingerprint,
              };
            });

        const body = {
          wallet_id: walletId,
          paths,
          trigger_type: plan?.triggerType || 'legal_event',
          authority_id: state.selectedFirms[0]?.id,
        };
        if (plan?.triggerType === 'activity_drand' && plan.tlockMonths) {
          body.tlock_duration_months = plan.tlockMonths;
        }
        if (plan?.triggerType === 'oracle' && plan.oracleInfo) {
          body.oracle_info = plan.oracleInfo;
        }
        const configureResp = await fetch(`${API_BASE}/release/configure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify(body),
        });
        if (!configureResp.ok) {
          const errBody = await configureResp.json().catch(() => ({}));
          throw new Error(errBody.error || 'Release configure failed');
        }

        for (const firm of state.selectedFirms) {
          const p = packages.find(s => (s.authorityId || s.authority_id) === firm.id);
          if (!p) continue;
          const pkg = {
            index: 1,
            package_hex: p.packageHex ?? p.package_hex,
            ephemeral_pubkey_hex: p.ephemeralPubkeyHex ?? p.ephemeral_pubkey_hex ?? '',
          };
          const distResp = await fetch(`${API_BASE}/release/distribute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({
              wallet_id: walletId,
              authority_id: firm.id,
              encrypted_packages: [pkg],
            }),
          });
          if (!distResp.ok) {
            const errBody = await distResp.json().catch(() => ({}));
            console.warn('Release distribute for ' + firm.id + ' failed:', errBody.error);
          }
        }

        state.protectionStep = 'distribute';
        state.planRecipients = [];
        state.planForConfigure = null;
        await loadBoundFirms();
        showToast('Protection set up; bindings created', 'success');
      } catch (err) {
        state.error = 'Distribution failed: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  // ── Accounts page events ──

  const btnAccountsSendInvite = document.getElementById('btnAccountsSendInvite');
  if (btnAccountsSendInvite) {
    btnAccountsSendInvite.addEventListener('click', async () => {
      const email = (document.getElementById('accountsInviteEmailInput')?.value || '').trim().toLowerCase();
      if (!email) {
        showToast('Please enter an email address', 'error');
        return;
      }
      if (state.relatedAccountsInvites.some(i => i.email === email) || state.relatedAccounts.some(a => a.email === email)) {
        showToast('This email is already invited or linked', 'error');
        return;
      }
      btnAccountsSendInvite.disabled = true;
      try {
        const headers = await getAuthHeadersAsync();
        const resp = await apiFetch(`${API_BASE}/account-invites`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, is_sub_account: !!(document.getElementById('accountsInviteSubAccount')?.checked) }),
        });
        if (resp.status === 401 && wallet) wallet.sessionToken = null;
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to send invitation');
        }
        const created = await resp.json();
        state.relatedAccountsInvites.push({ id: created.id, email: created.email, status: 'pending', label: created.label });
        state.accountsInviteEmail = '';
        showToast('Invitation sent to ' + email, 'success');
      } catch (err) {
        showToast(err.message || 'Failed to send invitation', 'error');
      } finally {
        btnAccountsSendInvite.disabled = false;
        render();
      }
    });
  }

  app.querySelectorAll('[data-action="accounts-accept-invite"]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = (el.dataset.id || '').trim();
      const email = (el.dataset.email || '').trim();
      if (!id) {
        showToast('Cannot accept: missing invite id', 'error');
        return;
      }
      el.disabled = true;
      try {
        const headers = await getAuthHeadersAsync();
        const resp = await apiFetch(`${API_BASE}/account-invites/${encodeURIComponent(id)}/accept`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (resp.status === 401 && wallet) wallet.sessionToken = null;
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to accept');
        }
        await loadAccountInvites();
        showToast('Account added (demo)', 'success');
      } catch (err) {
        showToast(err.message || 'Failed to accept', 'error');
      } finally {
        render();
      }
    });
  });

  app.querySelectorAll('[data-action="accounts-transfer"]').forEach((el) => {
    el.addEventListener('click', () => {
      const index = parseInt(el.dataset.index, 10);
      if (!Number.isFinite(index) || index < 0 || index >= state.relatedAccounts.length) return;
      state.accountsTransferTarget = index;
      state.accountsTransferToken = 'ETH';
      state.accountsTransferAmount = '';
      render();
    });
  });

  const btnAccountsTransferBack = document.getElementById('btnAccountsTransferBack');
  if (btnAccountsTransferBack) {
    btnAccountsTransferBack.addEventListener('click', () => {
      state.accountsTransferTarget = null;
      state.accountsTransferAmount = '';
      render();
    });
  }

  const btnAccountsTransferSubmit = document.getElementById('btnAccountsTransferSubmit');
  if (btnAccountsTransferSubmit) {
    btnAccountsTransferSubmit.addEventListener('click', () => {
      const token = document.getElementById('accountsTransferTokenSelect')?.value || 'ETH';
      const amount = (document.getElementById('accountsTransferAmountInput')?.value || '').trim();
      if (!amount || Number.isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        showToast('Please enter a valid amount', 'error');
        return;
      }
      state.accountsTransferToken = token;
      state.accountsTransferAmount = amount;
      const target = state.relatedAccounts[state.accountsTransferTarget];
      showToast(`Transfer of ${amount} ${token} to ${target ? (target.label || target.email) : 'account'} (stub — connect wallet to sign in production)`, 'success');
      state.accountsTransferTarget = null;
      state.accountsTransferAmount = '';
      render();
    });
  }

  // ── Wallet page events ──

  // Wallet left sidebar section switching (Balances / Send / Vault / Deniable Accounts)
  app.querySelectorAll('[data-wallet-section]').forEach((el) => {
    el.addEventListener('click', () => {
      state.walletSection = el.dataset.walletSection;
      if (state.walletSection === 'send') state.sendForm.chain = state.globalChainKey;
      render();
      // Fetch balances when switching to Balances or Vault, making the /vault/balance request visible in the Network tab
      if (state.walletSection === 'balances' || state.walletSection === 'vault') {
        refreshWalletBalances().then(() => {
          if (state.page === 'wallet' && (state.walletSection === 'balances' || state.walletSection === 'vault')) render();
        });
      }
    });
  });

  // Refresh Activities button
  var btnRefreshAct = document.getElementById('btnRefreshActivities');
  if (btnRefreshAct) {
    btnRefreshAct.addEventListener('click', function () {
      loadActivities();
    });
  }

  // Accounts left sidebar (Accounts / Invite)
  app.querySelectorAll('[data-accounts-section]').forEach((el) => {
    el.addEventListener('click', () => {
      state.accountsSection = el.dataset.accountsSection;
      render();
    });
  });

  // Settings left sidebar (Connected Wallet / Account / KYC)
  app.querySelectorAll('[data-settings-section]').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.settingsSection;
      render();
    });
  });

  // Profile (Client): View / Edit mode
  app.querySelectorAll('[data-action="client-profile-edit"]').forEach((el) => {
    el.addEventListener('click', () => {
      state.profileEditMode = true;
      render();
    });
  });
  app.querySelectorAll('[data-action="client-profile-cancel"]').forEach((el) => {
    el.addEventListener('click', () => {
      state.profileEditMode = false;
      render();
    });
  });
  app.querySelectorAll('[data-action="client-profile-save"]').forEach((el) => {
    el.addEventListener('click', async () => {
      const name = document.getElementById('clientProfileName')?.value?.trim() || '';
      const email = document.getElementById('clientProfileEmail')?.value?.trim() || '';
      const phone = document.getElementById('clientProfilePhone')?.value?.trim() || '';
      const physical_address = document.getElementById('clientProfileAddress')?.value?.trim() || '';
      try {
        const headers = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/me/profile`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ name, email, phone, physical_address }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Save failed');
        }
        state.clientProfile = await resp.json();
        state.profileEditMode = false;
        showToast('Profile saved', 'success');
        render();
      } catch (err) {
        showToast(err.message || 'Save failed', 'error');
      }
    });
  });

  // Claim left sidebar (Claims / Redeem)
  app.querySelectorAll('[data-claim-section]').forEach((el) => {
    el.addEventListener('click', async () => {
      state.claimSection = el.dataset.claimSection;
      if (state.claimSection === 'redeem') {
        await loadRedeemUserTokens(state.redeemChain);
        try {
          const headers = await getAuthHeadersAsync();
          const r = await apiFetch(API_BASE + '/me/addresses', { headers });
          if (r.ok) {
            const d = await r.json();
            const addr = d.addresses;
            if (addr) {
              const ch = state.redeemChain;
              if (ch === 'bitcoin') state.redeemToAddress = addr.bitcoin_address || addr.btc_address || '';
              else if (ch === 'solana') state.redeemToAddress = addr.solana_address || '';
              else state.redeemToAddress = addr.evm_address || '';
            }
          }
        } catch (_) {}
        render();
      } else {
        render();
      }
    });
  });

  // Wallet address chain dropdown: switch selected chain/address and re-render
  const walletAddressChainSelect = document.getElementById('walletAddressChainSelect');
  if (walletAddressChainSelect) {
    walletAddressChainSelect.addEventListener('change', () => {
      const key = walletAddressChainSelect.value;
      const opt = WALLET_CHAIN_OPTIONS.find((o) => o.key === key);
      state.walletSelectedChain = key;
      state.walletSelectedAddress = (opt && state.walletAddresses && state.walletAddresses[opt.addrKey]) ? String(state.walletAddresses[opt.addrKey]).trim() : '';
      render();
    });
  }

  // Refresh balances
  const btnRefresh = document.getElementById('btnRefreshBalances');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      refreshWalletBalances();
      showToast('Refreshing balances...', 'success');
    });
  }

  // Deniable accounts — toggle add form
  const btnToggleAdd = document.getElementById('btnToggleAddDeniable');
  if (btnToggleAdd) {
    btnToggleAdd.addEventListener('click', () => {
      state.showAddDeniable = !state.showAddDeniable;
      render();
    });
  }

  // Deniable accounts — derive via Yallet
  const btnDerive = document.getElementById('btnDeriveDeniable');
  if (btnDerive) {
    btnDerive.addEventListener('click', async () => {
      const context = (document.getElementById('newDeniableContextInput')?.value || '').trim();
      const label = (document.getElementById('newDeniableLabelInput')?.value || '').trim();
      if (!context) {
        state.error = 'Context string is required.';
        render();
        return;
      }
      // Check if already derived
      if (state.deniableAccounts.some(a => a.context === context)) {
        state.error = 'This context already exists in your session.';
        render();
        return;
      }
      state.loading = true;
      state.error = null;
      render();
      try {
        // Call Yallet extension to derive 7 context-isolated addresses
        const provider = window.yallet;
        if (!provider) throw new Error('Yallet extension not detected');
        const result = await provider.request({
          method: 'yallet_deriveContextAddresses',
          params: [{ context }],
        });
        // result is a JSON string of addresses (from approve.js signedData channel)
        const addresses = typeof result === 'string' ? JSON.parse(result) : result;
        state.deniableAccounts.push({ context, label, addresses });
        state.newDeniableContext = '';
        state.newDeniableLabel = '';
        state.showAddDeniable = false;
        showToast(`Vault "${label || context}" derived`, 'success');
      } catch (err) {
        state.error = 'Derivation failed: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  // Deniable accounts — remove
  app.querySelectorAll('[data-action="remove-deniable"]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.deniableIndex, 10);
      state.deniableAccounts.splice(idx, 1);
      render();
    });
  });

  // Deniable accounts — query balance
  app.querySelectorAll('[data-action="query-deniable-balance"]').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = parseInt(el.dataset.deniableIndex, 10);
      const acct = state.deniableAccounts[idx];
      if (!acct) return;
      try {
        const evmAddr = acct.addresses?.evm_address || '';
        if (!evmAddr) throw new Error('No EVM address');
        const headers = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await fetch(`${API_BASE}/vault/balance/${encodeURIComponent(evmAddr)}`, { headers });
        if (resp.ok) {
          const data = await resp.json();
          acct.balances = {
            eth: data.wallet?.eth || '0.00',
            sol: data.wallet?.sol || '0.00',
            btc: data.wallet?.btc || '0.00',
          };
          render();
        }
      } catch (err) {
        showToast('Balance query failed: ' + err.message, 'error');
      }
    });
  });

  // Deniable accounts — send (sign with context)
  app.querySelectorAll('[data-action="send-from-deniable"]').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = parseInt(el.dataset.deniableIndex, 10);
      const acct = state.deniableAccounts[idx];
      if (!acct) return;
      const to = prompt('Recipient address:');
      if (!to) return;
      const amount = prompt('Amount (ETH):');
      if (!amount) return;
      try {
        const provider = window.yallet;
        if (!provider) throw new Error('Yallet extension not detected');
        // Use personal_sign with context param to sign with the deniable key
        const msg = `Send ${amount} ETH to ${to} from vault ${acct.context}`;
        const sig = await provider.request({
          method: 'personal_sign',
          params: [msg, acct.addresses?.evm_address, { context: acct.context }],
        });
        showToast(`Signed (stub): ${sig.substring(0, 20)}...`, 'success');
      } catch (err) {
        showToast('Send failed: ' + err.message, 'error');
      }
    });
  });

  // Transfer: dropdown "Send to account" fills recipient address for current chain
  const walletSendToAccount = document.getElementById('walletSendToAccount');
  if (walletSendToAccount) {
    walletSendToAccount.addEventListener('change', function () {
      var idx = parseInt(this.value, 10);
      state.sendForm.selectedAccountIndex = (Number.isFinite(idx) && idx >= 0) ? idx : null;
      var related = state.relatedAccounts || [];
      var addr = state.sendForm.selectedAccountIndex != null && related[state.sendForm.selectedAccountIndex]
        ? getAddressForChain(related[state.sendForm.selectedAccountIndex], state.globalChainKey || 'ethereum')
        : '';
      state.sendForm.to = addr;
      var input = document.getElementById('walletSendTo');
      if (input) input.value = addr;
    });
  }
  var walletSendToInput = document.getElementById('walletSendTo');
  if (walletSendToInput) {
    walletSendToInput.addEventListener('input', function () {
      state.sendForm.to = (this.value || '').trim();
      state.sendForm.selectedAccountIndex = null;
    });
  }

  // Send from wallet — signed via Yallet extension
  const btnWalletSend = document.getElementById('btnWalletSend');
  if (btnWalletSend) {
    btnWalletSend.addEventListener('click', async () => {
      const to = (document.getElementById('walletSendTo')?.value || '').trim();
      const amount = (document.getElementById('walletSendAmount')?.value || '').trim();
      const chain = document.getElementById('walletSendChain')?.value || state.globalChainKey || 'ethereum';
      if (!to || !amount) {
        state.error = 'Recipient and amount are required.';
        render();
        return;
      }
      state.loading = true;
      state.error = null;
      render();
      try {
        // Sign via Yallet extension
        if (wallet && wallet.signMessage) {
          const txMsg = `Send ${amount} ${chain.toUpperCase()} to ${to}`;
          await wallet.signMessage(txMsg);
        }
        // Stub: in production, broadcast signed tx
        await new Promise((r) => setTimeout(r, 500));
        showToast(`Sent ${amount} on ${chain} (stub — signed via Yallet)`, 'success');
        state.sendForm = { to: '', amount: '', chain };
        refreshWalletBalances();
      } catch (err) {
        state.error = 'Send failed: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  // Deposit to vault
  const btnDeposit = document.getElementById('btnDepositToVault');
  if (btnDeposit) {
    btnDeposit.addEventListener('click', async () => {
      const amount = (document.getElementById('depositToVaultAmount')?.value || '').trim();
      if (!amount || (amount !== 'max' && (isNaN(Number(amount)) || Number(amount) <= 0))) {
        state.error = 'Enter a valid deposit amount.';
        render();
        return;
      }
      state.vaultAction = 'deposit';
      state.vaultAmount = amount;
      state.vaultDepositLoading = true;
      state.error = null;
      render();
      try {
        const addr = state.auth?.address || '';
        const authHeaders = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/vault/deposit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ address: addr, amount, asset: state.vaultUnderlyingSymbol || 'USDC' }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Deposit failed');
        if (data.status === 'pending_signature' && data.transaction) {
          // Underlying asset must be approved for Vault first, else deposit reverts (ERC20: transfer amount exceeds allowance)
          if (data.asset_address) {
            const decimals = typeof data.underlying_decimals === 'number' ? data.underlying_decimals : 6;
            const amountWei = parseUnits(amount, decimals);
            const vaultAddress = data.transaction.to ? (data.transaction.to.startsWith('0x') ? data.transaction.to : '0x' + data.transaction.to) : null;
            if (vaultAddress) {
              // Check existing allowance — skip approve if sufficient (same pattern as yault-escrow.js)
              let needApprove = true;
              const rpcUrl = (typeof EVM_RPC_URL !== 'undefined' && EVM_RPC_URL) || 'https://ethereum-sepolia-rpc.publicnode.com';
              try {
                const tokenAddr = data.asset_address.startsWith('0x') ? data.asset_address : '0x' + data.asset_address;
                const currentAllowance = await checkAllowanceRaw(rpcUrl, tokenAddr, addr, vaultAddress);
                if (currentAllowance >= BigInt(amountWei)) {
                  needApprove = false;
                  console.log('[deposit] Allowance sufficient (' + currentAllowance.toString() + '), skipping approve');
                }
              } catch (e) {
                console.warn('[deposit] allowance check failed, will approve:', e.message);
              }
              if (needApprove) {
                showToast('Approve token for Vault (confirm in wallet).', 'info');
                // Use max approval (type(uint256).max) so subsequent deposits skip approve
                const MAX_UINT256 = (2n ** 256n) - 1n;
                const approveTx = {
                  to: data.asset_address.startsWith('0x') ? data.asset_address : '0x' + data.asset_address,
                  data: encodeApproveCalldata(vaultAddress, MAX_UINT256),
                  value: '0x0',
                  chainId: data.transaction.chainId || 1,
                  gasLimit: '0x186a0',
                };
                const approveHash = await sendTransactionInWallet(approveTx, addr);
                // Wait for approve to be mined before sending deposit (prevents race condition)
                showToast('Waiting for approval to confirm...', 'info');
                await waitForTxReceipt(rpcUrl, approveHash, 120000);
              }
            }
          }
          showToast('Confirm deposit in the Yallet window.', 'info');
          const txHash = await sendTransactionInWallet(data.transaction, addr);
          const chainId = data.transaction.chainId || 1;
          const explorerUrl = getExplorerTxUrl(chainId, txHash);
          const explorerName = getExplorerName(chainId);
          const existing = document.querySelector('.toast');
          if (existing) existing.remove();
          const toast = document.createElement('div');
          toast.className = 'toast toast-success';
          toast.innerHTML = 'Transaction submitted (' + explorerName + '). <a href="' + explorerUrl + '" target="_blank" rel="noopener">View on block explorer</a>';
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 10000);
          state.vaultAmount = '';
          reportActivity('deposit', txHash, amount);
          refreshWalletBalances();
          setTimeout(function () { refreshWalletBalances(); setTimeout(refreshWalletBalances, 5000); }, 3000);
        } else {
          showToast(`Deposited ${amount} → Vault`, 'success');
          state.vaultAmount = '';
          refreshWalletBalances();
        }
      } catch (err) {
        const msg = err?.message || String(err);
        state.error = 'Deposit failed: ' + msg;
      } finally {
        state.vaultDepositLoading = false;
        render();
      }
    });
  }

  // Redeem from vault → wallet
  const btnRedeem = document.getElementById('btnRedeemFromVault');
  if (btnRedeem) {
    btnRedeem.addEventListener('click', async () => {
      const amount = (document.getElementById('redeemFromVaultAmount')?.value || '').trim();
      if (!amount || (amount !== 'max' && (isNaN(Number(amount)) || Number(amount) <= 0))) {
        state.error = 'Enter a valid number of shares to redeem.';
        render();
        return;
      }
      const currentShares = parseFloat(state.vaultBalances?.shares || '0');
      if (amount !== 'max' && Number(amount) > currentShares) {
        state.error = `You only have ${formatVaultShares(String(currentShares))} shares. Enter a smaller amount or "max".`;
        render();
        return;
      }
      state.vaultAction = 'redeem';
      state.vaultAmount = amount;
      state.vaultRedeemLoading = true;
      state.error = null;
      render();
      try {
        const addr = state.auth?.address || '';
        const authHeaders = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/vault/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ address: addr, shares: amount }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Redeem failed');
        if (data.status === 'pending_signature' && data.transaction) {
          showToast('Confirm in the Yallet window.', 'info');
          const txHash = await sendTransactionInWallet(data.transaction, addr);
          const chainId = data.transaction.chainId || 1;
          const explorerUrl = getExplorerTxUrl(chainId, txHash);
          const explorerName = getExplorerName(chainId);
          const existing = document.querySelector('.toast');
          if (existing) existing.remove();
          const toast = document.createElement('div');
          toast.className = 'toast toast-success';
          toast.innerHTML = `Redeemed ${esc(amount)} shares → Wallet (${explorerName}). <a href="${explorerUrl}" target="_blank" rel="noopener">View on block explorer</a>`;
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 10000);
          state.vaultAmount = '';
          reportActivity('redeem', txHash, amount, { shares: amount });
          refreshWalletBalances();
          setTimeout(function () { refreshWalletBalances(); setTimeout(refreshWalletBalances, 5000); }, 3000);
        } else {
          showToast(`Redeemed ${amount} shares → Wallet`, 'success');
          state.vaultAmount = '';
          refreshWalletBalances();
        }
      } catch (err) {
        state.error = 'Redeem failed: ' + err.message;
      } finally {
        state.vaultRedeemLoading = false;
        render();
      }
    });
  }

  // Refresh vault balance (from chain)
  const btnRefreshVaultBalance = document.getElementById('btnRefreshVaultBalance');
  if (btnRefreshVaultBalance) {
    btnRefreshVaultBalance.addEventListener('click', async () => {
      btnRefreshVaultBalance.disabled = true;
      await refreshWalletBalances();
      btnRefreshVaultBalance.disabled = false;
      render();
    });
  }

  // Harvest yield
  const btnHarvest = document.getElementById('btnHarvestYield');
  if (btnHarvest) {
    btnHarvest.addEventListener('click', async () => {
      state.vaultHarvestLoading = true;
      state.error = null;
      render();
      try {
        const addr = state.auth?.address || '';
        const authHeaders = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/vault/harvest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ address: addr }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Harvest failed');
        if (data.status === 'pending_signature' && data.transaction) {
          showToast('Please confirm the transaction in the Yallet extension popup or sidebar. If it did not appear, click the Yallet icon in the browser toolbar.', 'info');
          const txHash = await sendTransactionInWallet(data.transaction, addr);
          const chainId = data.transaction.chainId || 1;
          const explorerUrl = getExplorerTxUrl(chainId, txHash);
          const explorerName = getExplorerName(chainId);
          const existing = document.querySelector('.toast');
          if (existing) existing.remove();
          const toast = document.createElement('div');
          toast.className = 'toast toast-success';
          toast.innerHTML = 'Transaction submitted (' + explorerName + '). <a href="' + explorerUrl + '" target="_blank" rel="noopener">View on block explorer</a>';
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 10000);
          reportActivity('harvest', txHash, null);
          refreshWalletBalances();
        } else {
          showToast(`Harvested yield: ${data.harvested || '0'}`, 'success');
          refreshWalletBalances();
        }
      } catch (err) {
        state.error = 'Harvest failed: ' + err.message;
      } finally {
        state.vaultHarvestLoading = false;
        render();
      }
    });
  }

  // Simulate yield (testnet: inject WETH into vault)
  const btnSimulate = document.getElementById('btnSimulateYield');
  if (btnSimulate) {
    btnSimulate.addEventListener('click', async () => {
      state.vaultSimulateLoading = true;
      state.error = null;
      render();
      try {
        const addr = state.auth?.address || '';
        const authHeaders = await getAuthHeadersAsync().catch(() => ({}));
        const resp = await apiFetch(`${API_BASE}/vault/simulate-yield`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ address: addr }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Simulation failed');
        showToast(`Simulated ${data.amount} ${data.symbol || 'WETH'} yield injected. Refreshing...`, 'success');
        await refreshWalletBalances();
      } catch (err) {
        state.error = 'Simulate yield failed: ' + err.message;
      } finally {
        state.vaultSimulateLoading = false;
        render();
      }
    });
  }

  // Reclaim from escrow (return locked shares to wallet)
  const btnReclaim = document.getElementById('btnReclaimEscrow');
  if (btnReclaim) {
    btnReclaim.addEventListener('click', async () => {
      const provider = window.yallet;
      if (!provider || typeof provider.request !== 'function') {
        state.error = 'Yallet wallet not detected. Please connect Yallet first.';
        render();
        return;
      }
      const indices = state.escrowBalances.recipient_indices || [];
      if (indices.length === 0) {
        state.error = 'No recipient indices found — cannot determine which allocations to reclaim';
        render();
        return;
      }
      state.vaultReclaimLoading = true;
      state.error = null;
      render();
      try {
        const authHeaders = await getAuthHeadersAsync().catch(() => ({}));
        const escrowCfg = await window.YaultEscrow.getConfig(API_BASE, { headers: authHeaders });
        if (!escrowCfg.enabled || !escrowCfg.escrowAddress) {
          throw new Error('Escrow not configured');
        }
        const ownerAddr = (state.auth?.address && state.auth.address.startsWith('0x'))
          ? state.auth.address
          : ('0x' + (state.auth?.pubkey || ''));
        const result = await window.YaultEscrow.reclaimAllFromEscrow(
          provider, escrowCfg, ownerAddr, indices,
          function (step, total, detail) {
            var btn = document.getElementById('btnReclaimEscrow');
            if (btn) btn.textContent = '(' + step + '/' + total + ') ' + detail;
          }
        );
        if (result.success && result.reclaimedCount > 0) {
          showToast('Reclaimed shares from ' + result.reclaimedCount + ' recipient(s). Refreshing...', 'success');
          reportActivity('escrow_reclaim', result.txHashes[result.txHashes.length - 1] || null, null, {
            detail: result.reclaimedCount + ' recipients reclaimed',
          });
        } else if (result.success && result.reclaimedCount === 0) {
          showToast('No remaining shares to reclaim.', 'info');
        } else {
          throw new Error(result.error || 'Reclaim failed');
        }
        await refreshWalletBalances();
      } catch (err) {
        state.error = 'Reclaim failed: ' + err.message;
      } finally {
        state.vaultReclaimLoading = false;
        render();
      }
    });
  }

  // ── Claim flow events ──

  // Load my releases (GET /api/claim/me) — no Wallet ID or Path index from user
  const btnClaimLoadMe = document.getElementById('btnClaimLoadMe');
  if (btnClaimLoadMe) {
    btnClaimLoadMe.addEventListener('click', async () => {
      state.error = null;
      state.loading = true;
      state.claimMeItems = [];
      state.selectedClaimItem = null;
      render();
      await loadClaimMe();
      state.loading = false;
      render();
    });
  }
  // Plan releases: Load my releases (same as above, refreshes claimPlanReleases too)
  const btnClaimLoadMePlan = document.getElementById('btnClaimLoadMePlan');
  if (btnClaimLoadMePlan) {
    btnClaimLoadMePlan.addEventListener('click', async () => {
      state.error = null;
      state.loading = true;
      render();
      await loadClaimMe();
      state.loading = false;
      render();
    });
  }
  // "Use" button for releases → fill AdminFactor field + set walletId/pathIndex
  document.querySelectorAll('.btn-use-release-af').forEach((btn) => {
    btn.addEventListener('click', () => {
      const af = btn.getAttribute('data-release-af') || '';
      if (af) {
        const afInput = document.getElementById('claimAdminFactor');
        if (afInput) afInput.value = af;
        state.releaseKey = af;
        // Find matching item from claimMeItems to set walletId/pathIndex
        const match = (state.claimMeItems || []).find(it =>
          (it.blob_hex === af || it.admin_factor_hex === af)
        );
        if (match) {
          state.walletId = match.wallet_id || '';
          state.pathIndex = match.path_index || 1;
        }
      }
    });
  });
  // Redeem tab: restore cached wallet from session (so chain change can fill From address)
  if (state.redeemWalletJson == null) {
    try {
      const raw = sessionStorage.getItem('redeemWalletJson');
      if (raw) state.redeemWalletJson = JSON.parse(raw);
    } catch (_) {}
  }
  function getRedeemFromAddressForChain(wallet, chainKey) {
    if (!wallet || !chainKey) return '';
    const w = wallet;
    if (chainKey === 'bitcoin') return w.bitcoin_address || w.btc_address || '';
    if (chainKey === 'solana') return w.solana_address || '';
    return w.evm_address || '';
  }
  function setRedeemFromAddressFromWallet() {
    const fromInput = document.getElementById('redeemFromAddress');
    if (!fromInput) return;
    const w = state.redeemWalletJson;
    if (!w) {
      fromInput.value = '';
      return;
    }
    const addr = getRedeemFromAddressForChain(w, state.redeemChain);
    fromInput.value = addr || '';
    // TODO: get balance for this address on selected chain/token
  }
  // Redeem tab: chain change -> load user tokens + set To default + set From from cached wallet
  const redeemChainSel = document.getElementById('redeemChain');
  if (redeemChainSel) {
    redeemChainSel.addEventListener('change', async () => {
      state.redeemChain = redeemChainSel.value;
      await loadRedeemUserTokens(state.redeemChain);
      const toInput = document.getElementById('redeemToAddress');
      if (toInput) {
        try {
          const headers = await getAuthHeadersAsync();
          const r = await apiFetch(API_BASE + '/me/addresses', { headers });
          if (r.ok) {
            const d = await r.json();
            const addr = d.addresses;
            if (addr) {
              const ch = redeemChainSel.value;
              const chainInfo = REDEEM_CHAINS.find((x) => x.key === ch);
              if (ch === 'bitcoin' && (addr.bitcoin_address || addr.btc_address)) toInput.value = addr.bitcoin_address || addr.btc_address || '';
              else if (ch === 'solana' && addr.solana_address) toInput.value = addr.solana_address;
              else if (chainInfo && chainInfo.chainId && addr.evm_address) toInput.value = addr.evm_address;
              else toInput.value = '';
              state.redeemToAddress = toInput.value;
            }
          }
        } catch (_) {}
      }
      setRedeemFromAddressFromWallet();
      render();
    });
  }
  // Redeem tab: Fetch button — (newMnemonic, userPassphrase, AdminFactor) → wallet-1 addresses.
  // Must use view_wallet_unified_with_secondary_wasm (acegf): it tries legacy unseal first, then REV32.
  // newMnemonic from extension yallet_changePassphraseWithAdmin is legacy format (sealed UUID); using
  // view_wallet_rev32_with_secondary_wasm would treat ciphertext as REV32 and yield wrong addresses.
  const btnRedeemFetch = document.getElementById('btnRedeemFetch');
  if (btnRedeemFetch) {
    btnRedeemFetch.addEventListener('click', async () => {
      const mnemonic = (document.getElementById('redeemMnemonic')?.value || '').trim();
      const passphrase = (document.getElementById('redeemPassphrase')?.value || '').trim();
      const adminFactor = (document.getElementById('redeemAdminFactor')?.value || '').trim();
      if (!mnemonic || !passphrase || !adminFactor) {
        alert('Please fill Mnemonic, Passphrase and AdminFactor.');
        return;
      }
      try {
        if (!window.YaultWasm || typeof window.YaultWasm.init !== 'function') {
          alert('WASM not loaded. Ensure acegf is available.');
          return;
        }
        await window.YaultWasm.init();
        if (!window.YaultWasm.acegf || typeof window.YaultWasm.acegf.view_wallet_unified_with_secondary_wasm !== 'function') {
          alert('acegf.view_wallet_unified_with_secondary_wasm not found. Redeem requires unified view (legacy-first) for mnemonics from Yallet change_passphrase_add_admin.');
          return;
        }
        const walletJs = window.YaultWasm.acegf.view_wallet_unified_with_secondary_wasm(mnemonic, passphrase, adminFactor || undefined);
        const walletJson = walletJs != null && typeof walletJs === 'object' ? walletJs : JSON.parse(JSON.stringify(walletJs));
        const mnemonicHash = await hashMnemonic(mnemonic);
        // Submit using the currently logged-in evm_address, not the view wallet derived result (they usually differ: the derived one is the path's wallet-1)
        const currentUserEvm = (state.auth && (state.auth.address || state.auth.pubkey)) ? String(state.auth.address || state.auth.pubkey).trim() : '';
        if (!currentUserEvm) {
          alert('Not logged in. Please connect and sign in first.');
          return;
        }
        const headers = await getAuthHeadersAsync();
        const r = await apiFetch(API_BASE + '/claim/update-wallet-json', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ evm_address: currentUserEvm, mnemonic_hash: mnemonicHash, wallet_json: walletJson }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(err.error || 'Failed to update wallet json');
          return;
        }
        state.redeemWalletJson = walletJson;
        try {
          sessionStorage.setItem('redeemWalletJson', JSON.stringify(walletJson));
        } catch (_) {}
        setRedeemFromAddressFromWallet();
        render();
      } catch (e) {
        alert(e.message || e.toString() || 'Fetch failed');
      }
    });
  }
  setRedeemFromAddressFromWallet();
  // Redeem tab: Token dropdown — "Add New Token Address" opens dialog
  const redeemTokenSel = document.getElementById('redeemToken');
  if (redeemTokenSel) {
    redeemTokenSel.addEventListener('change', () => {
      if (redeemTokenSel.value === '__add_new__') {
        document.getElementById('addTokenDialog')?.classList.remove('hidden');
        document.getElementById('addTokenName').value = '';
        document.getElementById('addTokenContract').value = '';
      }
    });
  }
  const btnAddTokenDialogClose = document.getElementById('btnAddTokenDialogClose');
  if (btnAddTokenDialogClose) {
    btnAddTokenDialogClose.addEventListener('click', () => {
      document.getElementById('addTokenDialog')?.classList.add('hidden');
      const sel = document.getElementById('redeemToken');
      if (sel && sel.value === '__add_new__') sel.value = '';
    });
  }
  document.getElementById('addTokenDialog')?.addEventListener('click', (e) => {
    if (e.target.id === 'addTokenDialog') {
      document.getElementById('addTokenDialog').classList.add('hidden');
      const sel = document.getElementById('redeemToken');
      if (sel && sel.value === '__add_new__') sel.value = '';
    }
  });
  const btnAddTokenSubmit = document.getElementById('btnAddTokenSubmit');
  if (btnAddTokenSubmit) {
    btnAddTokenSubmit.addEventListener('click', async () => {
      const name = document.getElementById('addTokenName')?.value?.trim() || '';
      const contract = document.getElementById('addTokenContract')?.value?.trim() || '';
      if (!name || !contract) {
        alert('Please enter token name and contract address.');
        return;
      }
      try {
        const headers = await getAuthHeadersAsync();
        const chainInfo = REDEEM_CHAINS.find((c) => c.key === state.redeemChain);
        const r = await apiFetch(API_BASE + '/me/tokens', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chain_key: state.redeemChain,
            chain_id: chainInfo?.chainId ?? null,
            token_name: name,
            contract_address: contract,
          }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(err.error || 'Failed to save token');
          return;
        }
        document.getElementById('addTokenDialog').classList.add('hidden');
        await loadRedeemUserTokens(state.redeemChain);
        render();
      } catch (e) {
        alert(e.message || 'Request failed');
      }
    });
  }
  // New 3-factor Continue: mnemonic + passphrase + admin_factor → WASM derive → step 2
  const btnClaimContinue3F = document.getElementById('btnClaimContinue3F');
  if (btnClaimContinue3F) {
    btnClaimContinue3F.addEventListener('click', async () => {
      const mnemonic = (document.getElementById('claimMnemonic')?.value || '').trim();
      const passphrase = (document.getElementById('claimPassphrase')?.value || '').trim();
      const adminFactor = (document.getElementById('claimAdminFactor')?.value || '').trim();
      if (!mnemonic) {
        state.error = 'Please enter your mnemonic (24 words from the credential NFT).';
        render();
        return;
      }
      if (!passphrase) {
        state.error = 'Please enter your passphrase.';
        render();
        return;
      }
      if (!adminFactor) {
        state.error = 'Please enter the AdminFactor (64-char hex from the credential NFT).';
        render();
        return;
      }
      state.mnemonic = mnemonic;
      state.passphrase = passphrase;
      state.releaseKey = adminFactor;
      state.error = null;
      state.loading = true;
      render();
      try {
        // WASM derive: mnemonic + passphrase + adminFactor → wallet addresses
        if (!window.YaultWasm || typeof window.YaultWasm.init !== 'function') {
          throw new Error('WASM not loaded. Ensure acegf is available.');
        }
        await window.YaultWasm.init();
        if (!window.YaultWasm.acegf || typeof window.YaultWasm.acegf.view_wallet_unified_with_secondary_wasm !== 'function') {
          throw new Error('acegf.view_wallet_unified_with_secondary_wasm not found.');
        }
        const walletJs = window.YaultWasm.acegf.view_wallet_unified_with_secondary_wasm(mnemonic, passphrase, adminFactor || undefined);
        const walletJson = walletJs != null && typeof walletJs === 'object' ? walletJs : JSON.parse(JSON.stringify(walletJs));
        state.redeemWalletJson = walletJson;
        try { sessionStorage.setItem('redeemWalletJson', JSON.stringify(walletJson)); } catch (_) {}
        // Also update mnemonic hash on server so claim records are linked
        const mnemonicHash = await hashMnemonic(mnemonic);
        const currentUserEvm = (state.auth && (state.auth.address || state.auth.pubkey)) ? String(state.auth.address || state.auth.pubkey).trim() : '';
        if (currentUserEvm) {
          const headers = await getAuthHeadersAsync();
          await apiFetch(API_BASE + '/claim/update-wallet-json', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ evm_address: currentUserEvm, mnemonic_hash: mnemonicHash, wallet_json: walletJson }),
          }).catch(() => {});
        }
        // Set claim state for path claim if releaseKey is 80-char blob
        state.pathClaimAmountFromBlob = null;
        state.pathClaimRemaining = null;
        state.pathClaimError = null;
        // Fetch escrow balance (non-blocking — show step 2 immediately, balance loads async)
        state.escrowBalance = null;
        state.claimStep = 2;
        // Query escrow balance in background
        if (state.walletId) {
          const recipientIdx = state.pathIndex || 1;
          getAuthHeadersAsync().catch(() => ({})).then(function (claimAuthHeaders) {
            apiFetch(API_BASE + '/claim/escrow-balance?walletId=' + encodeURIComponent(state.walletId) + '&recipientIndex=' + encodeURIComponent(recipientIdx), { headers: claimAuthHeaders })
              .then(r => r.ok ? r.json() : null)
              .then(data => {
                if (data) { state.escrowBalance = data; render(); }
              })
              .catch(() => {});
          });
        }
      } catch (err) {
        state.error = 'Wallet derivation failed: ' + (err.message || err);
      } finally {
        state.loading = false;
        render();
      }
    });
  }
  // Back button from step 2 → step 1
  const btnClaimBack = document.getElementById('btnClaimBack');
  if (btnClaimBack) {
    btnClaimBack.addEventListener('click', () => {
      state.claimStep = 1;
      render();
    });
  }

  // Path Claim: load config (on claim step 2 when blob present)
  const btnPathClaimLoadConfigClaim = document.getElementById('btnPathClaimLoadConfigClaim');
  if (btnPathClaimLoadConfigClaim) {
    btnPathClaimLoadConfigClaim.addEventListener('click', async () => {
      try {
        const c = await (typeof YaultPathClaim !== 'undefined' ? YaultPathClaim.getConfig(API_BASE) : fetch(API_BASE + '/path-claim/config').then(r => r.json()));
        state.pathClaimConfig = c;
        state.pathClaimError = null;
      } catch (e) {
        state.pathClaimConfig = { enabled: false };
        state.pathClaimError = e.message;
      }
      render();
    });
  }
  // Get amount from blob (parse-blob + remaining)
  const btnPathClaimGetAmount = document.getElementById('btnPathClaimGetAmount');
  if (btnPathClaimGetAmount) {
    btnPathClaimGetAmount.addEventListener('click', async () => {
      const blobHex = (state.releaseKey || '').trim();
      if (blobHex.length !== 80 && blobHex.length !== 82) {
        state.pathClaimError = 'Release key must be 80 hex chars (blob with amount).';
        render();
        return;
      }
      state.pathClaimLoading = true;
      state.pathClaimError = null;
      render();
      try {
        const parseRes = await fetch(API_BASE + '/path-claim/parse-blob', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blobHex: blobHex.replace(/^0x/i, '') }),
        });
        const parseData = await parseRes.json();
        if (!parseRes.ok) {
          state.pathClaimAmountFromBlob = null;
          state.pathClaimError = parseData.error || 'Parse blob failed';
          render();
          return;
        }
        state.pathClaimAmountFromBlob = parseData.amount;
        const ethers = window.ethers;
        const walletIdHashHex = ethers.keccak256(ethers.toUtf8Bytes(state.walletId));
        const remRes = await fetch(`${API_BASE}/path-claim/remaining?walletIdHash=${encodeURIComponent(walletIdHashHex)}&pathIndex=${encodeURIComponent(state.pathIndex)}`);
        const remData = await remRes.json();
        state.pathClaimRemaining = remData.remaining != null ? remData.remaining : null;
      } catch (e) {
        state.pathClaimError = e.message || 'Failed to get amount from blob';
      } finally {
        state.pathClaimLoading = false;
        render();
      }
    });
  }
  // Claim to my wallet (amount from blob; sign with path controller key)
  const btnPathClaimClaim = document.getElementById('btnPathClaimClaim');
  if (btnPathClaimClaim) {
    btnPathClaimClaim.addEventListener('click', async () => {
      state.pathClaimControllerKey = document.getElementById('inputPathClaimControllerKey')?.value?.trim() || '';
      const amountWei = state.pathClaimAmountFromBlob;
      if (amountWei == null || amountWei === '') {
        state.pathClaimError = 'Get amount from blob first.';
        render();
        return;
      }
      if (!wallet || !wallet.address) {
        state.pathClaimError = 'Connect wallet to receive tokens.';
        render();
        return;
      }
      if (!state.pathClaimControllerKey) {
        state.pathClaimError = 'Path controller key (hex) required to sign claim.';
        render();
        return;
      }
      state.pathClaimLoading = true;
      state.pathClaimError = null;
      render();
      try {
        const ethers = window.ethers;
        const walletIdHashHex = ethers.keccak256(ethers.toUtf8Bytes(state.walletId));
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const params = await YaultPathClaim.getClaimParams(API_BASE, walletIdHashHex, state.pathIndex, String(amountWei), wallet.address, String(deadline));
        const sig = YaultPathClaim.signDigest(params.digest, state.pathClaimControllerKey);
        const tx = YaultPathClaim.buildClaimTx(
          state.pathClaimConfig,
          walletIdHashHex,
          state.pathIndex,
          amountWei,
          wallet.address,
          deadline,
          sig.v,
          sig.r,
          sig.s
        );
        const provider = window.yallet;
        if (!provider) throw new Error('No wallet provider');
        const ethersProvider = new ethers.BrowserProvider(provider);
        const pathControllerWallet = new ethers.Wallet(state.pathClaimControllerKey, ethersProvider);
        const txResp = await pathControllerWallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
        await txResp.wait();
        state.pathClaimError = null;
        showToast && showToast('Claim sent', 'success');
        state.pathClaimRemaining = null;
        state.pathClaimAmountFromBlob = null;
      } catch (e) {
        state.pathClaimError = e.message || 'Claim failed';
      } finally {
        state.pathClaimLoading = false;
        render();
      }
    });
  }

  // Claim Transfer button (step 2)
  const btnClaimTransfer = document.getElementById('btnClaimTransfer');
  if (btnClaimTransfer) {
    btnClaimTransfer.addEventListener('click', async () => {
      const to = document.getElementById('claimTransferTo')?.value?.trim() || '';
      if (!to) {
        state.error = 'Please enter a destination address.';
        render();
        return;
      }
      state.loading = true;
      state.error = null;
      render();
      try {
        const bal = state.escrowBalance;

        // If escrow balance is available, execute on-chain claim via acegf signing
        if (bal && bal.configured && bal.remainingShares && bal.remainingShares !== '0' && window.YaultEscrow) {
          // Verify acegf WASM is available
          if (!window.YaultWasm || !window.YaultWasm.acegf || typeof window.YaultWasm.acegf.evm_sign_eip1559_transaction_with_secondary !== 'function') {
            throw new Error('acegf WASM not loaded or outdated. Please hard-refresh (Ctrl+Shift+R) to load the latest WASM.');
          }
          await window.YaultWasm.init();

          // Verify mnemonic, passphrase & adminFactor are available from Step 1
          if (!state.mnemonic || !state.passphrase) {
            throw new Error('Credentials not available. Please go back to Step 1 and re-enter your mnemonic and passphrase.');
          }
          if (!state.releaseKey) {
            throw new Error('AdminFactor not available. Please go back to Step 1 and re-enter your AdminFactor.');
          }

          // Derive the plan owner's address using all 3 factors
          const ownerWallet = window.YaultWasm.acegf.view_wallet_unified_with_secondary_wasm(state.mnemonic, state.passphrase, state.releaseKey);
          const ownerAddr = ownerWallet && ownerWallet.evm_address ? ownerWallet.evm_address : '';
          if (!ownerAddr) {
            throw new Error('Failed to derive plan owner address from mnemonic+passphrase+adminFactor.');
          }

          const claimEscrowHeaders = await getAuthHeadersAsync().catch(function () { return {}; });
          const cfg = await window.YaultEscrow.getConfig(API_BASE, { headers: claimEscrowHeaders });
          if (!cfg.enabled) throw new Error('Escrow not configured on server');

          const claimTx = window.YaultEscrow.buildClaimTx(
            cfg.escrowAddress,
            bal.walletIdHash,
            bal.recipientIndex,
            to,
            bal.remainingShares,  // claim all remaining
            true,                 // redeemToAsset (C-05: must be true)
            cfg.chainId
          );

          // Set up provider for nonce & gas estimation
          const _ethersLib = typeof ethers !== 'undefined' ? ethers : window.ethers;
          const rpcProvider = new _ethersLib.JsonRpcProvider(cfg.rpcUrl);

          // Get nonce and gas params for the plan owner address
          const nonce = await rpcProvider.getTransactionCount(ownerAddr);
          const feeData = await rpcProvider.getFeeData();
          const gasLimitBig = 300000n;
          const maxPriorityFeeBig = feeData.maxPriorityFeePerGas || 1500000000n;
          const maxFeeBig = feeData.maxFeePerGas || 30000000000n;
          const chainIdBigInt = BigInt(cfg.chainId || 11155111);

          // acegf expects all numeric params as hex strings
          const toHex = (n) => '0x' + BigInt(n).toString(16);
          const txData = claimTx.data || '0x';

          // Sign with all 3 factors: mnemonic + passphrase + adminFactor → plan owner's signing key.
          // The mnemonic was sealed with combine_passphrase(passphrase, adminFactor),
          // so derive_keypair needs all 3 to correctly unseal and derive the EVM signing key.
          const signedRawTx = window.YaultWasm.acegf.evm_sign_eip1559_transaction_with_secondary(
            state.mnemonic,
            state.passphrase,
            state.releaseKey,    // adminFactor as secondary_passphrase
            chainIdBigInt,
            toHex(nonce),
            toHex(maxPriorityFeeBig),
            toHex(maxFeeBig),
            toHex(gasLimitBig),
            cfg.escrowAddress,   // to: escrow contract
            '0x0',               // value = 0
            txData               // data: claim() calldata
          );

          if (!signedRawTx || signedRawTx.startsWith('error:')) {
            throw new Error('acegf signing failed: ' + (signedRawTx || 'unknown error'));
          }

          // Broadcast signed transaction via RPC
          const rawHex = signedRawTx.startsWith('0x') ? signedRawTx : '0x' + signedRawTx;
          let txResp;
          try {
            txResp = await rpcProvider.broadcastTransaction(rawHex);
          } catch (broadcastErr) {
            const msg = (broadcastErr.message || '').toLowerCase();
            if (msg.includes('insufficient funds') || msg.includes('insufficient balance') || msg.includes('doesn\'t have enough funds')) {
              throw new Error(
                'Insufficient gas balance. The signing wallet (' + ownerAddr +
                ') does not have enough native token to cover transaction gas fees. ' +
                'Please transfer a small amount of ETH to this address and try again.'
              );
            }
            throw broadcastErr;
          }
          const txHash = txResp.hash;

          // Format display amount
          const decimals = bal.underlyingDecimals || 18;
          const symbol = bal.underlyingSymbol || 'TOKEN';
          const displayAmt = (Number(bal.remainingAssets) / Math.pow(10, decimals)).toFixed(6);

          state.transferResult = {
            chain: 'ethereum (sepolia)',
            from: ownerAddr,
            to,
            amount: displayAmt + ' ' + symbol,
            shares: bal.remainingShares,
            status: 'submitted',
            txHash,
            message: 'Claim transaction submitted! Tx: ' + (txHash || '').slice(0, 18) + '...',
          };
          reportActivity('claim', txHash, displayAmt, { asset: symbol });
        } else {
          const fromAddr = state.redeemWalletJson ? (state.redeemWalletJson.evm_address || '') : '';
          // Fallback: no escrow balance, show prepared result
          state.transferResult = {
            chain: 'ethereum',
            from: fromAddr,
            to,
            amount: 'all',
            status: 'prepared',
            message: 'No escrow balance found. Manual transfer needed.',
          };
        }
        state.claimStep = 3;
      } catch (err) {
        state.error = 'Claim failed: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  }
  // Back from step 3 → step 2
  const btnClaimBackToBalance = document.getElementById('btnClaimBackToBalance');
  if (btnClaimBackToBalance) {
    btnClaimBackToBalance.addEventListener('click', () => {
      state.claimStep = 2;
      state.transferResult = null;
      render();
    });
  }
}

// ─── Trial Request Events ───

function attachTrialNavEvents() {
  const btnGoToTrial = document.getElementById('btnGoToTrial');
  if (btnGoToTrial) {
    btnGoToTrial.addEventListener('click', () => {
      state.page = 'trial';
      state.trialSubmitted = false;
      state.error = null;
      render();
    });
  }
}

function attachTrialFormEvents() {
  const btnBack = document.getElementById('btnBackToLogin');
  if (btnBack) {
    btnBack.addEventListener('click', () => {
      state.page = 'login';
      state.error = null;
      render();
    });
  }

  const btnSubmit = document.getElementById('btnSubmitTrial');
  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      const name = (document.getElementById('trialName')?.value || '').trim();
      const email = (document.getElementById('trialEmail')?.value || '').trim();
      const xAccount = (document.getElementById('trialXAccount')?.value || '').trim();
      const linkedin = (document.getElementById('trialLinkedin')?.value || '').trim();
      const organization = (document.getElementById('trialOrganization')?.value || '').trim();
      const purpose = (document.getElementById('trialPurpose')?.value || '').trim();

      // Save form state
      state.trialForm = { name, email, xAccount, linkedin, organization, purpose };

      // Client-side validation
      if (!name) { state.error = 'Name is required.'; render(); return; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { state.error = 'A valid email is required.'; render(); return; }
      if (!purpose) { state.error = 'Please describe the purpose of your trial.'; render(); return; }

      state.loading = true;
      state.error = null;
      render();

      try {
        const resp = await fetch(`${API_BASE}/trial/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            x_account: xAccount,
            linkedin,
            organization,
            purpose,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Submission failed');
        state.trialSubmitted = true;
        state.trialForm = { name: '', email: '', xAccount: '', linkedin: '', organization: '', purpose: '' };
        showToast('Trial request submitted', 'success');
      } catch (err) {
        state.error = 'Failed to submit: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    });
  }
}

// ─── Wallet Balance Refresh ───

async function refreshWalletBalances() {
  const addr = state.auth?.address || '';
  if (!addr) return;

  try {
    const headers = await getAuthHeadersAsync().catch(() => ({}));
    const params = new URLSearchParams();
    const a = state.walletAddresses;
    if (a?.bitcoin_address) params.set('btc_address', a.bitcoin_address);
    if (a?.solana_address) params.set('sol_address', a.solana_address);
    const qs = params.toString();
    const url = `${API_BASE}/vault/balance/${encodeURIComponent(addr)}${qs ? '?' + qs : ''}`;
    const resp = await fetch(url, { headers });
    if (resp.ok) {
      const data = await resp.json();
      state.walletBalances = {
        eth: data.wallet?.eth || '0.00',
        sol: data.wallet?.sol || '0.00',
        btc: data.wallet?.btc || '0.00',
      };
      state.walletBalancesUsdc = {
        ethereum: data.wallet?.usdcEthereum ?? '0.00',
        solana: data.wallet?.usdcSolana ?? '0.00',
      };
      state.walletBalancesWeth = {
        ethereum: data.wallet?.wethEthereum ?? '0.00',
      };
      state.vaultBalances = {
        shares: data.vault?.shares || '0.00',
        value: data.vault?.value || '0.00',
        yield: data.vault?.yield || '0.00',
      };
      state.escrowBalances = {
        shares: data.escrow?.shares || '0',
        value: data.escrow?.value || '0',
        recipient_indices: data.escrow?.recipient_indices || [],
      };
      state.vaultUnderlyingSymbol = data.vault?.underlying_symbol || 'USDC';
      // Only re-render if on wallet page to avoid thrashing
      if (state.page === 'wallet') render();
    }
  } catch { /* non-fatal — will show zeros */ }
}

// ─── Utilities ───

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Format vault number for display: round to 2 decimals, trim trailing zeros (e.g. 21.999999 → 22, 2.0000 → 2). */
function formatVaultNum(str) {
  if (str == null || str === '') return '0';
  const n = parseFloat(String(str));
  if (!Number.isFinite(n)) return String(str);
  const rounded = Math.round(n * 100) / 100;
  if (rounded === Math.floor(rounded)) return String(Math.round(rounded));
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

/** Format vault shares for display: truncate (do not round) so displayed value never exceeds on-chain balance. */
function formatVaultShares(str) {
  if (str == null || str === '') return '0';
  const s = String(str).trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return '0';
  const truncated = Math.floor(n * 1e6) / 1e6;
  const fixed = truncated.toFixed(6);
  return fixed.replace(/\.?0+$/, '') || '0';
}

function shortEvm(addr) {
  if (!addr || typeof addr !== 'string') return '';
  const a = String(addr).replace(/^0x/i, '');
  if (a.length <= 12) return addr;
  return a.substring(0, 8) + '...' + a.slice(-4);
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

/** Return block explorer tx URL for chainId (1 = mainnet, 11155111 = Sepolia). */
function getExplorerTxUrl(chainId, txHash) {
  const cid = Number(chainId);
  const base = cid === 1 ? 'https://etherscan.io' : (cid === 11155111 ? 'https://sepolia.etherscan.io' : 'https://etherscan.io');
  return base + '/tx/' + (txHash && txHash.startsWith('0x') ? txHash : '0x' + txHash);
}

function getExplorerName(chainId) {
  return Number(chainId) === 1 ? t('ethMainnet') : t('sepoliaTestnet');
}

/** Parse human amount string to smallest unit (no float precision loss). E.g. parseUnits('289.5', 18) => 289500000000000000000n */
function parseUnits(amountStr, decimals) {
  const s = String(amountStr).trim();
  const [whole, frac = ''] = s.split('.');
  const w = whole.replace(/^0+/, '') || '0';
  const f = frac.slice(0, decimals).padEnd(decimals, '0').slice(0, decimals);
  return BigInt(w) * (10n ** BigInt(decimals)) + BigInt(f || '0');
}

/** Encode ERC20 approve(spender, amount) calldata. amountWei = amount in token smallest unit (e.g. 6 decimals for USDC). */
function encodeApproveCalldata(spenderAddress, amountWei) {
  const selector = '095ea7b3';
  const addr = String(spenderAddress).replace(/^0x/i, '').padStart(40, '0').slice(-40);
  const padAddr = addr.padStart(64, '0');
  const amountHex = BigInt(amountWei).toString(16).padStart(64, '0');
  return '0x' + selector + padAddr + amountHex;
}

/** Ensure hex string has even length (EVM/Yallet require even number of hex digits). */
function toEvenHex(hexOrNum) {
  const hex = typeof hexOrNum === 'string' && hexOrNum.startsWith('0x')
    ? hexOrNum.slice(2)
    : BigInt(hexOrNum).toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  return '0x' + padded;
}

/** Normalize any hex string (e.g. data, address) to even-length for wallet APIs. */
function normalizeHex(s) {
  if (s == null || s === '') return s;
  const h = String(s).startsWith('0x') ? String(s).slice(2) : String(s);
  const padded = h.length % 2 === 0 ? h : '0' + h;
  return '0x' + padded;
}

/** Wait for a transaction to be mined. Uses raw JSON-RPC fetch (no ethers dependency). */
async function waitForTxReceipt(rpcUrl, txHash, timeoutMs) {
  const timeout = timeoutMs || 120000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(rpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      });
      const json = await resp.json();
      if (json.result) {
        if (json.result.status === '0x0') throw new Error('Transaction reverted: ' + txHash);
        return json.result;
      }
    } catch (e) {
      if (e.message && e.message.includes('reverted')) throw e;
      console.warn('[waitForTxReceipt] poll error:', e.message);
    }
    await new Promise(function (r) { setTimeout(r, 3000); });
  }
  throw new Error('Transaction not confirmed within ' + Math.round(timeout / 1000) + 's: ' + txHash);
}

/** Check ERC20 allowance via raw JSON-RPC eth_call (no ethers dependency). Returns BigInt. */
async function checkAllowanceRaw(rpcUrl, tokenAddress, ownerAddress, spenderAddress) {
  var owner = ownerAddress.replace(/^0x/i, '').padStart(64, '0');
  var spender = spenderAddress.replace(/^0x/i, '').padStart(64, '0');
  var calldata = '0xdd62ed3e' + owner + spender; // allowance(address,address)
  var resp = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddress, data: calldata }, 'latest'] }),
  });
  var json = await resp.json();
  if (json.result) return BigInt(json.result);
  return 0n;
}

/** Send a transaction payload (from API) via the user's wallet. Returns tx hash or throws. */
async function sendTransactionInWallet(transaction, fromAddress) {
  // Prefer stored provider; after page refresh wallet._yalletProvider can be null even if user logged in with Yallet — sync from window.yallet
  if (wallet && !wallet._yalletProvider && window.yallet) {
    wallet._yalletProvider = window.yallet;
  }
  const provider = wallet?._yalletProvider || window.yallet;
  if (!provider) {
    throw new Error('Yallet not detected. Please refresh the page and log in with Yallet. If the extension is installed, make sure it is enabled and allowed to access this site.');
  }
  // All hex fields must have even length (EVM/Yallet reject odd).
  const from = fromAddress ? normalizeHex(fromAddress.startsWith('0x') ? fromAddress : '0x' + fromAddress) : undefined;
  const value = toEvenHex(transaction.value ?? 0);
  const chainIdHex = transaction.chainId ? toEvenHex(Number(transaction.chainId)) : undefined;
  const txParams = {
    from,
    to: transaction.to ? normalizeHex(transaction.to) : undefined,
    data: transaction.data ? normalizeHex(transaction.data) : undefined,
    value,
  };
  if (transaction.gasLimit != null) {
    txParams.gas = normalizeHex(transaction.gasLimit);
  }
  // Call eth_sendTransaction first so the browser user gesture is still valid for the wallet popup.
  // If Yallet returns wrong-network error, switch chain and retry once.
  try {
    return await provider.request({
      method: 'eth_sendTransaction',
      params: [txParams],
    });
  } catch (e) {
    const needSwitch = chainIdHex && (e?.code === 4902 || e?.message?.includes('chain') || e?.message?.includes('network'));
    if (needSwitch) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
      return await provider.request({
        method: 'eth_sendTransaction',
        params: [txParams],
      });
    }
    throw e;
  }
}

// ─── Init (unified app: register for main.js) ───
/** Sync header Chain/Token dropdowns with state and attach handlers. Global context for all balances/addresses. */
function setupGlobalContextSelectors() {
  var chainSelect = document.getElementById('global-chain-select');
  var tokenSelect = document.getElementById('global-token-select');
  if (!chainSelect || !tokenSelect) return;

  function syncTokenOptions() {
    var tokens = TOKENS_BY_CHAIN[state.globalChainKey] || TOKENS_BY_CHAIN.ethereum;
    tokenSelect.innerHTML = tokens.map(function (t) {
      return '<option value="' + esc(t.value) + '">' + esc(t.label) + '</option>';
    }).join('');
    var hasCurrent = tokens.some(function (t) { return t.value === state.globalTokenKey; });
    state.globalTokenKey = hasCurrent ? state.globalTokenKey : (tokens[0] && tokens[0].value) || 'ETH';
    tokenSelect.value = state.globalTokenKey;
  }

  chainSelect.value = state.globalChainKey;
  syncTokenOptions();

  chainSelect.addEventListener('change', function () {
    state.globalChainKey = chainSelect.value;
    syncTokenOptions();
    if (state.page === 'wallet' && state.walletSection === 'send' && state.sendForm.selectedAccountIndex != null) {
      var related = state.relatedAccounts || [];
      var acc = related[state.sendForm.selectedAccountIndex];
      if (acc) {
        var addr = getAddressForChain(acc, state.globalChainKey) || '';
        state.sendForm.to = addr;
        if (!addr) state.sendForm.selectedAccountIndex = null;
      }
    }
    refreshWalletBalances().then(function () {
      if (state.page === 'wallet') render();
    });
    // Reload plan for new chain+token context
    state.savedPlan = null;
    loadWalletPlan().then(function () { render(); });
    render();
  });

  tokenSelect.addEventListener('change', function () {
    state.globalTokenKey = tokenSelect.value;
    // Reload plan for new token context
    state.savedPlan = null;
    loadWalletPlan().then(function () { render(); });
    render();
  });
}

window.YaultPortals = window.YaultPortals || {};
window.YaultPortals.client = {
  init: function () {
    initWallet();
    render();
    setupGlobalContextSelectors();
    window.onYaultLocaleChange = function () { render(); };
  },
};
