/**
 * db.js — SQLite Database Abstraction (sql.js — pure JS, no native deps)
 *
 * Replaces the previous in-memory Map-backed store with SQLite for
 * persistence across server restarts. The async CRUD API surface is
 * preserved so all existing consumers remain unchanged.
 *
 * sql.js loads SQLite compiled to WebAssembly — no native compilation
 * required, works on any platform / Node version.
 *
 * Data is stored as JSON blobs keyed by a TEXT primary key.
 *
 * Collections:
 * - db.authorities   // AuthorityProfile records
 * - db.bindings      // AuthorityUserBinding records
 * - db.triggers      // TriggerEvent records
 * - db.revenue       // RevenueRecord records
 * - db.withdrawals   // Withdrawal records
 * - db.auditLog      // Immutable audit trail entries
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DATABASE_PATH
  || path.join(__dirname, '..', 'data', 'yault.db');
const DB_EXTERNAL_SYNC_ENABLED = String(process.env.DB_EXTERNAL_SYNC_ENABLED || '1') !== '0';
const DB_SYNC_MIN_INTERVAL_MS = Number(process.env.DB_SYNC_MIN_INTERVAL_MS || 800);
const DB_CONFLICT_POLICY = (process.env.DB_CONFLICT_POLICY || 'prefer_disk').toLowerCase(); // prefer_disk | prefer_memory

let _db = null;
let _initPromise = null;
let _SQL = null;

/** Auto-save interval handle */
let _saveTimer = null;
/** Whether there are unsaved changes */
let _dirty = false;
/** Last known on-disk DB fingerprint (mtime + size) */
let _lastDiskVersion = null;
/** Throttle disk sync checks */
let _lastSyncCheckAt = 0;
/** Serialize save operations to avoid tmp-file rename races */
let _saveInFlight = null;

const TABLES = ['authorities', 'bindings', 'triggers', 'revenue', 'withdrawals', 'auditLog', 'vaultPositions', 'adminSessions', 'authoritySessions', 'insurancePolicies', 'subAccounts', 'allowances', 'trialApplications', 'recipientPaths', 'releasedFactors', 'kyc', 'accountInvites', 'walletPlans', 'walletAddresses', 'users', 'recipientMnemonicAdmin', 'authorityReleaseLinks', 'userCustomTokens', 'rwaReleaseRegistry', 'rwaDeliveryLog', 'campaigns', 'referrals', 'activities', 'adminApprovals', 'walletAdminFactors', 'recipientPathIndex', 'mnemonicHashIndex'];

