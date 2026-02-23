/**
 * Account Invites API Integration Tests
 *
 * Coverage:
 * - GET    /api/account-invites — list invites
 * - POST   /api/account-invites — create invite
 * - PUT    /api/account-invites/:id/accept — accept invite
 * - DELETE /api/account-invites/:id — remove invite
 * - Duplicate email prevention
 * - Owner-only access control
 */

'use strict';

const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-invites-' + Date.now() + '.db');
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

describe('Account Invites CRUD', () => {
  let kp;
  let sessionToken;
  let inviteId;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('GET returns empty list initially', async () => {
    const res = await request
      .get('/api/account-invites')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.invites).toEqual([]);
  });

  test('POST creates an invite', async () => {
    const res = await request
      .post('/api/account-invites')
      .set('X-Client-Session', sessionToken)
      .send({ email: 'alice@test.com', label: 'Alice' })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.email).toBe('alice@test.com');
    expect(res.body.label).toBe('Alice');
    expect(res.body.status).toBe('pending');
    inviteId = res.body.id;
  });

  test('GET lists the created invite', async () => {
    const res = await request
      .get('/api/account-invites')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.invites.length).toBe(1);
    expect(res.body.invites[0].email).toBe('alice@test.com');
  });

  test('POST rejects duplicate email', async () => {
    const res = await request
      .post('/api/account-invites')
      .set('X-Client-Session', sessionToken)
      .send({ email: 'alice@test.com' })
      .expect(409);

    expect(res.body.error).toContain('already invited');
  });

  test('POST rejects missing email', async () => {
    await request
      .post('/api/account-invites')
      .set('X-Client-Session', sessionToken)
      .send({})
      .expect(400);
  });

  test('PUT /:id/accept accepts the invite', async () => {
    const res = await request
      .put(`/api/account-invites/${inviteId}/accept`)
      .set('X-Client-Session', sessionToken)
      .send({ label: 'Alice (accepted)' })
      .expect(200);

    expect(res.body.status).toBe('accepted');
    expect(res.body.label).toBe('Alice (accepted)');
  });

  test('PUT /:id/accept rejects non-existent invite', async () => {
    await request
      .put('/api/account-invites/nonexistent/accept')
      .set('X-Client-Session', sessionToken)
      .send({})
      .expect(404);
  });

  test('DELETE /:id removes the invite', async () => {
    await request
      .delete(`/api/account-invites/${inviteId}`)
      .set('X-Client-Session', sessionToken)
      .expect(204);

    // Verify it's gone
    const res = await request
      .get('/api/account-invites')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.invites).toEqual([]);
  });

  test('DELETE /:id rejects non-existent invite', async () => {
    await request
      .delete('/api/account-invites/nonexistent')
      .set('X-Client-Session', sessionToken)
      .expect(404);
  });
});

describe('Account Invites Access Control', () => {
  test('requires authentication for all endpoints', async () => {
    await request.get('/api/account-invites').expect(401);
    await request.post('/api/account-invites').send({ email: 'x@test.com' }).expect(401);
    await request.put('/api/account-invites/some-id/accept').send({}).expect(401);
    await request.delete('/api/account-invites/some-id').expect(401);
  });

  test('owner can only manage own invites', async () => {
    const owner1 = generateKeypair();
    const owner1Session = await getSessionToken(owner1.publicKey, owner1.secretKey);
    const owner2 = generateKeypair();
    const owner2Session = await getSessionToken(owner2.publicKey, owner2.secretKey);

    // Owner1 creates invite
    const res = await request
      .post('/api/account-invites')
      .set('X-Client-Session', owner1Session)
      .send({ email: 'bob@test.com' })
      .expect(201);

    const id = res.body.id;

    // Owner2 cannot accept owner1's invite
    await request
      .put(`/api/account-invites/${id}/accept`)
      .set('X-Client-Session', owner2Session)
      .send({})
      .expect(403);

    // Owner2 cannot delete owner1's invite
    await request
      .delete(`/api/account-invites/${id}`)
      .set('X-Client-Session', owner2Session)
      .expect(403);
  });
});
