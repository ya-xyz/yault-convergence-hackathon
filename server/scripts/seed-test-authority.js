/**
 * Seed a test Authority so the same wallet can act as Client, Authority, and Ops.
 * Run from repo root: node server/scripts/seed-test-authority.js
 *
 * Test wallet: 0x00e1304043f99B88F89e7f7a742dc0D66a1de17a
 * - Add to ADMIN_WALLETS in .env for Ops access.
 * - This script creates the Authority record for Authority portal access.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

// Allow running from repo root (node server/scripts/seed-test-authority.js)
const serverDir = path.resolve(__dirname, '..');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(serverDir, '..', 'data', 'yallet.db');

const db = require('../db');

const TEST_ADDRESS = '0x00e1304043f99B88F89e7f7a742dc0D66a1de17a';
const ADDR_HEX = TEST_ADDRESS.replace(/^0x/i, '').toLowerCase();

async function main() {
  await db.ensureReady();

  const authorityId = crypto.createHash('sha256').update(ADDR_HEX, 'hex').digest('hex');

  const existing = await db.authorities.findById(authorityId);
  if (existing) {
    console.log('Authority already exists:', authorityId);
    console.log('Name:', existing.name);
    process.exit(0);
    return;
  }

  const record = {
    authority_id: authorityId,
    name: 'Test Authority (3-Role)',
    bar_number: 'TEST-001',
    jurisdiction: 'Test',
    region: 'Test',
    specialization: ['Asset release', 'Compliance'],
    languages: ['en', 'zh'],
    pubkey: ADDR_HEX,
    fee_structure: { base_fee_bps: 500, flat_fee_usd: 0, currency: 'USD' },
    email: null,
    website: null,
    verified: true,
    rating: null,
    rating_count: 0,
    active_bindings: 0,
    max_capacity: 100,
    created_at: new Date().toISOString(),
  };

  await db.authorities.create(authorityId, record);
  console.log('Created test Authority:');
  console.log('  authority_id:', authorityId);
  console.log('  wallet:      ', TEST_ADDRESS);
  console.log('  name:        ', record.name);
  console.log('');
  console.log('Add to .env for Ops access:');
  console.log('  ADMIN_WALLETS=' + TEST_ADDRESS);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
