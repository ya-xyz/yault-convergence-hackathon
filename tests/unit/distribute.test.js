'use strict';

/**
 * Integration tests for POST /api/release/distribute validation and idempotency.
 *
 * Tests the router logic with real Express app and SQLite:
 * - Mixed RWA + legacy package rejection
 * - rwa_upload_body schema validation
 * - Distribute idempotency (duplicate binding rejection)
 * - Array.isArray guard on encrypted_packages
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Use a temp database for tests
const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-distribute-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-distribute';

const nacl = require('tweetnacl');

let app;
let request;
let db;

beforeAll(() => {
  const supertest = require('supertest');
  app = require('../../server/index');
  request = supertest(app);
  db = require('../../server/db');
});

afterAll(() => {
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
  const messageBytes = Buffer.from(challenge, 'hex');
  const signature = nacl.sign.detached(messageBytes, secretKey);
  const signatureHex = Buffer.from(signature).toString('hex');

  return { challenge_id, signature: signatureHex };
}

async function getSessionToken(pubkeyHex, secretKey) {
  const auth = await authenticate(pubkeyHex, secretKey);
  const res = await request.post('/api/auth/verify').send(auth).expect(200);
  return res.body.session_token;
}

async function registerAndVerifyAuthority() {
  const kp = generateKeypair();
  const profile = {
    name: 'Test Authority',
    bar_number: 'BAR-' + crypto.randomBytes(4).toString('hex'),
    jurisdiction: 'US-CA',
    specialization: ['asset-release'],
    languages: ['en'],
    pubkey: kp.publicKey,
    email: 'test@authority.example',
  };

  const regRes = await request
    .post('/api/authority/register')
    .send(profile)
    .expect(201);
  const authorityId = regRes.body.authority_id;

  // Admin-verify the authority
  await request
    .post(`/api/authority/${authorityId}/verify`)
    .set('X-Admin-Token', process.env.ADMIN_TOKEN)
    .send({ verification_proof: 'test-proof' })
    .expect(200);

  return { authorityId, keypair: kp };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/release/distribute', () => {
  let walletKp;
  let sessionToken;
  let authorityId;

  beforeAll(async () => {
    walletKp = generateKeypair();
    sessionToken = await getSessionToken(walletKp.publicKey, walletKp.secretKey);
    const auth = await registerAndVerifyAuthority();
    authorityId = auth.authorityId;
  });

  function distributeWithAuth(body) {
    return request
      .post('/api/release/distribute')
      .set('X-Client-Session', sessionToken)
      .send(body);
  }

  test('rejects non-array encrypted_packages', async () => {
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: 'not-an-array',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation failed/i);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/non-empty array/)])
    );
  });

  test('rejects empty encrypted_packages array', async () => {
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: [],
    });
    expect(res.status).toBe(400);
  });

  test('rejects rwa_upload_body without recipient_solana_address', async () => {
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: [
        { index: 0, rwa_upload_body: { data: 'test', leafOwner: 'addr' } },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/recipient_solana_address/)])
    );
  });

  test('rejects rwa_upload_body missing data or leafOwner fields', async () => {
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: [
        { index: 0, recipient_solana_address: 'sol-addr', rwa_upload_body: { something: 'else' } },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/data.*leafOwner/)])
    );
  });

  test('rejects mixed RWA and legacy packages', async () => {
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: [
        { index: 0, recipient_solana_address: 'sol-addr', rwa_upload_body: { data: 'x', leafOwner: 'y' } },
        { index: 1, package_hex: 'aabbccdd', ephemeral_pubkey_hex: '1'.repeat(64) },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Mixed package types/i);
  });

  test('rejects distribute for wrong wallet (auth mismatch)', async () => {
    const res = await distributeWithAuth({
      wallet_id: 'some-other-wallet-pubkey',
      authority_id: authorityId,
      encrypted_packages: [{ index: 0, package_hex: 'aa', ephemeral_pubkey_hex: 'bb' }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Forbidden/i);
  });

  test('creates legacy binding successfully', async () => {
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: [
        { index: 0, package_hex: 'aabbccdd', ephemeral_pubkey_hex: '1'.repeat(64) },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('binding_id');
    expect(res.body.status).toBe('active');
  });

  test('replaces existing binding when distributing again for same wallet + authority', async () => {
    // The previous test already created an active binding for walletKp + authorityId.
    // A new distribute should replace the old binding (not reject with 409).
    const res = await distributeWithAuth({
      wallet_id: walletKp.publicKey,
      authority_id: authorityId,
      encrypted_packages: [
        { index: 0, package_hex: 'eeff0011', ephemeral_pubkey_hex: '2'.repeat(64) },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('binding_id');
    expect(res.body.status).toBe('active');
  });
});
