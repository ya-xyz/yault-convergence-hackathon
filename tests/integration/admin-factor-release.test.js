/**
 * Authority AdminFactor Release & Release Links Integration Tests
 *
 * Coverage:
 * - GET  /api/authority/AdminFactor/release — public info page
 * - POST /api/authority/AdminFactor/release — authority submits admin factor
 * - GET  /api/authority/release-links — list release links for authority
 * - Authorization: authority can only link recipients assigned to them
 * - Link cleanup after successful submission
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-afr-' + Date.now() + '.db');
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdminFactor Release GET (public info)', () => {
  test('returns HTML info for valid recipient_id', async () => {
    const recipientId = 'a'.repeat(64);
    const res = await request
      .get('/api/authority/AdminFactor/release')
      .query({ recipient_id: recipientId })
      .expect(200);
    expect(res.text).toContain('recipient_id is valid');
  });

  test('returns error HTML for invalid recipient_id', async () => {
    const res = await request
      .get('/api/authority/AdminFactor/release')
      .query({ recipient_id: 'too-short' })
      .expect(400);
    expect(res.text).toContain('invalid');
  });

  test('returns error HTML when missing recipient_id', async () => {
    const res = await request
      .get('/api/authority/AdminFactor/release')
      .expect(400);
    expect(res.text).toContain('invalid');
  });
});

describe('AdminFactor Release POST (authority submission)', () => {
  let authority;
  const mnemonicHash = 'b'.repeat(64);
  const adminFactor = 'c'.repeat(64);
  const evmAddress = '0x' + 'd'.repeat(40);

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority();
    const db = require('../../server/db');

    // Seed: create recipientMnemonicAdmin record (as if client uploaded path-credentials)
    await db.recipientMnemonicAdmin.create(mnemonicHash, {
      evm_address: evmAddress,
      mnemonic_hash: mnemonicHash,
      admin_factor: null,
      label: 'Recipient 0',
      plan_wallet_id: 'owner-wallet-123',
      created_at: new Date().toISOString(),
    });

    // Seed: create authorityReleaseLinks record (as if client sent release link)
    // Note: id must be included in data because findByField only returns data column
    const linkId = crypto.randomBytes(16).toString('hex');
    await db.authorityReleaseLinks.create(linkId, {
      id: linkId,
      authority_id: authority.authorityId,
      release_link: '/api/authority/AdminFactor/release?recipient_id=' + mnemonicHash,
      recipient_id: mnemonicHash,
      evm_address: evmAddress,
      created_at: new Date().toISOString(),
    });
  });

  test('authority can submit admin factor for linked recipient', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .post('/api/authority/AdminFactor/release')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        recipient_id: mnemonicHash,
        admin_factor: adminFactor,
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.recipient_id).toBe(mnemonicHash);
    expect(res.body.evm_address).toBe(evmAddress);
    expect(res.body.processed_link_ids).toHaveLength(1);

    // Verify the record was updated
    const db = require('../../server/db');
    const record = await db.recipientMnemonicAdmin.findById(mnemonicHash);
    expect(record.admin_factor).toBe(adminFactor);
    expect(record.linked_by_authority_id).toBe(authority.authorityId);

    // Verify the release link was cleaned up
    const links = await db.authorityReleaseLinks.findByAuthority(authority.authorityId);
    expect(links).toHaveLength(0);
  });

  test('rejects submission from unauthorized authority', async () => {
    // Create another authority that has no release links for this recipient
    const otherAuth = await registerAndVerifyAuthority({ bar_number: 'BAR-OTHER' });
    const auth = await authenticate(otherAuth.keypair.publicKey, otherAuth.keypair.secretKey);

    const otherHash = 'e'.repeat(64);
    const db = require('../../server/db');
    await db.recipientMnemonicAdmin.create(otherHash, {
      evm_address: '0xother',
      mnemonic_hash: otherHash,
      admin_factor: null,
      label: 'Other Recipient',
      plan_wallet_id: 'other-wallet',
      created_at: new Date().toISOString(),
    });

    const res = await request
      .post('/api/authority/AdminFactor/release')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        recipient_id: otherHash,
        admin_factor: 'f'.repeat(64),
      })
      .expect(403);

    expect(res.body.error).toBe('Forbidden');
  });

  test('rejects invalid recipient_id format', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    await request
      .post('/api/authority/AdminFactor/release')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        recipient_id: 'invalid',
        admin_factor: 'a'.repeat(64),
      })
      .expect(400);
  });

  test('rejects invalid admin_factor format', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    await request
      .post('/api/authority/AdminFactor/release')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        recipient_id: 'a'.repeat(64),
        admin_factor: 'too-short',
      })
      .expect(400);
  });

  test('returns 404 for non-existent recipient record', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    // Create a release link for a non-existent recipient record
    const db = require('../../server/db');
    const fakeHash = '1'.repeat(64);
    const linkId = crypto.randomBytes(16).toString('hex');
    await db.authorityReleaseLinks.create(linkId, {
      id: linkId,
      authority_id: authority.authorityId,
      release_link: '/release?recipient_id=' + fakeHash,
      recipient_id: fakeHash,
      created_at: new Date().toISOString(),
    });

    const res = await request
      .post('/api/authority/AdminFactor/release')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .send({
        recipient_id: fakeHash,
        admin_factor: '2'.repeat(64),
      })
      .expect(404);

    expect(res.body.error).toContain('No record');
  });

  test('requires authentication', async () => {
    await request
      .post('/api/authority/AdminFactor/release')
      .send({ recipient_id: 'a'.repeat(64), admin_factor: 'b'.repeat(64) })
      .expect(401);
  });
});

describe('Authority Release Links', () => {
  let authority;

  beforeAll(async () => {
    authority = await registerAndVerifyAuthority({ bar_number: 'BAR-LINKS' });
    const db = require('../../server/db');

    // Seed some release links (include id in data — findByField only returns data column)
    for (let i = 0; i < 3; i++) {
      const linkId = crypto.randomBytes(16).toString('hex');
      await db.authorityReleaseLinks.create(linkId, {
        id: linkId,
        authority_id: authority.authorityId,
        release_link: `http://localhost/release?recipient_id=${'a'.repeat(64)}&AdminFactor=secret${i}`,
        recipient_id: 'a'.repeat(64),
        evm_address: '0x' + 'b'.repeat(40),
        created_at: new Date().toISOString(),
      });
    }
  });

  test('GET /api/authority/release-links returns sanitized links', async () => {
    const auth = await authenticate(authority.keypair.publicKey, authority.keypair.secretKey);

    const res = await request
      .get('/api/authority/release-links')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(res.body.items).toBeDefined();
    expect(res.body.items.length).toBeGreaterThanOrEqual(3);

    // Verify AdminFactor is stripped from links
    for (const item of res.body.items) {
      expect(item.release_link).not.toContain('AdminFactor=');
      expect(item.release_link).not.toContain('admin_factor=');
      expect(item.recipient_id).toBeTruthy();
      expect(item.id).toBeTruthy();
    }
  });

  test('requires authentication', async () => {
    await request.get('/api/authority/release-links').expect(401);
  });

  test('returns empty for authority with no links', async () => {
    const other = await registerAndVerifyAuthority({ bar_number: 'BAR-EMPTY' });
    const auth = await authenticate(other.keypair.publicKey, other.keypair.secretKey);

    const res = await request
      .get('/api/authority/release-links')
      .set('Authorization', `Ed25519 ${auth.challenge_id}:${auth.signature}`)
      .expect(200);

    expect(res.body.items).toEqual([]);
  });
});
