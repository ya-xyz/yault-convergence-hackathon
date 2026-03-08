'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

const TABLES = ['authorities', 'bindings', 'triggers', 'revenue', 'withdrawals', 'auditLog', 'vaultPositions', 'adminSessions', 'authoritySessions', 'insurancePolicies', 'subAccounts', 'allowances', 'trialApplications', 'recipientPaths', 'releasedFactors', 'kyc', 'accountInvites', 'walletPlans', 'walletAddresses', 'users', 'recipientMnemonicAdmin', 'authorityReleaseLinks', 'userCustomTokens', 'rwaReleaseRegistry', 'rwaDeliveryLog', 'campaigns', 'referrals', 'activities', 'adminApprovals', 'walletAdminFactors', 'recipientPathIndex', 'mnemonicHashIndex'];

async function main() {
  const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'yault.db');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);

  const SQL = await initSqlJs();
  const sqlite = new SQL.Database(fs.readFileSync(sqlitePath));
  const pg = new Pool({ connectionString: databaseUrl });

  try {
    const client = await pg.connect();
    try {
      for (const table of TABLES) {
        await client.query(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
      }

      for (const table of TABLES) {
        const rs = sqlite.exec(`SELECT id, data FROM "${table}"`);
        const rows = (rs[0] && rs[0].values) ? rs[0].values : [];
        if (rows.length === 0) {
          console.log(`[migrate] ${table}: 0 rows`);
          continue;
        }

        await client.query('BEGIN');
        try {
          for (const [id, data] of rows) {
            await client.query(
              `INSERT INTO "${table}" (id, data) VALUES ($1, $2::jsonb)
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
              [id, data]
            );
          }
          await client.query('COMMIT');
          console.log(`[migrate] ${table}: ${rows.length} rows`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pg.end();
    try { sqlite.close(); } catch (_) {}
  }

  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
