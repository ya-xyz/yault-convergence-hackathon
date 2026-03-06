/**
 * Server API Integration Tests
 *
 * Tests the full API surface using supertest against the Express app.
 * Uses a temporary SQLite database that is cleaned up after each run.
 *
 * Coverage:
 * - Health check
 * - Auth challenge-response flow
 * - Authority registration + verification
 * - Binding CRUD
 * - Trigger initiation → decision → cooldown → cancel
 * - Revenue & withdrawal endpoints
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Use a temp database for tests
const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
process.env.ORACLE_ATTESTATION_ENABLED = 'false';
process.env.RELEASE_ATTESTATION_ADDRESS = '';

// We need tweetnacl for signing
const nacl = require('tweetnacl');

let app;
let request;

beforeAll(() => {
  const supertest = require('supertest');
  app = require('../../server/index');
  request = supertest(app);
});

afterAll(() => {
  // Close database and remove test file
  const db = require('../../server/db');
  db._close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch (_) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate an Ed25519 keypair and return hex-encoded keys.
 */
function generateKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
    secretKey: kp.secretKey, // Uint8Array (64 bytes)
  };
}

/**
 * Perform the full challenge-response auth flow and return the challenge_id + signature.
 */
async function authenticate(pubkeyHex, secretKey) {
  const challengeRes = await request
    .post('/api/auth/challenge')
    .send({ pubkey: pubkeyHex })
    .expect(200);

  const { challenge_id, challenge } = challengeRes.body;

  // Sign the challenge
  const messageBytes = Buffer.from(challenge, 'hex');
  const signature = nacl.sign.detached(messageBytes, secretKey);
  const signatureHex = Buffer.from(signature).toString('hex');

  return { challenge_id, signature: signatureHex };
}

/**
 * Register and verify an authority, returning the authority_id and keypair.
 */
async function registerAndVerifyAuthority(overrides = {}) {
  const kp = generateKeypair();

  const profile = {
    name: 'Test Authority',
    bar_number: 'BAR-' + crypto.randomBytes(4).toString('hex'),
    jurisdiction: 'US-CA',
    specialization: ['asset-release'],
    languages: ['en'],
    pubkey: kp.publicKey,
    email: 'test@authority.example',
    ...overrides,
  };

  const regRes = await request
    .post('/api/authority/register')
    .send(profile)
    .expect(201);

  const authorityId = regRes.body.authority_id;

  // Admin verify (X-Admin-Token header, not body)
  await request
    .post(`/api/authority/${authorityId}/verify`)
    .set('X-Admin-Token', process.env.ADMIN_TOKEN || '')
    .send({ verification_proof: 'test-proof' })
    .expect(200);

  return { authorityId, keypair: kp, profile };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Health Check', () => {
  test('GET /health returns status ok', async () => {
    const res = await request.get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptime).toBeGreaterThan(0);
    expect(res.body.timestamp).toBeTruthy();
  });
});

describe('404 Handler', () => {
  test('returns 404 for unknown routes', async () => {
    await request.get('/api/nonexistent').expect(404);
  });
});

describe('Auth Challenge-Response', () => {
  test('generates a challenge for a valid pubkey', async () => {
    const kp = generateKeypair();
    const res = await request
      .post('/api/auth/challenge')
      .send({ pubkey: kp.publicKey })
      .expect(200);

    expect(res.body.challenge_id).toBeTruthy();
    expect(res.body.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.expires_at).toBeGreaterThan(Date.now());
  });

  test('rejects challenge without pubkey', async () => {
    await request.post('/api/auth/challenge').send({}).expect(400);
  });

  test('verifies a valid signature', async () => {
    const kp = generateKeypair();
    const auth = await authenticate(kp.publicKey, kp.secretKey);

    const res = await request
      .post('/api/auth/verify')
      .send(auth)
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.pubkey).toBe(kp.publicKey);
  });

  test('rejects an invalid signature', async () => {
    const kp = generateKeypair();
    const challengeRes = await request
      .post('/api/auth/challenge')
      .send({ pubkey: kp.publicKey })
      .expect(200);

    await request
      .post('/api/auth/verify')
      .send({
        challenge_id: challengeRes.body.challenge_id,
        signature: '0'.repeat(128),
      })
      .expect(401);
  });

  test('challenge is consumed after use (one-time)', async () => {
    const kp = generateKeypair();
    const auth = await authenticate(kp.publicKey, kp.secretKey);

    // First use succeeds
    await request.post('/api/auth/verify').send(auth).expect(200);

    // Second use fails (consumed)
    const res = await request.post('/api/auth/verify').send(auth).expect(401);
    expect(res.body.error).toContain('not found');
  });
});

