/**
 * Trigger Decision Edge Cases Integration Tests
 *
 * Coverage:
 * - Cancel cooldown: 1-hour prevention after cancellation
 * - Decision on non-pending trigger (state validation)
 * - Authority ownership check (cannot decide others' triggers)
 * - Cooldown expiry finalization
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-trigger-edge-' + Date.now() + '.db');
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

async function registerAndVerifyAuthority(overrides = {}) {
  const kp = generateKeypair();
  const profile = {
    name: 'Test Authority',
    bar_number: 'BAR-' + crypto.randomBytes(4).toString('hex'),
    jurisdiction: 'US-CA',
    specialization: ['asset-release'],
    languages: ['en'],
    pubkey: kp.publicKey,
    ...overrides,
  };
  const regRes = await request.post('/api/authority/register').send(profile).expect(201);
  const authorityId = regRes.body.authority_id;
  await request
    .post(`/api/authority/${authorityId}/verify`)
    .set('X-Admin-Token', process.env.ADMIN_TOKEN)
    .send({ verification_proof: 'test-proof' })
    .expect(200);
  return { authorityId, keypair: kp, profile };
}

async function createTriggerForAuthority(authority, walletId, recipientIndex) {
  const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

  // Create binding
  await request
    .post('/api/binding')
    .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
    .send({
      wallet_id: walletId,
      authority_id: authority.authorityId,
      recipient_indices: [recipientIndex],
    })
    .expect(201);

  // Initiate trigger
  const auth2 = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
  const evidenceHash = crypto.createHash('sha256').update('evidence-' + Date.now()).digest('hex');
  const evidenceSig = nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey);

  const res = await request
    .post('/api/trigger/initiate')
    .set('Authorization', `Ed25519 ${auth2.challenge_id}:${auth2.signature}`)
    .send({
      wallet_id: walletId,
      recipient_index: recipientIndex,
      reason_code: 'verified_event',
      evidence_hash: evidenceHash,
      signature: Buffer.from(evidenceSig).toString('hex'),
    })
    .expect(201);

  return res.body.trigger_id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cancel Cooldown Prevention', () => {
  let authority;
  let triggerId;
  const walletId = 'wallet_cancel_cooldown_test';

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();
    triggerId = await createTriggerForAuthority(authority, walletId, 0);
  });

  test('release → cooldown → cancel → resubmit blocked by cancel cooldown', async () => {
    // Step 1: Submit release decision (enters cooldown)
    let auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const evidenceHash = crypto.createHash('sha256').update('release-evidence').digest('hex');

    const releaseRes = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'Confirmed',
        reason_code: 'verified_event',
        cooldown_hours: 24,
      })
      .expect(200);

    expect(releaseRes.body.status).toBe('cooldown');

    // Step 2: Cancel during cooldown
    auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const cancelRes = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({ reason: 'Need review', signature: '0'.repeat(128) })
      .expect(200);

    expect(cancelRes.body.status).toBe('pending');

    // Step 3: Immediate resubmit should be blocked by cancel cooldown
    auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const resubmitRes = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'Try again',
        reason_code: 'verified_event',
        cooldown_hours: 1,
      })
      .expect(400);

    expect(resubmitRes.body.error).toContain('Cancel cooldown active');
    expect(resubmitRes.body.cooldown_remaining_ms).toBeGreaterThan(0);
  });
});

describe('State Validation', () => {
  let authority;

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();
  });

  test('cannot cancel a non-cooldown trigger', async () => {
    const triggerId = await createTriggerForAuthority(authority, 'wallet_state_test_1', 0);

    // Trigger is in 'pending' state, not cooldown
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({ reason: 'test', signature: '0'.repeat(128) })
      .expect(400);

    expect(res.body.error).toContain('Invalid state');
  });

  test('cannot submit decision on held trigger', async () => {
    const triggerId = await createTriggerForAuthority(authority, 'wallet_state_test_2', 0);

    // Submit hold decision
    let auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const evidenceHash = crypto.createHash('sha256').update('hold-ev').digest('hex');

    await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'hold',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'Need more info',
        reason_code: 'other',
      })
      .expect(200);

    // Try another decision → should fail (trigger is in 'hold' state)
    auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'Changed mind',
        reason_code: 'verified_event',
      })
      .expect(400);

    expect(res.body.error).toContain('Invalid state');
  });
});

describe('Authority Ownership', () => {
  test('authority cannot decide another authority trigger', async () => {
    const auth1 = await registerAndVerifyAuthority({ bar_number: 'BAR-OWN-1' });
    const auth2 = await registerAndVerifyAuthority({ bar_number: 'BAR-OWN-2' });

    const triggerId = await createTriggerForAuthority(auth1, 'wallet_ownership_test', 0);

    // Auth2 tries to decide auth1's trigger
    const auth = await authenticate(auth2.keypair.publicKey, auth2.keypair.secretKey);
    const evidenceHash = crypto.createHash('sha256').update('ownership-test').digest('hex');

    const res = await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), auth2.keypair.secretKey)
        ).toString('hex'),
        reason: 'Not my trigger',
        reason_code: 'verified_event',
      })
      .expect(403);

    expect(res.body.error).toBe('Forbidden');
  });

  test('authority cannot cancel another authority trigger', async () => {
    const auth1 = await registerAndVerifyAuthority({ bar_number: 'BAR-OWN-3' });
    const auth2 = await registerAndVerifyAuthority({ bar_number: 'BAR-OWN-4' });

    const triggerId = await createTriggerForAuthority(auth1, 'wallet_ownership_cancel', 0);

    // Put in cooldown first
    let auth = await authenticate(auth1.keypair.publicKey, auth1.keypair.secretKey);
    const evidenceHash = crypto.createHash('sha256').update('cancel-own').digest('hex');
    await request
      .post(`/api/trigger/${triggerId}/decision`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), auth1.keypair.secretKey)
        ).toString('hex'),
        reason: 'Release',
        reason_code: 'verified_event',
        cooldown_hours: 24,
      })
      .expect(200);

    // Auth2 tries to cancel auth1's trigger
    auth = await authenticate(auth2.keypair.publicKey, auth2.keypair.secretKey);
    const res = await request
      .post(`/api/trigger/${triggerId}/cancel`)
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({ reason: 'hack attempt', signature: '0'.repeat(128) })
      .expect(403);

    expect(res.body.error).toBe('Forbidden');
  });
});

describe('Decision Not Found', () => {
  test('returns 404 for non-existent trigger id', async () => {
    const authority = await registerAndVerifyAuthority({ bar_number: 'BAR-404' });
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);
    const evidenceHash = crypto.createHash('sha256').update('notfound').digest('hex');

    await request
      .post('/api/trigger/nonexistent-trigger-id/decision')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        decision: 'release',
        evidence_hash: evidenceHash,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(evidenceHash, 'hex'), authority.keypair.secretKey)
        ).toString('hex'),
        reason: 'test',
        reason_code: 'other',
      })
      .expect(404);
  });
});
