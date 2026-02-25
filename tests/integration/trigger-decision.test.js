/**
 * Trigger Decision API Integration Tests
 *
 * Coverage:
 * - POST /api/trigger/:id/decision — Submit release/hold/reject decision
 * - POST /api/trigger/:id/cancel   — Cancel decision during cooldown
 *
 * Tests authority auth (legacy Ed25519 challenge-response), cooldown logic,
 * cancel cooldown enforcement, state validation, and error handling.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-td-' + Date.now() + '.db');
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
process.env.COOLDOWN_DEFAULT_HOURS = '0.001'; // 3.6 seconds for fast testing

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

function deriveAuthorityId(pubkeyHex) {
  return crypto.createHash('sha256').update(pubkeyHex, 'hex').digest('hex');
}

/**
 * Authenticate using the legacy Ed25519 challenge-response flow.
 * Returns the Authorization header value for authorityAuthMiddleware.
 */
async function authenticateAuthority(pubkeyHex, secretKey) {
  const challengeRes = await request
    .post('/api/auth/challenge')
    .send({ pubkey: pubkeyHex })
    .expect(200);
  const { challenge_id, challenge } = challengeRes.body;
  const messageBytes = Buffer.from(challenge, 'hex');
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return `Ed25519 ${challenge_id}:${Buffer.from(signature).toString('hex')}`;
}

/**
 * Insert a trigger directly into the database for testing.
 */
async function createTestTrigger(triggerId, overrides = {}) {
  const db = require('../../server/db');
  const triggerData = {
    trigger_id: triggerId,
    wallet_id: 'wallet-test-123',
    authority_id: 'placeholder',
    status: 'pending',
    trigger_type: 'legal_event',
    recipient_index: 1,
    created_at: Date.now(),
    ...overrides,
  };
  await db.triggers.create(triggerId, triggerData);
  return triggerData;
}

/**
 * Build a valid decision body for submission.
 */
