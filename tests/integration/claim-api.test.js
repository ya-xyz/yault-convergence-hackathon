/**
 * Claim API Integration Tests
 *
 * Coverage:
 * - GET  /api/claim/me — list released items for logged-in recipient
 * - GET  /api/claim/plan-releases — plan-based releases with admin factor
 * - POST /api/claim/get-admin-factor — retrieve admin factor by mnemonic hash
 * - POST /api/claim/update-wallet-json — store wallet JSON after derivation
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-claim-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

// Mock xidentity encryption (ESM-only @yallet/rwa-sdk unavailable in Jest)
jest.mock('../../server/services/xidentityAdminFactor', () => ({
  encryptAdminFactorForXidentity: jest.fn(async (hex) => ({ ciphertext: hex, algorithm: 'mock' })),
  normalizeAdminFactorHex: jest.fn((v) => String(v || '').trim().toLowerCase().replace(/^0x/i, '')),
}));

const nacl = require('tweetnacl');

let app;
let request;

beforeAll(() => {
  const supertest = require('supertest');
  app = require('../../server/index');
  request = supertest(app);
});

afterAll(() => {
  const db = require('../../server/db');
  db._close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch (_) {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
    secretKey: kp.secretKey,
  };
}

async function authenticate(pubkeyHex, secretKey) {
  const challengeRes = await request
    .post('/api/auth/challenge')
    .send({ pubkey: pubkeyHex })
    .expect(200);
  const { challenge_id, challenge } = challengeRes.body;
  const sig = nacl.sign.detached(Buffer.from(challenge, 'hex'), secretKey);
  return { challenge_id, signature: Buffer.from(sig).toString('hex') };
}

async function getSessionToken(pubkeyHex, secretKey) {
  const auth = await authenticate(pubkeyHex, secretKey);
  const res = await request.post('/api/auth/verify').send(auth).expect(200);
  return res.body.session_token;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Seed walletAddresses with xidentity for a given public key (required by claim endpoints). */
async function seedXidentity(pubkeyHex) {
  const db = require('../../server/db');
  const addr = pubkeyHex.toLowerCase();
  await db.walletAddresses.create(addr, {
    evm_address: '0x' + addr,
    xidentity: 'test-xid-' + addr.slice(0, 16),
  });
}

describe('Claim /me endpoint', () => {
  let recipientKp;
  let recipientSession;

  beforeAll(async () => {
    recipientKp = generateKeypair();
    recipientSession = await getSessionToken(recipientKp.publicKey, recipientKp.secretKey);
    await seedXidentity(recipientKp.publicKey);
  });

  test('returns empty items when no releases exist', async () => {
    const res = await request
      .get('/api/claim/me')
      .set('X-Client-Session', recipientSession)
      .expect(200);

    expect(res.body.items).toEqual([]);
  });

  test('returns plan-flow items when recipientMnemonicAdmin has admin_factor', async () => {
    const db = require('../../server/db');
    const mnemonicHash = 'a'.repeat(64);
    const recipientAddr = recipientKp.publicKey.toLowerCase();

    await db.recipientMnemonicAdmin.create(mnemonicHash, {
      evm_address: '0x' + recipientAddr,
      mnemonic_hash: mnemonicHash,
      admin_factor: 'f'.repeat(64),
      label: 'Test Release',
      plan_wallet_id: 'owner-wallet',
      created_at: new Date().toISOString(),
    });

    const res = await request
      .get('/api/claim/me')
      .set('X-Client-Session', recipientSession)
      .expect(200);

    const planItems = res.body.items.filter(i => i.source === 'plan');
    expect(planItems.length).toBeGreaterThanOrEqual(1);
    expect(planItems[0].encrypted_admin_factor).toBeDefined();
    expect(planItems[0].label).toBe('Test Release');
  });

  test('requires authentication', async () => {
    await request.get('/api/claim/me').expect(401);
  });
});

describe('Claim plan-releases endpoint', () => {
  let recipientKp;
  let recipientSession;

  beforeAll(async () => {
    recipientKp = generateKeypair();
    recipientSession = await getSessionToken(recipientKp.publicKey, recipientKp.secretKey);
    await seedXidentity(recipientKp.publicKey);

    const db = require('../../server/db');
    const recipientAddr = recipientKp.publicKey.toLowerCase();

    // Seed with admin_factor (released)
    await db.recipientMnemonicAdmin.create('1'.repeat(64), {
      evm_address: '0x' + recipientAddr,
      mnemonic_hash: '1'.repeat(64),
      admin_factor: 'af1'.padEnd(64, '0'),
      label: 'Released Item',
      plan_wallet_id: 'wallet-1',
      created_at: new Date().toISOString(),
    });

    // Seed without admin_factor (not yet released)
    await db.recipientMnemonicAdmin.create('2'.repeat(64), {
      evm_address: '0x' + recipientAddr,
      mnemonic_hash: '2'.repeat(64),
      admin_factor: null,
      label: 'Pending Item',
      plan_wallet_id: 'wallet-2',
      created_at: new Date().toISOString(),
    });
  });

  test('returns only items with admin_factor set', async () => {
    const res = await request
      .get('/api/claim/plan-releases')
      .set('X-Client-Session', recipientSession)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    const hasNullFactor = res.body.items.some(i => !i.encrypted_admin_factor);
    expect(hasNullFactor).toBe(false);
    expect(res.body.items[0].label).toBe('Released Item');
  });

  test('requires authentication', async () => {
    await request.get('/api/claim/plan-releases').expect(401);
  });
});

