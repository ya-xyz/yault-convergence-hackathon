'use strict';

const { Pool } = require('pg');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for Postgres backend');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 10) });
let _ready = false;

const TABLES = ['authorities', 'bindings', 'triggers', 'revenue', 'withdrawals', 'auditLog', 'vaultPositions', 'adminSessions', 'authoritySessions', 'insurancePolicies', 'subAccounts', 'allowances', 'trialApplications', 'recipientPaths', 'releasedFactors', 'kyc', 'accountInvites', 'walletPlans', 'walletAddresses', 'users', 'recipientMnemonicAdmin', 'authorityReleaseLinks', 'userCustomTokens', 'rwaReleaseRegistry', 'rwaDeliveryLog', 'campaigns', 'referrals', 'activities', 'adminApprovals', 'walletAdminFactors', 'recipientPathIndex', 'mnemonicHashIndex', 'agentApiKeys', 'spendingPolicies', 'agentBudgetLedger'];

async function ensureReady() {
  if (_ready) return;
  const client = await pool.connect();
  try {
    for (const table of TABLES) {
      await client.query(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
    }
    _ready = true;
  } finally {
    client.release();
  }
}

function jsonValue(v) {
  return JSON.parse(JSON.stringify(v));
}

function createCollection(name, options = {}) {
  const allowedJsonFields = options.allowedJsonFields || null;

  return {
    async create(id, data) {
      await ensureReady();
      const copy = jsonValue(data);
      await pool.query(
        `INSERT INTO "${name}" (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [id, JSON.stringify(copy)]
      );
      return copy;
    },

    async findById(id) {
      await ensureReady();
      const r = await pool.query(`SELECT data FROM "${name}" WHERE id = $1 LIMIT 1`, [id]);
      return r.rows[0] ? r.rows[0].data : null;
    },

    async findAll() {
      await ensureReady();
      const r = await pool.query(`SELECT data FROM "${name}"`);
      return r.rows.map((row) => row.data);
    },

    async findAllIds() {
      await ensureReady();
      const r = await pool.query(`SELECT id FROM "${name}"`);
      return r.rows.map((row) => row.id);
    },

    async update(id, data) {
      await ensureReady();
      const exists = await pool.query(`SELECT 1 FROM "${name}" WHERE id = $1 LIMIT 1`, [id]);
      if (exists.rowCount === 0) return null;
      const copy = jsonValue(data);
      await pool.query(`UPDATE "${name}" SET data = $2::jsonb WHERE id = $1`, [id, JSON.stringify(copy)]);
      return copy;
    },

    async delete(id) {
      await ensureReady();
      const r = await pool.query(`DELETE FROM "${name}" WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },

    async findWhere(predicate) {
      const all = await this.findAll();
      return all.filter(predicate);
    },

    async findByField(field, value) {
      if (allowedJsonFields && !allowedJsonFields.includes(field)) {
        throw new Error(`findByField: field "${field}" is not in allowed list. Do not pass user input as field.`);
      }
      await ensureReady();
      const safeField = String(field).replace(/[^a-zA-Z0-9_]/g, '');
      const sql = `SELECT data FROM "${name}" WHERE data->>$1 = $2`;
      const r = await pool.query(sql, [safeField, String(value)]);
      return r.rows.map((row) => row.data);
    },

    async runTransaction(fn) {
      await ensureReady();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

const authorities = createCollection('authorities', { allowedJsonFields: ['verified', 'region', 'pubkey'] });

const bindings = createCollection('bindings', { allowedJsonFields: ['wallet_id', 'authority_id', 'plan_id'] });
bindings.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};
bindings.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};
bindings.findByPlan = async function (planId) {
  return this.findByField('plan_id', planId);
};

const triggers = createCollection('triggers', { allowedJsonFields: ['authority_id', 'wallet_id', 'plan_id'] });
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
const vaultPositions = createCollection('vaultPositions');
const adminSessions = createCollection('adminSessions');
const authoritySessions = createCollection('authoritySessions');
const insurancePolicies = createCollection('insurancePolicies', { allowedJsonFields: ['wallet_address'] });
insurancePolicies.findByWallet = async function (walletAddress) {
  return this.findByField('wallet_address', walletAddress);
};

const subAccounts = createCollection('subAccounts', { allowedJsonFields: ['parent_wallet_id', 'member_wallet_id'] });
subAccounts.findByParent = async function (parentWalletId) {
  return this.findByField('parent_wallet_id', parentWalletId);
};
subAccounts.findByMember = async function (memberWalletId) {
  return this.findByField('member_wallet_id', memberWalletId);
};

const allowances = createCollection('allowances', { allowedJsonFields: ['from_wallet_id', 'to_wallet_id'] });
allowances.findByFrom = async function (walletId) {
  return this.findByField('from_wallet_id', walletId);
};
allowances.findByTo = async function (walletId) {
  return this.findByField('to_wallet_id', walletId);
};
allowances.findByWallet = async function (walletId) {
  await ensureReady();
  const r = await pool.query(
    'SELECT data FROM "allowances" WHERE data->>$1 = $3 OR data->>$2 = $3',
    ['from_wallet_id', 'to_wallet_id', walletId]
  );
  return r.rows.map((row) => row.data);
};

const trialApplications = createCollection('trialApplications');

const recipientPaths = createCollection('recipientPaths', { allowedJsonFields: ['wallet_id', 'plan_id'] });
recipientPaths.findByWallet = async function (walletId) {
  const byWallet = await this.findByField('wallet_id', walletId);
  if (byWallet.length > 0) return byWallet;
  const crypto = require('crypto');
  const id = crypto.createHash('sha256').update(String(walletId)).digest('hex');
  let r = await this.findById(id);
  if (!r) {
    const legacyId = id.slice(0, 32);
    r = await this.findById(legacyId);
  }
  return r ? [r] : [];
};
recipientPaths.findByWalletPlan = async function (walletId, planId) {
  const rows = await this.findByWallet(walletId);
  return rows.filter((row) => (planId ? row.plan_id === planId : !row.plan_id));
};

const releasedFactors = createCollection('releasedFactors', { allowedJsonFields: ['wallet_id', 'trigger_id', 'plan_id'] });
releasedFactors.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

const kyc = createCollection('kyc');

const accountInvites = createCollection('accountInvites', { allowedJsonFields: ['owner_wallet_id', 'email'] });
accountInvites.findByOwner = async function (ownerWalletId) {
  return this.findByField('owner_wallet_id', ownerWalletId);
};

const walletPlans = createCollection('walletPlans');
const walletAddresses = createCollection('walletAddresses');
const users = createCollection('users');

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

const authorityReleaseLinks = createCollection('authorityReleaseLinks', { allowedJsonFields: ['authority_id'] });
authorityReleaseLinks.findByAuthority = async function (authorityId) {
  return this.findByField('authority_id', authorityId);
};

const userCustomTokens = createCollection('userCustomTokens');
const rwaReleaseRegistry = createCollection('rwaReleaseRegistry');

const rwaDeliveryLog = createCollection('rwaDeliveryLog', { allowedJsonFields: ['wallet_id', 'status', 'plan_id'] });
rwaDeliveryLog.findPending = async function () {
  const pending = await this.findByField('status', 'pending');
  const superseded = await this.findByField('status', 'superseded');
  return [...pending, ...superseded];
};
rwaDeliveryLog.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

const campaigns = createCollection('campaigns');

const referrals = createCollection('referrals', { allowedJsonFields: ['referrer_wallet_id', 'invitee_wallet_id'] });
referrals.findByReferrer = async function (walletId) {
  return this.findByField('referrer_wallet_id', walletId);
};
referrals.findByInvitee = async function (walletId) {
  return this.findByField('invitee_wallet_id', walletId);
};

const activities = createCollection('activities', { allowedJsonFields: ['wallet', 'type', 'status'] });

const adminApprovals = createCollection('adminApprovals', { allowedJsonFields: ['status', 'action'] });
adminApprovals.findPending = async function () {
  return this.findByField('status', 'pending');
};

const walletAdminFactors = createCollection('walletAdminFactors', { allowedJsonFields: ['wallet_id'] });
walletAdminFactors.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

const recipientPathIndex = createCollection('recipientPathIndex', { allowedJsonFields: ['recipient_address', 'wallet_id', 'plan_id'] });
recipientPathIndex.findByRecipientAddress = async function (address) {
  return this.findByField('recipient_address', address);
};
recipientPathIndex.deleteByWalletId = async function (walletId) {
  const entries = await this.findByField('wallet_id', walletId);
  for (const entry of entries) {
    const id = entry.plan_id
      ? `${entry.recipient_address}_${walletId}_${entry.plan_id}`
      : `${entry.recipient_address}_${walletId}`;
    await this.delete(id);
  }
};
recipientPathIndex.deleteByWalletPlan = async function (walletId, planId) {
  const entries = await this.findByField('wallet_id', walletId);
  for (const entry of entries) {
    const entryPlanId = entry.plan_id || null;
    if ((planId || null) !== entryPlanId) continue;
    const id = entryPlanId
      ? `${entry.recipient_address}_${walletId}_${entryPlanId}`
      : `${entry.recipient_address}_${walletId}`;
    await this.delete(id);
  }
};

const mnemonicHashIndex = createCollection('mnemonicHashIndex', { allowedJsonFields: ['mnemonic_hash', 'wallet_id', 'plan_id'] });
mnemonicHashIndex.findByHash = async function (hash) {
  return this.findByField('mnemonic_hash', hash);
};
mnemonicHashIndex.deleteByWalletId = async function (walletId) {
  const entries = await this.findByField('wallet_id', walletId);
  for (const entry of entries) {
    const id = entry.plan_id
      ? `${entry.mnemonic_hash}_${walletId}_${entry.plan_id}`
      : `${entry.mnemonic_hash}_${walletId}`;
    await this.delete(id);
  }
};
mnemonicHashIndex.deleteByWalletPlan = async function (walletId, planId) {
  const entries = await this.findByField('wallet_id', walletId);
  for (const entry of entries) {
    const entryPlanId = entry.plan_id || null;
    if ((planId || null) !== entryPlanId) continue;
    const id = entryPlanId
      ? `${entry.mnemonic_hash}_${walletId}_${entryPlanId}`
      : `${entry.mnemonic_hash}_${walletId}`;
    await this.delete(id);
  }
};

// Agent API Keys (for MCP / external agent integration)
const agentApiKeys = createCollection('agentApiKeys', { allowedJsonFields: ['wallet_id', 'key_hash', 'agent_id'] });
agentApiKeys.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};
agentApiKeys.findByHash = async function (hash) {
  const results = await this.findByField('key_hash', hash);
  return results.length > 0 ? results[0] : null;
};
agentApiKeys.findByAgentId = async function (agentId) {
  const results = await this.findByField('agent_id', agentId);
  return results.length > 0 ? results[0] : null;
};

// Spending Policies (agent API key spending limits)
const spendingPolicies = createCollection('spendingPolicies', { allowedJsonFields: ['wallet_id'] });
spendingPolicies.findByWallet = async function (walletId) {
  return this.findByField('wallet_id', walletId);
};

// Agent Budget Ledger (tracks actual spend per agent API key for rolling budget enforcement)
const agentBudgetLedger = createCollection('agentBudgetLedger', { allowedJsonFields: ['key_id', 'wallet_id', 'policy_id'] });
agentBudgetLedger.findByKey = async function (keyId) {
  return this.findByField('key_id', keyId);
};
agentBudgetLedger.findByPolicy = async function (policyId) {
  return this.findByField('policy_id', policyId);
};

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
  agentApiKeys,
  spendingPolicies,
  agentBudgetLedger,
  ensureReady,
  async _close() {
    await pool.end();
  },
  _getDb: () => pool,
  async _saveToDisk() {
    // no-op for Postgres backend
  },
};
