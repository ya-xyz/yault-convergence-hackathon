/**
 * Vault API Integration Tests (stub mode — no VAULT_ADDRESS)
 *
 * Coverage:
 * - GET  /api/vault/balance/:address — query vault balance
 * - POST /api/vault/deposit — deposit to vault
 * - POST /api/vault/redeem — redeem vault shares
 * - POST /api/vault/harvest — harvest yield
 * - Ownership checks (cannot view/operate on others' vault)
 */

'use strict';

const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-vault-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
// Force stub mode — disable on-chain vault contract calls
process.env.VAULT_ADDRESS = '';

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

describe('Vault Balance', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('GET /api/vault/balance/:address returns zero for new user', async () => {
    const res = await request
      .get(`/api/vault/balance/${kp.publicKey}`)
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.address).toBe(kp.publicKey.toLowerCase());
    expect(res.body.vault).toBeDefined();
    expect(res.body.vault.source).toBe('db');
    expect(res.body.wallet).toBeDefined();
  });

  test('rejects request for other user address', async () => {
    const other = generateKeypair();
    await request
      .get(`/api/vault/balance/${other.publicKey}`)
      .set('X-Client-Session', sessionToken)
      .expect(403);
  });

  test('rejects invalid address format', async () => {
    await request
      .get('/api/vault/balance/invalid')
      .set('X-Client-Session', sessionToken)
      .expect(400);
  });

  test('requires authentication', async () => {
    await request
      .get(`/api/vault/balance/${kp.publicKey}`)
      .expect(401);
  });
});

describe('Vault Deposit (stub)', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('deposits and updates position', async () => {
    const res = await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: '100', asset: 'ETH' })
      .expect(200);

    expect(res.body.status).toBe('deposited');
    expect(res.body.amount).toBe('100.0000');
    expect(res.body.shares_received).toBe('100.0000');

    // Verify balance updated
    const balRes = await request
      .get(`/api/vault/balance/${kp.publicKey}`)
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(parseFloat(balRes.body.vault.shares)).toBe(100);
    expect(parseFloat(balRes.body.vault.value)).toBe(100);
  });

  test('rejects deposit to another address', async () => {
    const other = generateKeypair();
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: other.publicKey, amount: '50' })
      .expect(403);
  });

  test('rejects non-positive amount', async () => {
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: '-10' })
      .expect(400);
  });

  test('rejects "max" amount', async () => {
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: 'max' })
      .expect(400);
  });

  test('rejects missing address', async () => {
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ amount: '10' })
      .expect(400);
  });
});

describe('Vault Redeem (stub)', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);

    // Deposit first
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: '200' })
      .expect(200);
  });

  test('redeems shares successfully', async () => {
    const res = await request
      .post('/api/vault/redeem')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, shares: '50' })
      .expect(200);

    expect(res.body.status).toBe('redeemed');
    expect(res.body.shares_redeemed).toBe('50.0000');
    expect(parseFloat(res.body.assets_returned)).toBeGreaterThan(0);
  });

  test('redeems "max" shares', async () => {
    // Deposit more for this test
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: '100' })
      .expect(200);

    const res = await request
      .post('/api/vault/redeem')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, shares: 'max' })
      .expect(200);

    expect(res.body.status).toBe('redeemed');
  });

  test('rejects redeem from another address', async () => {
    const other = generateKeypair();
    await request
      .post('/api/vault/redeem')
      .set('X-Client-Session', sessionToken)
      .send({ address: other.publicKey, shares: '10' })
      .expect(403);
  });

  test('rejects insufficient shares', async () => {
    // After max redeem above, shares should be 0
    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: '10' })
      .expect(200);

    await request
      .post('/api/vault/redeem')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, shares: '99999' })
      .expect(400);
  });
});

describe('Vault Harvest (stub)', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);

    await request
      .post('/api/vault/deposit')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey, amount: '1000' })
      .expect(200);
  });

  test('harvests yield (80/15/5 split)', async () => {
    const res = await request
      .post('/api/vault/harvest')
      .set('X-Client-Session', sessionToken)
      .send({ address: kp.publicKey })
      .expect(200);

    expect(res.body.status).toBe('harvested');
    expect(parseFloat(res.body.gross_yield)).toBeGreaterThan(0);
    expect(parseFloat(res.body.harvested)).toBeGreaterThan(0);
    expect(parseFloat(res.body.platform_fee)).toBeGreaterThan(0);
    expect(parseFloat(res.body.authority_fee)).toBeGreaterThan(0);

    // Verify 80/15/5 split
    const gross = parseFloat(res.body.gross_yield);
    expect(parseFloat(res.body.harvested)).toBeCloseTo(gross * 0.8, 2);
    expect(parseFloat(res.body.platform_fee)).toBeCloseTo(gross * 0.15, 2);
    expect(parseFloat(res.body.authority_fee)).toBeCloseTo(gross * 0.05, 2);
  });

  test('rejects harvest for another address', async () => {
    const other = generateKeypair();
    await request
      .post('/api/vault/harvest')
      .set('X-Client-Session', sessionToken)
      .send({ address: other.publicKey })
      .expect(403);
  });
});
