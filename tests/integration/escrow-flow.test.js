/**
 * Escrow Flow Integration Tests
 *
 * Coverage:
 * - Full server-side escrow flow: wallet plan -> trigger event -> authority decision
 *   -> cooldown finalization -> claim lookup
 *
 * Flow:
 *   1. Client saves wallet plan with recipients (PUT /api/wallet-plan)
 *   2. Trigger event is created (DB insert, simulating oracle/tlock)
 *   3. Authority sees pending triggers (GET /api/trigger/pending)
 *   4. Authority submits decision (POST /api/trigger/:id/decision)
 *   5. Cooldown period / cancellation (POST /api/trigger/:id/cancel)
 *   6. Claim lookup (GET /api/claim/:wallet_id)
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-escrow-flow-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
process.env.DEFAULT_COOLDOWN_HOURS = '0'; // immediate finalization for tests

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

async function getSessionToken(pubkeyHex, secretKey) {
  const challengeRes = await request
    .post('/api/auth/challenge')
    .send({ pubkey: pubkeyHex })
    .expect(200);
  const { challenge_id, challenge } = challengeRes.body;
  const signature = nacl.sign.detached(Buffer.from(challenge, 'hex'), secretKey);
  const res = await request
    .post('/api/auth/verify')
    .send({ challenge_id, signature: Buffer.from(signature).toString('hex') })
    .expect(200);
  return res.body.session_token;
}

/**
 * Build the legacy Ed25519 Authorization header for authority auth.
 * Format: "Ed25519 <challengeId>:<signatureHex>"
 */
async function authenticateAuthority(pubkeyHex, secretKey) {
  const challengeRes = await request
    .post('/api/auth/challenge')
    .send({ pubkey: pubkeyHex })
    .expect(200);
  const { challenge_id, challenge } = challengeRes.body;
  const signature = nacl.sign.detached(Buffer.from(challenge, 'hex'), secretKey);
  return `Ed25519 ${challenge_id}:${Buffer.from(signature).toString('hex')}`;
}

function deriveAuthorityId(pubkeyHex) {
  return crypto.createHash('sha256').update(pubkeyHex, 'hex').digest('hex');
}

/**
 * Register an authority in the DB so GET /api/trigger/pending recognises them.
 */
async function seedAuthority(pubkeyHex) {
  const db = require('../../server/db');
  const authorityId = deriveAuthorityId(pubkeyHex);
  const existing = await db.authorities.findById(authorityId);
  if (existing) return authorityId;
  await db.authorities.create(authorityId, {
    authority_id: authorityId,
    name: 'Test Authority',
    bar_number: 'TEST-' + authorityId.slice(0, 6),
    jurisdiction: 'Test',
    region: 'Test',
    specialization: ['Asset release'],
    languages: ['en'],
    pubkey: pubkeyHex,
    fee_structure: { base_fee_bps: 500, flat_fee_usd: 0, currency: 'USD' },
    verified: true,
    rating: 0,
    rating_count: 0,
    active_bindings: 0,
    max_capacity: 100,
    created_at: Date.now(),
  });
  return authorityId;
}

/**
 * Insert a trigger event directly into DB (simulating oracle/tlock creation).
 */