describe('Claim get-admin-factor endpoint', () => {
  let recipientKp;
  let recipientSession;
  const mnemonicHash = '3'.repeat(64);
  const adminFactor = 'af3'.padEnd(64, '0');

  beforeAll(async () => {
    recipientKp = generateKeypair();
    recipientSession = await getSessionToken(recipientKp.publicKey, recipientKp.secretKey);
    await seedXidentity(recipientKp.publicKey);

    const db = require('../../server/db');
    const recipientAddr = recipientKp.publicKey.toLowerCase();

    await db.recipientMnemonicAdmin.create(mnemonicHash, {
      evm_address: '0x' + recipientAddr,
      mnemonic_hash: mnemonicHash,
      admin_factor: adminFactor,
      label: 'Test',
      plan_wallet_id: 'wallet-3',
      created_at: new Date().toISOString(),
    });
  });

  test('returns admin_factor for valid mnemonic_hash', async () => {
    const recipientAddr = recipientKp.publicKey.toLowerCase();
    const res = await request
      .post('/api/claim/get-admin-factor')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + recipientAddr,
        mnemonic_hash: mnemonicHash,
      })
      .expect(200);

    expect(res.body.encrypted_admin_factor).toBeDefined();
  });

  test('returns 403 when evm_address does not match logged-in wallet', async () => {
    await request
      .post('/api/claim/get-admin-factor')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + 'ff'.repeat(20),
        mnemonic_hash: mnemonicHash,
      })
      .expect(403);
  });

  test('returns 404 for non-existent mnemonic_hash', async () => {
    const recipientAddr = recipientKp.publicKey.toLowerCase();
    await request
      .post('/api/claim/get-admin-factor')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + recipientAddr,
        mnemonic_hash: '9'.repeat(64),
      })
      .expect(404);
  });

  test('returns 400 for invalid mnemonic_hash format', async () => {
    await request
      .post('/api/claim/get-admin-factor')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + recipientKp.publicKey.toLowerCase(),
        mnemonic_hash: 'invalid',
      })
      .expect(400);
  });

  test('returns 404 when admin_factor is not yet linked', async () => {
    const db = require('../../server/db');
    const recipientAddr = recipientKp.publicKey.toLowerCase();
    const hash = '4'.repeat(64);
    await db.recipientMnemonicAdmin.create(hash, {
      evm_address: '0x' + recipientAddr,
      mnemonic_hash: hash,
      admin_factor: null,
      label: 'No factor yet',
      created_at: new Date().toISOString(),
    });

    await request
      .post('/api/claim/get-admin-factor')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + recipientAddr,
        mnemonic_hash: hash,
      })
      .expect(404);
  });
});

describe('Claim update-wallet-json endpoint', () => {
  let recipientKp;
  let recipientSession;
  const mnemonicHash = '5'.repeat(64);

  beforeAll(async () => {
    recipientKp = generateKeypair();
    recipientSession = await getSessionToken(recipientKp.publicKey, recipientKp.secretKey);

    const db = require('../../server/db');
    const recipientAddr = recipientKp.publicKey.toLowerCase();

    await db.recipientMnemonicAdmin.create(mnemonicHash, {
      evm_address: '0x' + recipientAddr,
      mnemonic_hash: mnemonicHash,
      admin_factor: 'af5'.padEnd(64, '0'),
      label: 'Wallet JSON Test',
      created_at: new Date().toISOString(),
    });
  });

  test('stores wallet_json for matching record', async () => {
    const recipientAddr = recipientKp.publicKey.toLowerCase();
    const walletJson = { accounts: [{ chain: 'ethereum', address: '0xtest' }] };

    const res = await request
      .post('/api/claim/update-wallet-json')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + recipientAddr,
        mnemonic_hash: mnemonicHash,
        wallet_json: walletJson,
      })
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify stored in DB
    const db = require('../../server/db');
    const record = await db.recipientMnemonicAdmin.findById(mnemonicHash);
    expect(record.wallet_json).toEqual(walletJson);
  });

  test('rejects when evm_address does not match caller', async () => {
    await request
      .post('/api/claim/update-wallet-json')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + 'ff'.repeat(20),
        mnemonic_hash: mnemonicHash,
        wallet_json: {},
      })
      .expect(403);
  });

  test('rejects invalid mnemonic_hash format', async () => {
    await request
      .post('/api/claim/update-wallet-json')
      .set('X-Client-Session', recipientSession)
      .send({
        evm_address: '0x' + recipientKp.publicKey.toLowerCase(),
        mnemonic_hash: 'bad',
        wallet_json: {},
      })
      .expect(400);
  });
});
