/**
 * User Profile, Addresses & Custom Tokens API Integration Tests
 *
 * Coverage:
 * - GET/PATCH /api/me/profile — user profile CRUD
 * - GET/PUT   /api/me/addresses — multi-chain address management
 * - GET/POST  /api/me/tokens — custom token management
 * - Address ownership validation
 */

'use strict';

const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-profile-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

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

// ---------------------------------------------------------------------------
// Profile Tests
// ---------------------------------------------------------------------------

describe('User Profile', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('GET /api/me/profile returns default profile', async () => {
    const res = await request
      .get('/api/me/profile')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.address).toBeTruthy();
    expect(res.body.name).toBeDefined();
    expect(res.body.email).toBeDefined();
  });

  test('PATCH /api/me/profile updates profile', async () => {
    const res = await request
      .patch('/api/me/profile')
      .set('X-Client-Session', sessionToken)
      .send({
        name: 'Test User',
        email: 'test@example.com',
        phone: '+1234567890',
        physical_address: '123 Test St',
      })
      .expect(200);

    expect(res.body.name).toBe('Test User');
    expect(res.body.email).toBe('test@example.com');
    expect(res.body.phone).toBe('+1234567890');
    expect(res.body.physical_address).toBe('123 Test St');
  });

  test('GET /api/me/profile returns updated profile', async () => {
    const res = await request
      .get('/api/me/profile')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.name).toBe('Test User');
    expect(res.body.email).toBe('test@example.com');
  });

  test('PATCH /api/me/profile partial update', async () => {
    const res = await request
      .patch('/api/me/profile')
      .set('X-Client-Session', sessionToken)
      .send({ name: 'Updated Name' })
      .expect(200);

    expect(res.body.name).toBe('Updated Name');
    expect(res.body.email).toBe('test@example.com'); // unchanged
  });

  test('requires authentication', async () => {
    await request.get('/api/me/profile').expect(401);
    await request.patch('/api/me/profile').send({ name: 'x' }).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Addresses Tests
// ---------------------------------------------------------------------------

describe('User Addresses', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('GET /api/me/addresses returns null initially', async () => {
    const res = await request
      .get('/api/me/addresses')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.addresses).toBeNull();
  });

  test('PUT /api/me/addresses saves multi-chain addresses', async () => {
    const res = await request
      .put('/api/me/addresses')
      .set('X-Client-Session', sessionToken)
      .send({
        addresses: {
          bitcoin_address: 'bc1qtest123',
          solana_address: 'SoLanaAddress123',
          cosmos_address: 'cosmos1test',
          polkadot_address: '1PolkaDot',
        },
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.addresses.bitcoin_address).toBe('bc1qtest123');
    expect(res.body.addresses.solana_address).toBe('SoLanaAddress123');
  });

  test('GET /api/me/addresses returns saved addresses', async () => {
    const res = await request
      .get('/api/me/addresses')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.addresses).not.toBeNull();
    expect(res.body.addresses.bitcoin_address).toBe('bc1qtest123');
  });

  test('PUT rejects mismatched evm_address', async () => {
    await request
      .put('/api/me/addresses')
      .set('X-Client-Session', sessionToken)
      .send({
        addresses: { evm_address: '0x' + 'ff'.repeat(20) },
      })
      .expect(400);
  });

  test('PUT rejects missing addresses object', async () => {
    await request
      .put('/api/me/addresses')
      .set('X-Client-Session', sessionToken)
      .send({})
      .expect(400);
  });

  test('requires authentication', async () => {
    await request.get('/api/me/addresses').expect(401);
    await request.put('/api/me/addresses').send({ addresses: {} }).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Custom Tokens Tests
// ---------------------------------------------------------------------------

describe('User Custom Tokens', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('GET /api/me/tokens returns empty list initially', async () => {
    const res = await request
      .get('/api/me/tokens')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.tokens).toEqual([]);
  });

  test('POST /api/me/tokens adds a custom token', async () => {
    const res = await request
      .post('/api/me/tokens')
      .set('X-Client-Session', sessionToken)
      .send({
        chain_key: 'ethereum',
        chain_id: 1,
        token_name: 'USDC',
        contract_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  test('GET /api/me/tokens?chain=ethereum returns filtered tokens', async () => {
    // Add another token on polygon
    await request
      .post('/api/me/tokens')
      .set('X-Client-Session', sessionToken)
      .send({
        chain_key: 'polygon',
        chain_id: 137,
        token_name: 'MATIC-USDC',
        contract_address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
      })
      .expect(200);

    const res = await request
      .get('/api/me/tokens')
      .query({ chain: 'ethereum' })
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.tokens.length).toBe(1);
    expect(res.body.tokens[0].token_name).toBe('USDC');
    expect(res.body.tokens[0].chain_key).toBe('ethereum');
  });

  test('GET /api/me/tokens without chain returns all', async () => {
    const res = await request
      .get('/api/me/tokens')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.tokens.length).toBe(2);
  });

  test('POST rejects missing required fields', async () => {
    await request
      .post('/api/me/tokens')
      .set('X-Client-Session', sessionToken)
      .send({ chain_key: 'ethereum' })
      .expect(400);
  });

  test('requires authentication', async () => {
    await request.get('/api/me/tokens').expect(401);
    await request.post('/api/me/tokens').send({}).expect(401);
  });
});