async function insertTrigger(triggerId, walletId, authorityId, opts = {}) {
  const db = require('../../server/db');
  const data = {
    trigger_id: triggerId,
    wallet_id: walletId,
    authority_id: authorityId,
    status: opts.status || 'pending',
    trigger_type: opts.trigger_type || 'legal_event',
    recipient_index: opts.recipient_index != null ? opts.recipient_index : 1,
    triggered_at: Date.now(),
    created_at: Date.now(),
    decided_at: null,
    decision: null,
    ...opts,
  };
  await db.triggers.create(triggerId, data);
  return data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Escrow Flow - Trigger to Decision', () => {
  let clientKp;
  let clientSession;
  let authorityKp;
  let authorityId;
  let walletId;

  beforeAll(async () => {
    // Client keypair and session
    clientKp = generateKeypair();
    clientSession = await getSessionToken(clientKp.publicKey, clientKp.secretKey);
    walletId = clientKp.publicKey.toLowerCase();

    // Authority keypair and DB registration
    authorityKp = generateKeypair();
    authorityId = await seedAuthority(authorityKp.publicKey);
  });

  test('Create wallet plan with recipients', async () => {
    const plan = {
      triggerTypes: { oracle: true, inactivity: false },
      recipients: [
        { label: 'Alice', email: 'alice@test.com', address: '0x' + 'a'.repeat(40) },
        { label: 'Bob', email: 'bob@test.com', address: '0x' + 'b'.repeat(40) },
      ],
      triggerConfig: { oracle: {} },
    };

    const res = await request
      .put('/api/wallet-plan')
      .set('X-Client-Session', clientSession)
      .send(plan)
      .expect(200);

    expect(res.body.plan).toBeDefined();
    expect(res.body.plan.triggerTypes.oracle).toBe(true);
    expect(res.body.plan.recipients).toHaveLength(2);
    expect(res.body.plan.recipients[0].label).toBe('Alice');
    expect(res.body.plan.recipients[1].label).toBe('Bob');

    // Verify plan persists on re-read (must include chain/token to match composite key)
    const getRes = await request
      .get('/api/wallet-plan?chain=ethereum&token=ETH')
      .set('X-Client-Session', clientSession)
      .expect(200);

    expect(getRes.body.plan).not.toBeNull();
    expect(getRes.body.plan.recipients).toHaveLength(2);
  });

  test('Authority sees pending trigger', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .get('/api/trigger/pending')
      .set('Authorization', authHeader)
      .expect(200);

    expect(res.body.triggers).toBeDefined();
    expect(Array.isArray(res.body.triggers)).toBe(true);

    const found = res.body.triggers.find(t => t.trigger_id === triggerId);
    expect(found).toBeDefined();
    expect(found.status).toBe('pending');
    expect(found.wallet_id).toBe(walletId);
  });

  test('Authority submits release decision (immediate, cooldown_hours=0)', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(200);

    expect(res.body.trigger_id).toBe(triggerId);
    expect(res.body.decision).toBe('release');
    expect(res.body.status).toBe('released');

    // Verify DB state
    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('released');
    expect(trigger.decision).toBe('release');
  });

  test('Authority submits hold decision', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'hold',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(200);

    expect(res.body.trigger_id).toBe(triggerId);
    expect(res.body.decision).toBe('hold');
    expect(res.body.status).toBe('hold');

    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('hold');
    expect(trigger.decision).toBe('hold');
  });

  test('Authority submits reject decision', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'reject',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        reason: 'Insufficient evidence',
        reason_code: 'other',
      })
      .expect(200);

    expect(res.body.trigger_id).toBe(triggerId);
    expect(res.body.decision).toBe('reject');
    expect(res.body.status).toBe('reject');

    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('reject');
    expect(trigger.decision).toBe('reject');
  });
});

describe('Escrow Flow - Cooldown and Cancellation', () => {
  let authorityKp;
  let authorityId;
  let walletId;

  beforeAll(async () => {
    const clientKp = generateKeypair();
    walletId = clientKp.publicKey.toLowerCase();

    authorityKp = generateKeypair();
    authorityId = await seedAuthority(authorityKp.publicKey);
  });

  test('Release with cooldown enters cooldown state', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0.001, // ~3.6 seconds
      })
      .expect(200);

    expect(res.body.trigger_id).toBe(triggerId);
    expect(res.body.decision).toBe('release');
    expect(res.body.status).toBe('cooldown');
    expect(res.body.effective_at).toBeDefined();
    expect(typeof res.body.effective_at).toBe('number');
    expect(res.body.cooldown_remaining_ms).toBeDefined();
    expect(res.body.cooldown_remaining_ms).toBeGreaterThan(0);

    // Verify DB state
    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('cooldown');
    expect(trigger.decision).toBe('release');
    expect(trigger.effective_at).toBeGreaterThan(Date.now() - 10000);
  });

  test('Cancel during cooldown reverts to pending', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    // Submit release with cooldown
    let authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 1, // 1 hour — long enough to cancel
      })
      .expect(200);

    // Cancel the decision
    authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const cancelRes = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader)
      .send({
        reason: 'Changed my mind',
        signature: 'c'.repeat(128),
      })
      .expect(200);

    expect(cancelRes.body.trigger_id).toBe(triggerId);
    expect(cancelRes.body.status).toBe('pending');
    expect(cancelRes.body.cancelled_at).toBeDefined();

    // Verify DB state
    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('pending');
    expect(trigger.decision).toBeNull();
    expect(trigger.cancelled_at).toBeDefined();
  });

  test('Cancel cooldown prevents immediate resubmit', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    // Submit release with cooldown
    let authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 1,
      })
      .expect(200);

    // Cancel the decision
    authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader)
      .send({ reason: 'Reconsider', signature: 'c'.repeat(128) })
      .expect(200);

    // Try to resubmit immediately — should fail due to cancel cooldown
    authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const resubmitRes = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(400);

    expect(resubmitRes.body.error).toBe('Cancel cooldown active');
    expect(resubmitRes.body.cooldown_remaining_ms).toBeDefined();
    expect(resubmitRes.body.cooldown_remaining_ms).toBeGreaterThan(0);
  });
});

