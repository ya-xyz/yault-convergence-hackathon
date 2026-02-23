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
process.env.ORACLE_ATTESTATION_ENABLED = 'true';
process.env.RELEASE_ATTESTATION_ADDRESS = '0x0000000000000000000000000000000000000001';

jest.mock('../../server/services/attestationClient', () => ({
  getAttestation: jest.fn(),
  hasAttestation: jest.fn(),
  walletIdHash: jest.fn((id) => '0x' + '00'.repeat(32)),
}));

const { getAttestation } = require('../../server/services/attestationClient');

let app;
let request;

beforeAll(() => {
  const supertest = require('supertest');
  app = require('../../server/index');
  request = supertest(app);
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
      .query({ wallet_id: 'w2', recipient_index: 1 })
      .expect(200);

    expect(res.body.oracle_enabled).toBe(true);
    expect(res.body.attestation).toBeNull();
  });

  test('returns 400 when wallet_id or recipient_index missing', async () => {
    await request.get('/api/trigger/attestation').query({ wallet_id: 'w1' }).expect(400);
    await request.get('/api/trigger/attestation').query({ recipient_index: 0 }).expect(400);
  });

  test('returns 400 when recipient_index is invalid', async () => {
    await request
      .get('/api/trigger/attestation')
      .query({ wallet_id: 'w1', recipient_index: -1 })
      .expect(400);
    await request
      .get('/api/trigger/attestation')
      .query({ wallet_id: 'w1', recipient_index: 'not-a-number' })
      .expect(400);
    await request
      .get('/api/trigger/attestation')
      .query({ wallet_id: 'w1', recipient_index: '1abc' })
      .expect(400);
  });
});

describe('POST /api/trigger/from-oracle', () => {
  test('returns 404 when no oracle attestation on chain', async () => {
    getAttestation.mockResolvedValue(null);

    const res = await request
      .post('/api/trigger/from-oracle')
      .send({ wallet_id: 'wallet-xyz', recipient_index: 0 })
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
      .send({ wallet_id: 'w1', recipient_index: 0 })
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
      .send({ wallet_id: 'wallet-release-1', recipient_index: 0 })
      .expect(201);

    expect(res.body.trigger_id).toBeTruthy();
    expect(res.body.status).toBe('cooldown');
    expect(res.body.trigger_type).toBe('oracle');
    expect(res.body.decision).toBe('release');
    expect(res.body.effective_at).toBeGreaterThan(Date.now());

    getAttestation.mockResolvedValue(null);
    const attestRes = await request
      .get('/api/trigger/attestation')
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

    const body = { wallet_id: 'dup-wallet', recipient_index: 2 };
    await request.post('/api/trigger/from-oracle').send(body).expect(201);
    const res = await request.post('/api/trigger/from-oracle').send(body).expect(409);
    expect(res.body.error).toContain('Duplicate trigger');
  });

  test('returns 400 when wallet_id or recipient_index missing', async () => {
    await request.post('/api/trigger/from-oracle').send({ wallet_id: 'w1' }).expect(400);
    await request.post('/api/trigger/from-oracle').send({ recipient_index: 0 }).expect(400);
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
      .send({ wallet_id: '  trimmed-wallet  ', recipient_index: 0 })
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
    const res = await request.get('/api/oracle/pending').expect(200);
    expect(res.body).toEqual({ requests: [] });
  });
});