function _ensureTables(db) {
  for (const table of TABLES) {
    db.run(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `);
  }
}

async function _getDiskVersion() {
  try {
    const s = await fs.promises.stat(DB_PATH);
    return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
  } catch (_) {
    return null;
  }
}

async function _reloadFromDisk(reason = 'external change') {
  if (!_SQL) return false;
  try {
    if (!fs.existsSync(DB_PATH)) return false;
    const fileBuffer = fs.readFileSync(DB_PATH);
    if (!fileBuffer || fileBuffer.length === 0) return false;

    const newDb = new _SQL.Database(fileBuffer);
    _ensureTables(newDb);
    const oldDb = _db;
    _db = newDb;
    _dirty = false;
    _lastDiskVersion = await _getDiskVersion();

    if (oldDb && oldDb !== newDb) {
      try { oldDb.close(); } catch (_) {}
    }
    console.warn(`[db] Reloaded database from disk (${reason})`);
    return true;
  } catch (err) {
    console.error('[db] Failed to reload database from disk:', err.message);
    return false;
  }
}

async function _maybeSyncFromDisk(force = false) {
  if (!DB_EXTERNAL_SYNC_ENABLED || !_db) return;
  const now = Date.now();
  if (!force && (now - _lastSyncCheckAt) < DB_SYNC_MIN_INTERVAL_MS) return;
  _lastSyncCheckAt = now;

  const diskVersion = await _getDiskVersion();
  if (!diskVersion) return;

  // First observation baseline
  if (!_lastDiskVersion) {
    _lastDiskVersion = diskVersion;
    return;
  }

  if (diskVersion !== _lastDiskVersion) {
    if (_dirty) {
      // Unsaved local mutations exist; resolve at save boundary according to conflict policy.
      return;
    }
    await _reloadFromDisk('detected external writer');
  }
}

/**
 * Initialise the database (async, called once).
 * Loads from disk if the file exists, otherwise creates a new database.
 */
async function initDb() {
  if (_db) return _db;

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  _SQL = SQL;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    if (fileBuffer.length > 0) {
      _db = new SQL.Database(fileBuffer);
    } else {
      console.warn('[db] Database file exists but is empty (0 bytes). Creating new database.');
      _db = new SQL.Database();
    }
  } else {
    _db = new SQL.Database();
  }

  // Create tables
  _ensureTables(_db);

  await _saveToDisk(); // initial save to create file if new
  _lastDiskVersion = await _getDiskVersion();

  // Auto-save every 5 seconds if there are changes
  _saveTimer = setInterval(() => {
    _maybeSyncFromDisk().catch((err) => {
      console.warn('[db] External sync check failed:', err.message);
    });
    if (_dirty) _saveToDisk();
  }, 5000);
  if (_saveTimer.unref) _saveTimer.unref();

  return _db;
}

/**
 * Get the database, initialising if needed.
 * For sync access in transactions, the db must already be initialised.
 */
function getDb() {
  if (!_db) {
    throw new Error('Database not initialised. Await ensureReady() first or call from an async context.');
  }
  return _db;
}

/**
 * Ensure the database is ready (call at server startup or before first use).
 */
async function ensureReady() {
  if (_db) {
    await _maybeSyncFromDisk();
    return _db;
  }
  if (!_initPromise) {
    _initPromise = initDb();
  }
  const db = await _initPromise;
  await _maybeSyncFromDisk();
  return db;
}

/**
 * Persist the database to disk.
 */
async function _saveToDisk() {
  if (!_db) return;
  if (_saveInFlight) {
    await _saveInFlight;
  }
  let done;
  _saveInFlight = new Promise((resolve) => { done = resolve; });
  try {
    if (!_dirty) {
      _lastDiskVersion = await _getDiskVersion();
      return;
    }

    const diskVersionBeforeWrite = await _getDiskVersion();
    const hasExternalWrite = !!(_lastDiskVersion && diskVersionBeforeWrite && diskVersionBeforeWrite !== _lastDiskVersion);
    if (hasExternalWrite && DB_CONFLICT_POLICY !== 'prefer_memory') {
      console.warn('[db] External DB update detected while local changes pending; preferring disk and reloading.');
      await _reloadFromDisk('save conflict (prefer_disk)');
      return;
    }

    const data = _db.export();
    const buffer = Buffer.from(data);
    // Atomic write: write to temp file first, then rename to prevent
    // 0-byte files if the process exits mid-write (rename is atomic on POSIX).
    const tmpPath = DB_PATH + '.tmp';
    await fs.promises.writeFile(tmpPath, buffer);
    await fs.promises.rename(tmpPath, DB_PATH);
    _dirty = false;
    _lastDiskVersion = await _getDiskVersion();
  } catch (err) {
    console.error('[db] Failed to save database:', err.message);
  } finally {
    done();
    _saveInFlight = null;
  }
}

function _markDirty() {
  _dirty = true;
}

// ---------------------------------------------------------------------------
// Generic collection factory (sql.js-backed)
// ---------------------------------------------------------------------------

/**
 * Create a collection backed by a SQLite table.
 *
 * @param {string} name - Table / collection name
 * @param {{ allowedJsonFields?: string[] }} [options] - If provided, findByField() only allows these JSON field names (prevents injection).
 * @returns {object} Collection with async CRUD methods
 */
function createCollection(name, options = {}) {
  const allowedJsonFields = options.allowedJsonFields || null;

  return {
    /**
     * Insert a new record.
     * @param {string} id
     * @param {object} data
     * @returns {Promise<object>}
     */
    async create(id, data) {
      const db = await ensureReady();
      const copy = { ...data };
      db.run(`INSERT OR REPLACE INTO "${name}" (id, data) VALUES (?, ?)`, [id, JSON.stringify(copy)]);
      _markDirty();
      return copy;
    },

    /**
     * Find a record by primary key.
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async findById(id) {
      const db = await ensureReady();
      const results = db.exec(`SELECT data FROM "${name}" WHERE id = ?`, [id]);
      if (results.length === 0 || results[0].values.length === 0) return null;
      return JSON.parse(results[0].values[0][0]);
    },

    /**
     * Return all records in the collection.
     * @returns {Promise<object[]>}
     */
    async findAll() {
      const db = await ensureReady();
      const results = db.exec(`SELECT data FROM "${name}"`);
      if (results.length === 0) return [];
      return results[0].values.map((row) => JSON.parse(row[0]));
    },

    /**
     * Return all primary key ids in the collection.
     * @returns {Promise<string[]>}
     */
    async findAllIds() {
      const db = await ensureReady();
      const results = db.exec(`SELECT id FROM "${name}"`);
      if (results.length === 0) return [];
      return results[0].values.map((row) => row[0]);
    },

    /**
     * Update a record (full replace).
     * @param {string} id
     * @param {object} data
     * @returns {Promise<object|null>}
     */
    async update(id, data) {
      const db = await ensureReady();
      const exists = db.exec(`SELECT 1 FROM "${name}" WHERE id = ? LIMIT 1`, [id]);
      if (exists.length === 0 || exists[0].values.length === 0) return null;
      const copy = { ...data };
      db.run(`UPDATE "${name}" SET data = ? WHERE id = ?`, [JSON.stringify(copy), id]);
      _markDirty();
      return copy;
    },

    /**
     * Delete a record.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async delete(id) {
      const db = await ensureReady();
      const before = db.getRowsModified ? db.getRowsModified() : 0;
      db.run(`DELETE FROM "${name}" WHERE id = ?`, [id]);
      _markDirty();
      const after = db.getRowsModified ? db.getRowsModified() : 1;
      return (after - before) > 0 || true; // sql.js doesn't easily expose changes for DELETE
    },

    /**
     * Find records matching a predicate.
     * @param {(record: object) => boolean} predicate
     * @returns {Promise<object[]>}
     */
    async findWhere(predicate) {
      const all = await this.findAll();
      return all.filter(predicate);
    },

    /**
     * Find records where a JSON field equals a given value.
     * Uses json_extract() for efficient SQL-level filtering. If allowedJsonFields was set,
     * only those field names are permitted (do not pass user input as field).
     * @param {string} field - JSON field name (e.g., 'authority_id', 'wallet_id')
     * @param {string} value - Value to match
     * @returns {Promise<object[]>}
     */
    async findByField(field, value) {
      if (allowedJsonFields && !allowedJsonFields.includes(field)) {
        throw new Error(`findByField: field "${field}" is not in allowed list. Do not pass user input as field.`);
      }
      const db = await ensureReady();
      const results = db.exec(
        `SELECT data FROM "${name}" WHERE json_extract(data, '$.' || ?) = ?`,
        [field, value]
      );
      if (results.length === 0) return [];
      return results[0].values.map((row) => JSON.parse(row[0]));
    },

    /**
     * Run a callback with the raw database for atomic operations.
     * The callback receives the sql.js Database instance and runs synchronously.
     * @param {(db: object) => any} fn
     * @returns {any}
     */
    runTransaction(fn) {
      const db = getDb(); // must already be init'd
      db.run('BEGIN TRANSACTION');
      try {
        const result = fn();
        db.run('COMMIT');
        _markDirty();
        return result;
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Collections with domain-specific query helpers
// ---------------------------------------------------------------------------

// #16 FIX: Add allowedJsonFields so findByField can be used for verified/region/pubkey lookups
const authorities = createCollection('authorities', { allowedJsonFields: ['verified', 'region', 'pubkey'] });

const bindings = createCollection('bindings', { allowedJsonFields: ['wallet_id', 'authority_id'] });
bindings.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};
bindings.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};

const triggers = createCollection('triggers', { allowedJsonFields: ['authority_id', 'wallet_id'] });
triggers.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};
triggers.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

const revenue = createCollection('revenue', { allowedJsonFields: ['authority_id', 'wallet_id'] });
revenue.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};
revenue.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

const withdrawals = createCollection('withdrawals', { allowedJsonFields: ['authority_id'] });
withdrawals.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};

const auditLog = createCollection('auditLog');

// C-03 FIX: Persistent vault position storage (was in-memory Map)
const vaultPositions = createCollection('vaultPositions');

// H-04 FIX: Persistent admin session storage (was in-memory Map)
const adminSessions = createCollection('adminSessions');

// Authority dashboard session (one sign, then token for API calls)
const authoritySessions = createCollection('authoritySessions');

// Insurance policy storage
const insurancePolicies = createCollection('insurancePolicies', { allowedJsonFields: ['wallet_address'] });
insurancePolicies.findByWallet = async function (walletAddress) {
  return this.findByField('wallet_address', walletAddress);
};

// Sub-accounts (family members / corporate sub-accounts)
const subAccounts = createCollection('subAccounts', { allowedJsonFields: ['parent_wallet_id', 'member_wallet_id'] });
subAccounts.findByParent = async function (parentWalletId) {
  return this.findByField('parent_wallet_id', parentWalletId);
};
subAccounts.findByMember = async function (memberWalletId) {
  return this.findByField('member_wallet_id', memberWalletId);
};

// Allowances (fund transfers between parent and sub-accounts)
const allowances = createCollection('allowances', { allowedJsonFields: ['from_wallet_id', 'to_wallet_id'] });
allowances.findByFrom = async function (walletId) {
  return this.findByField('from_wallet_id', walletId);
};
allowances.findByTo = async function (walletId) {
  return this.findByField('to_wallet_id', walletId);
};
allowances.findByWallet = async function (walletId) {
  // Match either sender or receiver — uses OR query for efficiency (fixed field names, no user input)
  const db = await ensureReady();
  const results = db.exec(
    `SELECT data FROM "allowances" WHERE json_extract(data, '$.from_wallet_id') = ? OR json_extract(data, '$.to_wallet_id') = ?`,
    [walletId, walletId]
  );
  if (results.length === 0) return [];
  return results[0].values.map((row) => JSON.parse(row[0]));
};

// Trial applications
const trialApplications = createCollection('trialApplications');

// Recipient path configurations (id = SHA-256(wallet_id))
const recipientPaths = createCollection('recipientPaths');
recipientPaths.findByWallet = async function (walletId) {
  const crypto = require('crypto');
  const id = crypto.createHash('sha256').update(String(walletId)).digest('hex');
  let r = await this.findById(id);
  if (!r) {
    // Backward compat: try legacy truncated key
    const legacyId = id.slice(0, 32);
    r = await this.findById(legacyId);
  }
  return r ? [r] : [];
};

// Released admin factors for claims
const releasedFactors = createCollection('releasedFactors', { allowedJsonFields: ['wallet_id'] });
releasedFactors.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

// KYC submissions and reviews (persisted; provider API integration is future)
const kyc = createCollection('kyc');

// Client portal: invitations and related accounts (one row per invite, keyed by owner)
const accountInvites = createCollection('accountInvites', { allowedJsonFields: ['owner_wallet_id', 'email'] });
accountInvites.findByOwner = async function (ownerWalletId) {
  return this.findByField('owner_wallet_id', ownerWalletId);
};

// Client portal: saved asset plan per wallet (one row per wallet, id = wallet_id)
const walletPlans = createCollection('walletPlans');

// Yallet multi-chain addresses: id = normalized evm_address, data = { evm_address, bitcoin_address, ... }
const walletAddresses = createCollection('walletAddresses');

// Logged-in users: id = normalized wallet address, created on first login via /api/auth/verify
const users = createCollection('users');

// Plan test flow: id = mnemonic_hash (64 hex), data = { evm_address, mnemonic_hash, admin_factor?, label?, plan_wallet_id?, created_at, wallet_json? }
const recipientMnemonicAdmin = createCollection('recipientMnemonicAdmin', { allowedJsonFields: ['evm_address', 'wallet_json'] });
recipientMnemonicAdmin.findByEvmAddress = async function (evmAddress) {
  const all = await this.findAll();
  const norm = (a) => (a || '').replace(/^0x/i, '').toLowerCase();
  const want = norm(evmAddress);
  return all.filter((r) => norm(r.evm_address) === want);
};
recipientMnemonicAdmin.findByEvmAddressWithAdminFactor = async function (evmAddress) {
  const rows = await this.findByEvmAddress(evmAddress);
  return rows.filter((r) => {
    if (r.encrypted_admin_factor && typeof r.encrypted_admin_factor === 'object') return true;
    if (r.admin_factor_encrypted && typeof r.admin_factor_encrypted === 'object') return true;
    if (r.admin_factor_cipher && typeof r.admin_factor_cipher === 'object') return true;
    if (r.encrypted_payload && typeof r.encrypted_payload === 'object') return true;
    return !!(r.admin_factor && String(r.admin_factor).trim());
  });
};

// Authority release links (test): id = uuid, data = { authority_id, release_link, recipient_id, evm_address, created_at }
const authorityReleaseLinks = createCollection('authorityReleaseLinks', { allowedJsonFields: ['authority_id'] });
authorityReleaseLinks.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};

// User custom tokens for Redeem: id = evm_address (normalized), data = { evm_address, tokens: [ { chain_key, chain_id, token_name, contract_address } ] }
const userCustomTokens = createCollection('userCustomTokens');

// RWA release: single row id='default', data = { arweave_tx_id } — current global registry tx id on Arweave (so mapping survives DB loss if backed up to RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID).
const rwaReleaseRegistry = createCollection('rwaReleaseRegistry');

// RWA delivery log: tracks delivery attempts so failed deliveries can be retried.
// id = `${wallet_id}_${authority_id}_${recipient_index}`, data = { wallet_id, authority_id, recipient_index, status, txId?, error?, attempts, created_at, updated_at }
const rwaDeliveryLog = createCollection('rwaDeliveryLog', { allowedJsonFields: ['wallet_id', 'status'] });
rwaDeliveryLog.findPending = async function () {
  return this.findByField('status', 'pending');
};
rwaDeliveryLog.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

// Campaign / rebate: id = campaign_id (uuid), data = { name, enabled, rebate_bps, ... }
const campaigns = createCollection('campaigns');

// Referral tracking: id = random hex, data = { referrer_wallet_id, invitee_wallet_id, invite_id, created_at }
const referrals = createCollection('referrals', { allowedJsonFields: ['referrer_wallet_id', 'invitee_wallet_id'] });
referrals.findByReferrer = async function (walletId) {
  return this.findByField('referrer_wallet_id', walletId);
};
referrals.findByInvitee = async function (walletId) {
  return this.findByField('invitee_wallet_id', walletId);
};

// Activities: global activity log (login, deposit, redeem, harvest, escrow, claim, etc.)
// id = uuid, data = { wallet, type, amount?, shares?, asset?, chain_id?, tx_hash?, status, detail?, created_at }
const activities = createCollection('activities', { allowedJsonFields: ['wallet', 'type', 'status'] });

// Admin multi-sig approvals: id = approval_id (hex), data = { action, params, required_approvals, current_approvals[], status, ... }
const adminApprovals = createCollection('adminApprovals', { allowedJsonFields: ['status', 'action'] });
adminApprovals.findPending = async function () {
  return this.findByField('status', 'pending');
};

// Wallet AdminFactors: encrypted AdminFactors stored during plan creation for later authority retrieval.
// id = `${walletId}_af_${recipientIndex}`, data = { wallet_id, recipient_index, label, admin_factor_hex (encrypted), fingerprint, created_at }
const walletAdminFactors = createCollection('walletAdminFactors', { allowedJsonFields: ['wallet_id'] });
walletAdminFactors.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

// Reverse index: recipient_evm_address → wallet_id (for /claim/me, avoids full table scan)
// id = `${normalizedRecipientAddress}_${normalizedWalletId}`, data = { recipient_address, wallet_id }
const recipientPathIndex = createCollection('recipientPathIndex', { allowedJsonFields: ['recipient_address', 'wallet_id'] });
recipientPathIndex.findByRecipientAddress = async function (address) {
  return this.findByField('recipient_address', address);
};
recipientPathIndex.deleteByWalletId = async function (walletId) {
  const entries = await this.findByField('wallet_id', walletId);
  for (const entry of entries) {
    const id = `${entry.recipient_address}_${walletId}`;
    await this.delete(id);
  }
};

// Reverse index: mnemonic_hash → wallet_id (for /claim/by-mnemonic-hash, avoids full table scan)
// id = `${mnemonicHash}_${normalizedWalletId}`, data = { mnemonic_hash, wallet_id, recipient_address, path_index }
const mnemonicHashIndex = createCollection('mnemonicHashIndex', { allowedJsonFields: ['mnemonic_hash', 'wallet_id'] });
mnemonicHashIndex.findByHash = async function (hash) {
  return this.findByField('mnemonic_hash', hash);
};
mnemonicHashIndex.deleteByWalletId = async function (walletId) {
  const entries = await this.findByField('wallet_id', walletId);
  for (const entry of entries) {
    const id = `${entry.mnemonic_hash}_${walletId}`;
    await this.delete(id);
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  authorities,
  bindings,
  triggers,
  revenue,
  withdrawals,
  auditLog,
  vaultPositions,
  adminSessions,
  authoritySessions,
  insurancePolicies,
  subAccounts,
  allowances,
  trialApplications,
  recipientPaths,
  releasedFactors,
  kyc,
  accountInvites,
  walletPlans,
  walletAddresses,
  users,
  recipientMnemonicAdmin,
  authorityReleaseLinks,
  userCustomTokens,
  rwaReleaseRegistry,
  rwaDeliveryLog,
  campaigns,
  referrals,
  activities,
  adminApprovals,
  walletAdminFactors,
  recipientPathIndex,
  mnemonicHashIndex,

  /** Ensure database is initialised (call before first use). */
  ensureReady,

  /** Exposed for testing: close and release the database. */
  async _close() {
    if (_saveTimer) {
      clearInterval(_saveTimer);
      _saveTimer = null;
    }
    if (_db) {
      await _saveToDisk();
      _db.close();
      _db = null;
      _initPromise = null;
    }
  },

  /** Exposed for transactions: get the raw sql.js Database instance (sync). */
  _getDb: getDb,

  /** Force save to disk now. */
  _saveToDisk,
};