describe('Escrow Flow - Claim Lookup', () => {
  let clientKp;
  let clientSession;
  let authorityKp;
  let authorityId;
  let walletId;

  beforeAll(async () => {
    clientKp = generateKeypair();
    clientSession = await getSessionToken(clientKp.publicKey, clientKp.secretKey);
    walletId = clientKp.publicKey.toLowerCase();

    authorityKp = generateKeypair();
    authorityId = await seedAuthority(authorityKp.publicKey);
  });

  test('Claim lookup returns released=false when no released trigger', async () => {
    // Insert a pending (not released) trigger
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId, { status: 'pending' });

    const res = await request
      .get(`/api/claim/${walletId}`)
      .set('X-Client-Session', clientSession)
      .expect(200);

    expect(res.body.wallet_id).toBe(walletId);
    expect(res.body.released).toBe(false);
    expect(res.body.factors).toEqual([]);
  });

  test('Claim lookup returns released=true after trigger is released', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId, { status: 'released' });

    const res = await request
      .get(`/api/claim/${walletId}`)
      .set('X-Client-Session', clientSession)
      .expect(200);

    expect(res.body.wallet_id).toBe(walletId);
    expect(res.body.released).toBe(true);
    // No released factors yet (only trigger is released, factors not submitted)
    expect(res.body.factors).toEqual([]);
  });

  test('Claim lookup requires authentication', async () => {
    await request
      .get(`/api/claim/${walletId}`)
      .expect(401);
  });
});

describe('Escrow Flow - Error Cases', () => {
  let authorityKp;
  let authorityId;
  let walletId;

  beforeAll(async () => {
    const clientKp = generateKeypair();
    walletId = clientKp.publicKey.toLowerCase();

    authorityKp = generateKeypair();
    authorityId = await seedAuthority(authorityKp.publicKey);
  });

  test('Decision on non-existent trigger returns 404', async () => {
    const fakeTriggerId = crypto.randomBytes(16).toString('hex');

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${fakeTriggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(404);

    expect(res.body.error).toBe('Not found');
  });

  test('Wrong authority tries to decide returns 403', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    // Create a different authority
    const otherKp = generateKeypair();
    await seedAuthority(otherKp.publicKey);

    const authHeader = await authenticateAuthority(otherKp.publicKey, otherKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(403);

    expect(res.body.error).toBe('Forbidden');
    expect(res.body.detail).toContain('not the assigned authority');
  });

  test('Decide on already-released trigger returns 400', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId, { status: 'released' });

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(400);

    expect(res.body.error).toBe('Invalid state');
    expect(res.body.detail).toContain('released');
  });

  test('Missing required fields returns 400 validation error', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

    // Missing decision, evidence_hash, signature
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({})
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  test('Invalid decision value returns 400 validation error', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send({
        decision: 'invalid_decision',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
      })
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.some(d => d.includes('decision'))).toBe(true);
  });

  test('Cancel on non-cooldown trigger returns 400', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId, { status: 'pending' });

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader)
      .send({ reason: 'test' })
      .expect(400);

    expect(res.body.error).toBe('Invalid state');
  });

  test('Cancel on already-released trigger returns 400', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId, { status: 'released' });

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader)
      .send({ reason: 'test' })
      .expect(400);

    expect(res.body.error).toBe('Invalid state');
    expect(res.body.detail).toContain('finalized');
  });

  test('Cancel by wrong authority returns 403', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId, { status: 'cooldown', effective_at: Date.now() + 3600000 });

    const otherKp = generateKeypair();
    await seedAuthority(otherKp.publicKey);

    const authHeader = await authenticateAuthority(otherKp.publicKey, otherKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader)
      .send({ reason: 'test' })
      .expect(403);

    expect(res.body.error).toBe('Forbidden');
  });

  test('Cancel on non-existent trigger returns 404', async () => {
    const fakeTriggerId = crypto.randomBytes(16).toString('hex');

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${fakeTriggerId}/cancel`)
      .set('Authorization', authHeader)
      .send({ reason: 'test' })
      .expect(404);

    expect(res.body.error).toBe('Not found');
  });

  test('Decision without auth returns 401', async () => {
    const triggerId = crypto.randomBytes(16).toString('hex');
    await insertTrigger(triggerId, walletId, authorityId);

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .send({
        decision: 'release',
        evidence_hash: 'e'.repeat(64),
        signature: 's'.repeat(128),
        cooldown_hours: 0,
      })
      .expect(401);

    expect(res.body.error).toBe('Authentication required');
  });
});