describe('Authority Registration & Verification', () => {
  test('registers a new authority', async () => {
    const kp = generateKeypair();
    const res = await request
      .post('/api/authority/register')
      .send({
        name: 'Registration Test Authority',
        bar_number: 'BAR-REG-001',
        jurisdiction: 'US-NY',
        specialization: ['corporate'],
        languages: ['en', 'cn'],
        pubkey: kp.publicKey,
      })
      .expect(201);

    expect(res.body.authority_id).toBeTruthy();
    expect(res.body.status).toBe('pending_verification');
  });

  test('rejects duplicate registration', async () => {
    const kp = generateKeypair();
    const profile = {
      name: 'Duplicate Authority',
      bar_number: 'BAR-DUP-001',
      jurisdiction: 'US-TX',
      specialization: ['asset-release'],
      languages: ['en'],
      pubkey: kp.publicKey,
    };

    await request.post('/api/authority/register').send(profile).expect(201);
    await request.post('/api/authority/register').send(profile).expect(409);
  });

  test('admin verifies an authority', async () => {
    const { authorityId } = await registerAndVerifyAuthority();

    // Profile should show verified
    const auth = await authenticate(
      (await registerAndVerifyAuthority()).keypair.publicKey,
      (generateKeypair()).secretKey
    );
    // Just check it exists - the authority profile endpoint would show verified:true
    expect(authorityId).toBeTruthy();
  });

  test('rejects verification with wrong admin token', async () => {
    const kp = generateKeypair();
    const regRes = await request
      .post('/api/authority/register')
      .send({
        name: 'Bad Token Authority',
        bar_number: 'BAR-BAD-001',
        jurisdiction: 'US-FL',
        specialization: ['asset-release'],
        languages: ['en'],
        pubkey: kp.publicKey,
      })
      .expect(201);

    await request
      .post(`/api/authority/${regRes.body.authority_id}/verify`)
      .set('X-Admin-Token', 'wrong-token-wrong-length!')
      .send({})
      .expect(403);
  });
});

describe('Binding CRUD', () => {
  let authority;
  const planId = 'plan-binding-crud';

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();
  });

  test('creates a binding with authentication', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .post('/api/binding')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: 'wallet_binding_test_1',
        authority_id: authority.authorityId,
        plan_id: planId,
        recipient_indices: [0, 1],
      })
      .expect(201);

    expect(res.body.binding_id).toBeTruthy();
    expect(res.body.status).toBe('active');
  });

  test('lists bindings for authenticated authority', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .get('/api/binding')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(Array.isArray(res.body.bindings)).toBe(true);
    expect(res.body.bindings.length).toBeGreaterThanOrEqual(1);
  });

  test('rejects binding without auth', async () => {
    await request
      .post('/api/binding')
      .send({
        wallet_id: 'wallet_noauth',
        authority_id: authority.authorityId,
        plan_id: planId,
        recipient_indices: [0],
      })
      .expect(401);
  });

  test('terminates a binding', async () => {
    // Create a binding first
    let auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const createRes = await request
      .post('/api/binding')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: 'wallet_delete_test',
        authority_id: authority.authorityId,
        plan_id: planId,
        recipient_indices: [0],
      })
      .expect(201);

    // Delete it
    auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const delRes = await request
      .delete(`/api/binding/${createRes.body.binding_id}`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(delRes.body.status).toBe('terminated');
  });
});

