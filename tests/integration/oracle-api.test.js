/**
 * Integration tests for Oracle API routes
 *
 * - GET /api/trigger/attestation
 * - POST /api/trigger/from-oracle
 * - GET /api/oracle/pending
 *
 * Uses a temporary DB and mocks attestationClient.getAttestation so no real chain is needed.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-oracle-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-oracle';
process.env.MULTISIG_DISABLED = 'true';
process.env.ORACLE_ATTESTATION_ENABLED = 'true';
process.env.RELEASE_ATTESTATION_ADDRESS = '0x0000000000000000000000000000000000000001';
process.env.ORACLE_INTERNAL_API_KEY = 'test-oracle-key';

const nacl = require('tweetnacl');

jest.mock('../../server/services/attestationClient', () => ({
  getAttestation: jest.fn(),
  hasAttestation: jest.fn(),
  walletIdHash: jest.fn((id) => '0x' + '00'.repeat(32)),
}));

const { getAttestation } = require('../../server/services/attestationClient');

let app;
let request;
let sessionToken;

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

beforeAll(async () => {
  const supertest = require('supertest');
  app = require('../../server/index');
  request = supertest(app);

  // Get a session token for authenticated requests
  const kp = generateKeypair();
  const auth = await authenticate(kp.publicKey, kp.secretKey);
  const verifyRes = await request.post('/api/auth/verify').send(auth).expect(200);
  sessionToken = verifyRes.body.session_token;
});

afterAll(() => {
  const db = require('../../server/db');
  if (db._close) db._close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch (_) { /* ignore */ }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/trigger/attestation', () => {
  test('returns oracle_enabled: true and attestation when oracle is enabled', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'release',
      reasonCode: '0x00',
      evidenceHash: '0x' + 'ab'.repeat(32),
      timestamp: 12345,
      submitter: '0x1234',
    });

    const res = await request
      .get('/api/trigger/attestation')
      .set('X-Client-Session', sessionToken)
      .query({ wallet_id: 'wallet-1', recipient_index: 0 })
      .expect(200);

    expect(res.body.oracle_enabled).toBe(true);
    expect(res.body.attestation).not.toBeNull();
    expect(res.body.attestation.source).toBe('oracle');
    expect(res.body.attestation.decision).toBe('release');
    expect(getAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wallet-1',
        recipientIndex: 0,
      })
    );
  });

  test('returns attestation: null when getAttestation returns null', async () => {
    getAttestation.mockResolvedValue(null);

    const res = await request
      .get('/api/trigger/attestation')
      .set('X-Client-Session', sessionToken)
      .query({ wallet_id: 'w2', recipient_index: 1 })
      .expect(200);

    expect(res.body.oracle_enabled).toBe(true);
    expect(res.body.attestation).toBeNull();
  });

  test('returns 400 when wallet_id or recipient_index missing', async () => {
    await request.get('/api/trigger/attestation').set('X-Client-Session', sessionToken).query({ wallet_id: 'w1' }).expect(400);
    await request.get('/api/trigger/attestation').set('X-Client-Session', sessionToken).query({ recipient_index: 0 }).expect(400);
  });

  test('returns 400 when recipient_index is invalid', async () => {
    await request
      .get('/api/trigger/attestation')
      .set('X-Client-Session', sessionToken)
      .query({ wallet_id: 'w1', recipient_index: -1 })
      .expect(400);
    await request
      .get('/api/trigger/attestation')
      .set('X-Client-Session', sessionToken)
      .query({ wallet_id: 'w1', recipient_index: 'not-a-number' })
      .expect(400);
    await request
      .get('/api/trigger/attestation')
      .set('X-Client-Session', sessionToken)
      .query({ wallet_id: 'w1', recipient_index: '1abc' })
      .expect(400);
  });
});

describe('POST /api/trigger/from-oracle', () => {
  const oracleKeyHeader = { 'X-Oracle-Internal-Key': 'test-oracle-key' };
  const planId = 'test-plan-1';

  test('returns 404 when no oracle attestation on chain', async () => {
    getAttestation.mockResolvedValue(null);

    const res = await request
      .post('/api/trigger/from-oracle')
      .set(oracleKeyHeader)
      .send({ wallet_id: 'wallet-xyz', recipient_index: 0, plan_id: planId })
      .expect(404);

    expect(res.body.error).toContain('No oracle attestation');
  });

  test('returns 400 when oracle attestation is not release', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'hold',
      evidenceHash: '0x' + '00'.repeat(32),
      timestamp: 1,
      submitter: '0x1',
    });

    await request
      .post('/api/trigger/from-oracle')
      .set(oracleKeyHeader)
      .send({ wallet_id: 'w1', recipient_index: 0, plan_id: planId })
      .expect(400);
  });

  test('returns 201 and creates trigger when oracle attestation is release', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'release',
      reasonCode: '0x00',
      evidenceHash: '0x' + 'ef'.repeat(32),
      timestamp: 999,
      submitter: '0xOracle',
    });

    const res = await request
      .post('/api/trigger/from-oracle')
      .set(oracleKeyHeader)
      .send({ wallet_id: 'wallet-release-1', recipient_index: 0, plan_id: planId })
      .expect(201);

    expect(res.body.trigger_id).toBeTruthy();
    expect(res.body.status).toBe('cooldown');
    expect(res.body.trigger_type).toBe('oracle');
    expect(res.body.decision).toBe('release');
    expect(res.body.effective_at).toBeGreaterThan(Date.now());

    getAttestation.mockResolvedValue(null);
    const attestRes = await request
      .get('/api/trigger/attestation')
      .set('X-Client-Session', sessionToken)
      .query({ wallet_id: 'wallet-release-1', recipient_index: 0 });
    expect(attestRes.body.attestation).toBeNull();
  });

  test('returns 409 when duplicate trigger for same wallet/recipient', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'release',
      evidenceHash: '0x' + '00'.repeat(32),
      timestamp: 1,
      submitter: '0x1',
    });

    const body = { wallet_id: 'dup-wallet', recipient_index: 2, plan_id: planId };
    await request.post('/api/trigger/from-oracle').set(oracleKeyHeader).send(body).expect(201);
    const res = await request.post('/api/trigger/from-oracle').set(oracleKeyHeader).send(body).expect(409);
    expect(res.body.error).toContain('Duplicate trigger');
  });

  test('returns 400 when wallet_id or recipient_index missing', async () => {
    await request.post('/api/trigger/from-oracle').set(oracleKeyHeader).send({ wallet_id: 'w1', plan_id: planId }).expect(400);
    await request.post('/api/trigger/from-oracle').set(oracleKeyHeader).send({ recipient_index: 0, plan_id: planId }).expect(400);
  });

  test('trims wallet_id and uses it consistently', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'release',
      evidenceHash: '0x' + '00'.repeat(32),
      timestamp: 1,
      submitter: '0x1',
    });

    const res = await request
      .post('/api/trigger/from-oracle')
      .set(oracleKeyHeader)
      .send({ wallet_id: '  trimmed-wallet  ', recipient_index: 0, plan_id: planId })
      .expect(201);

    expect(res.body.trigger_id).toBeTruthy();
    expect(getAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'trimmed-wallet',
        recipientIndex: 0,
      })
    );
  });
});

describe('GET /api/oracle/pending', () => {
  test('returns { requests: [] } when oracle is enabled', async () => {
    const res = await request
      .get('/api/oracle/pending')
      .set('X-Oracle-Internal-Key', 'test-oracle-key')
      .expect(200);
    expect(res.body).toEqual({ requests: [] });
  });
});