function buildDecisionBody(decision, overrides = {}) {
  return {
    decision,
    evidence_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    signature: 'a'.repeat(128),
    reason: 'Test decision',
    reason_code: 'verified_event',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Trigger Decision API', () => {
  let authorityKp;
  let authorityId;

  beforeAll(() => {
    authorityKp = generateKeypair();
    authorityId = deriveAuthorityId(authorityKp.publicKey);
  });

  // -------------------------------------------------------------------------
  // 1. Decision Submission (release) — enters cooldown
  // -------------------------------------------------------------------------

  test('POST /api/trigger/:id/decision — release enters cooldown', async () => {
    const triggerId = 'trig-release-01';
    await createTestTrigger(triggerId, { authority_id: authorityId });
    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send(buildDecisionBody('release'))
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
  });

  // -------------------------------------------------------------------------
  // 2. Decision Submission (hold) — immediate, no cooldown
  // -------------------------------------------------------------------------

  test('POST /api/trigger/:id/decision — hold is immediate', async () => {
    const triggerId = 'trig-hold-01';
    await createTestTrigger(triggerId, { authority_id: authorityId });
    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send(buildDecisionBody('hold'))
      .expect(200);

    expect(res.body.trigger_id).toBe(triggerId);
    expect(res.body.decision).toBe('hold');
    expect(res.body.status).toBe('hold');
    // Hold is immediate — no effective_at or cooldown in response
    expect(res.body.effective_at).toBeUndefined();
    expect(res.body.cooldown_remaining_ms).toBeUndefined();

    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('hold');
  });

  // -------------------------------------------------------------------------
  // 3. Decision Submission (reject) — immediate
  // -------------------------------------------------------------------------

  test('POST /api/trigger/:id/decision — reject is immediate', async () => {
    const triggerId = 'trig-reject-01';
    await createTestTrigger(triggerId, { authority_id: authorityId });
    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send(buildDecisionBody('reject'))
      .expect(200);

    expect(res.body.trigger_id).toBe(triggerId);
    expect(res.body.decision).toBe('reject');
    expect(res.body.status).toBe('reject');
    expect(res.body.effective_at).toBeUndefined();
    expect(res.body.cooldown_remaining_ms).toBeUndefined();

    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('reject');
  });

  // -------------------------------------------------------------------------
  // 4. Cancel during cooldown — reverts to pending
  // -------------------------------------------------------------------------

  test('POST /api/trigger/:id/cancel — cancels during cooldown', async () => {
    const triggerId = 'trig-cancel-01';
    await createTestTrigger(triggerId, { authority_id: authorityId });

    // Submit release decision (enters cooldown)
    const authHeader1 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader1)
      .send(buildDecisionBody('release'))
      .expect(200);

    // Cancel during cooldown
    const authHeader2 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const cancelRes = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader2)
      .send({ reason: 'Changed my mind', signature: 'b'.repeat(128) })
      .expect(200);

    expect(cancelRes.body.trigger_id).toBe(triggerId);
    expect(cancelRes.body.status).toBe('pending');
    expect(cancelRes.body.cancelled_at).toBeDefined();

    // Verify DB state reverted to pending
    const db = require('../../server/db');
    const trigger = await db.triggers.findById(triggerId);
    expect(trigger.status).toBe('pending');
    expect(trigger.decision).toBeNull();
    expect(trigger.cancel_cooldown_until).toBeDefined();
    expect(trigger.cancel_cooldown_until).toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // 5. Cancel cooldown enforcement — prevents immediate resubmit
  // -------------------------------------------------------------------------

  test('cancel cooldown prevents immediate resubmit', async () => {
    const triggerId = 'trig-cancel-cd-01';
    await createTestTrigger(triggerId, { authority_id: authorityId });

    // Submit release decision
    const authHeader1 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader1)
      .send(buildDecisionBody('release'))
      .expect(200);

    // Cancel
    const authHeader2 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader2)
      .send({ reason: 'Reconsider', signature: 'c'.repeat(128) })
      .expect(200);

    // Immediately try new decision — should be blocked by cancel cooldown
    const authHeader3 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader3)
      .send(buildDecisionBody('release'))
      .expect(400);

    expect(res.body.error).toBe('Cancel cooldown active');
    expect(res.body.cooldown_remaining_ms).toBeDefined();
    expect(res.body.cooldown_remaining_ms).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 6. Cannot decide non-pending trigger
  // -------------------------------------------------------------------------

  test('cannot decide a trigger not in pending state', async () => {
    const triggerId = 'trig-released-01';
    await createTestTrigger(triggerId, {
      authority_id: authorityId,
      status: 'released',
    });

    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader)
      .send(buildDecisionBody('release'))
      .expect(400);

    expect(res.body.error).toBe('Invalid state');
    expect(res.body.detail).toContain('released');
  });

  // -------------------------------------------------------------------------
  // 7. Authority mismatch — 403 Forbidden
  // -------------------------------------------------------------------------

  test('authority mismatch returns 403', async () => {
    const triggerId = 'trig-mismatch-01';
    // Create trigger owned by our main authority
    await createTestTrigger(triggerId, { authority_id: authorityId });

    // Authenticate as a different authority
    const otherKp = generateKeypair();
    const otherAuthHeader = await authenticateAuthority(otherKp.publicKey, otherKp.secretKey);

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', otherAuthHeader)
      .send(buildDecisionBody('release'))
      .expect(403);

    expect(res.body.error).toBe('Forbidden');
  });

  // -------------------------------------------------------------------------
  // 8. Validation errors
  // -------------------------------------------------------------------------

  describe('validation errors', () => {
    test('missing evidence_hash returns 400', async () => {
      const triggerId = 'trig-val-01';
      await createTestTrigger(triggerId, { authority_id: authorityId });
      const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

      const res = await request
        .post(`/api/trigger/${triggerId}/decision`)
        .set('Authorization', authHeader)
        .send({
          decision: 'release',
          signature: 'a'.repeat(128),
        })
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toBeDefined();
      expect(res.body.details.some(d => d.includes('evidence_hash'))).toBe(true);
    });

    test('invalid decision value returns 400', async () => {
      const triggerId = 'trig-val-02';
      await createTestTrigger(triggerId, { authority_id: authorityId });
      const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

      const res = await request
        .post(`/api/trigger/${triggerId}/decision`)
        .set('Authorization', authHeader)
        .send({
          decision: 'invalid_decision',
          evidence_hash: 'deadbeef'.repeat(8),
          signature: 'a'.repeat(128),
        })
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toBeDefined();
      expect(res.body.details.some(d => d.includes('decision'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Trigger not found — 404
  // -------------------------------------------------------------------------

  test('decision on non-existent trigger returns 404', async () => {
    const authHeader = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);

    const res = await request
      .post('/api/trigger/trig-nonexistent-999/decision')
      .set('Authorization', authHeader)
      .send(buildDecisionBody('release'))
      .expect(404);

    expect(res.body.error).toBe('Not found');
  });

  // -------------------------------------------------------------------------
  // 10. Cancel after cooldown expired — 400
  // -------------------------------------------------------------------------

  test('cancel after cooldown expired returns 400', async () => {
    const triggerId = 'trig-expired-01';
    await createTestTrigger(triggerId, { authority_id: authorityId });

    // Submit release with cooldown_hours=0.001 (3.6s) so cooldown expires quickly
    const authHeader1 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const decisionRes = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', authHeader1)
      .send(buildDecisionBody('release', { cooldown_hours: 0.001 }))
      .expect(200);

    expect(decisionRes.body.status).toBe('cooldown');

    // Wait for cooldown to expire (0.001h = 3.6s, wait 4.5s)
    await new Promise(resolve => setTimeout(resolve, 4500));

    // Try to cancel — should fail because cooldown expired (or already finalized by scheduler)
    const authHeader2 = await authenticateAuthority(authorityKp.publicKey, authorityKp.secretKey);
    const cancelRes = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', authHeader2)
      .send({ reason: 'Too late', signature: 'd'.repeat(128) })
      .expect(400);

    expect(['Cooldown expired', 'Invalid state']).toContain(cancelRes.body.error);
    if (cancelRes.body.error === 'Cooldown expired') {
      expect(cancelRes.body.detail).toContain('already expired');
    } else {
      expect(cancelRes.body.detail).toMatch(/finalized|cooldown expired/i);
    }
  }, 15000); // Extended timeout for the wait
});
