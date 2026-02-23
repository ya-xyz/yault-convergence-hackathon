/**
 * Session Token Authentication Tests
 *
 * Coverage:
 * - Session token generation on /api/auth/verify
 * - X-Client-Session header auth for data APIs
 * - Session token expiry
 * - dualAuthMiddleware mode switching (session → challenge-response)
 */

'use strict';

const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-session-' + Date.now() + '.db');
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

describe('Session Token Generation', () => {
  test('verify returns session_token on success', async () => {
    const kp = generateKeypair();
    const auth = await authenticate(kp.publicKey, kp.secretKey);

    const res = await request
      .post('/api/auth/verify')
      .send(auth)
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.session_token).toBeTruthy();
    expect(typeof res.body.session_token).toBe('string');
    expect(res.body.session_token).toContain('.'); // base64url.signature format
  });

  test('creates user record on first login', async () => {
    const kp = generateKeypair();
    const auth = await authenticate(kp.publicKey, kp.secretKey);
    await request.post('/api/auth/verify').send(auth).expect(200);

    const db = require('../../server/db');
    const walletId = kp.publicKey.toLowerCase();
    const user = await db.users.findById(walletId);
    expect(user).not.toBeNull();
    expect(user.wallet_id).toBe(walletId);
  });
});

describe('Session Token Auth for Data APIs', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    const auth = await authenticate(kp.publicKey, kp.secretKey);
    const res = await request.post('/api/auth/verify').send(auth).expect(200);
    sessionToken = res.body.session_token;
  });

  test('X-Client-Session works for protected endpoints', async () => {
    const res = await request
      .get('/api/wallet-plan')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body).toHaveProperty('plan');
  });

  test('X-Client-Session works for PUT endpoints', async () => {
    const res = await request
      .put('/api/wallet-plan')
      .set('X-Client-Session', sessionToken)
      .send({ triggerTypes: { oracle: true }, recipients: [], triggerConfig: {} })
      .expect(200);

    expect(res.body.plan).toBeDefined();
  });

  test('rejects invalid session token', async () => {
    await request
      .get('/api/wallet-plan')
      .set('X-Client-Session', 'invalid-token')
      .expect(401);
  });

  test('rejects tampered session token', async () => {
    // Flip a character in the signature part
    const parts = sessionToken.split('.');
    const tamperedSig = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts[0] + '.' + tamperedSig;

    await request
      .get('/api/wallet-plan')
      .set('X-Client-Session', tampered)
      .expect(401);
  });
});

describe('Challenge-Response Auth fallback', () => {
  test('Ed25519 Authorization header still works', async () => {
    const kp = generateKeypair();
    const auth = await authenticate(kp.publicKey, kp.secretKey);

    // Use challenge-response for a session-enabled endpoint
    const res = await request
      .get('/api/wallet-plan')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(res.body).toHaveProperty('plan');
  });
});

describe('Session Token Utility Functions', () => {
  test('createClientSessionToken and verifyClientSessionToken round-trip', () => {
    const { createClientSessionToken, verifyClientSessionToken } = require('../../server/middleware/auth');

    const pubkey = 'a'.repeat(64);
    const token = createClientSessionToken(pubkey);
    const result = verifyClientSessionToken(token);

    expect(result).not.toBeNull();
    expect(result.pubkey).toBe(pubkey);
  });

  test('verifyClientSessionToken rejects null/empty', () => {
    const { verifyClientSessionToken } = require('../../server/middleware/auth');

    expect(verifyClientSessionToken(null)).toBeNull();
    expect(verifyClientSessionToken('')).toBeNull();
    expect(verifyClientSessionToken('no-dot')).toBeNull();
  });

  test('verifyClientSessionToken rejects expired token', () => {
    const { verifyClientSessionToken } = require('../../server/middleware/auth');
    const crypto = require('crypto');

    // Manually craft an expired token
    const SESSION_SECRET = process.env.CLIENT_SESSION_SECRET || 'yallet-client-session-dev';
    const payload = { p: 'a'.repeat(64), e: Math.floor(Date.now() / 1000) - 100 }; // expired 100s ago
    const raw = JSON.stringify(payload);
    const b64 = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest();
    const sigB64 = sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = b64 + '.' + sigB64;

    expect(verifyClientSessionToken(token)).toBeNull();
  });
});