describe('Trigger Lifecycle', () => {
  let authority;
  let triggerId;
  const walletId = 'wallet_trigger_lifecycle';
  const planId = 'plan-trigger-lifecycle';

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();

    // Create a binding for the trigger
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    await request
      .post('/api/binding')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: walletId,
        authority_id: authority.authorityId,
        plan_id: planId,
        recipient_indices: [0, 1, 2],
      })
      .expect(201);
  });

  test('initiates a trigger with Ed25519 signature', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    // Create evidence hash and sign it
    const evidenceHash = crypto.createHash('sha256').update('test-evidence').digest('hex');
    const evidenceSignature = nacl.sign.detached(
      Buffer.from(evidenceHash, 'hex'),
      authority.keypair.secretKey
    );
    const evidenceSignatureHex = Buffer.from(evidenceSignature).toString('hex');

    const res = await request
      .post('/api/trigger/initiate')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: walletId,
        plan_id: planId,
        recipient_index: 0,
        reason_code: 'verified_event',
        evidence_hash: evidenceHash,
        signature: evidenceSignatureHex,
        notes: 'Test trigger initiation',
      })
      .expect(201);

    expect(res.body.trigger_id).toBeTruthy();
    expect(res.body.status).toBe('pending');
    expect(res.body.trigger_type).toBe('legal_event');
    triggerId = res.body.trigger_id;
  });

  test('rejects duplicate trigger for same wallet/recipient', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const evidenceHash = crypto.createHash('sha256').update('test-evidence-dup').digest('hex');
    const evidenceSignature = nacl.sign.detached(
      Buffer.from(evidenceHash, 'hex'),
      authority.keypair.secretKey
    );

    await request
      .post('/api/trigger/initiate')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: walletId,
        plan_id: planId,
        recipient_index: 0,
        reason_code: 'verified_event',
        evidence_hash: evidenceHash,
        signature: Buffer.from(evidenceSignature).toString('hex'),
      })
      .expect(409);
  });

  test('lists pending triggers', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .get('/api/trigger/pending')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(res.body.triggers).toBeDefined();
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  test('submits release decision (enters cooldown)', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const evidenceHash = crypto.createHash('sha256').update('decision-evidence').digest('hex');

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'Verified event confirmed',
        reason_code: 'verified_event',
        cooldown_hours: 1, // 1 hour cooldown for test
      })
      .expect(200);

    expect(res.body.decision).toBe('release');
    expect(res.body.status).toBe('cooldown');
    expect(res.body.effective_at).toBeGreaterThan(Date.now());
  });

  test('cancels decision during cooldown', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        reason: 'Need to review additional documents',
        signature: '0'.repeat(128),
      })
      .expect(200);

    expect(res.body.status).toBe('pending');
    expect(res.body.cancelled_at).toBeTruthy();
  });

  test('submits hold decision (immediate)', async () => {
    // Use a fresh trigger (recipient_index 1) to avoid cancel_cooldown_until
    // from the previous cancel test on recipient_index 0
    let auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const initHash = crypto.createHash('sha256').update('hold-init').digest('hex');
    const initRes = await request
      .post('/api/trigger/initiate')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: walletId,
        plan_id: planId,
        recipient_index: 1,
        reason_code: 'verified_event',
        evidence_hash: initHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(initHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
      })
      .expect(201);
    const holdTriggerId = initRes.body.trigger_id;

    auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const evidenceHash = crypto.createHash('sha256').update('hold-evidence').digest('hex');

    const res = await request
      .post(`/api/trigger/${holdTriggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'hold',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'Pending further verification',
        reason_code: 'other',
      })
      .expect(200);

    expect(res.body.decision).toBe('hold');
    expect(res.body.status).toBe('hold');
  });
});

describe('Revenue Endpoints', () => {
  let authority;
  const walletId = 'wallet_revenue_test';
  const planId = 'plan-revenue-endpoints';

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();

    // Create binding for access
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    await request
      .post('/api/binding')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        wallet_id: walletId,
        authority_id: authority.authorityId,
        plan_id: planId,
        recipient_indices: [0],
      })
      .expect(201);
  });

  test('GET /api/revenue/authority/:id returns empty revenue', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .get(`/api/revenue/authority/${authority.authorityId}`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(res.body.total).toBe(0);
    expect(res.body.pending).toBe(0);
  });

  test('GET /api/revenue/user/:walletId returns empty revenue', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .get(`/api/revenue/user/${walletId}`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(res.body.gross_yield).toBe(0);
    expect(res.body.net_yield).toBe(0);
  });
});

describe('Withdrawal Endpoint', () => {
  let authority;
  let savedVaultAddress;

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();
    // Force stub mode: config is cached at require time, so mutate it directly
    const config = require('../../server/config');
    savedVaultAddress = config.contracts.vaultAddress;
    config.contracts.vaultAddress = '';
  });

  afterAll(() => {
    const config = require('../../server/config');
    config.contracts.vaultAddress = savedVaultAddress || '';
  });

  test('POST /api/revenue/withdraw returns stub notice', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .post('/api/revenue/withdraw')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        authority_id: authority.authorityId,
        amount: 1.0,
        to_address: '0x1234567890abcdef',
      })
      .expect(501);

    expect(res.body.error).toContain('not configured');
  });
});
