/**
 * Wallet Plan API Integration Tests
 *
 * Coverage:
 * - GET /api/wallet-plan — load saved plan
 * - PUT /api/wallet-plan — save/update plan
 * - POST /api/wallet-plan/admin-factor — upload admin factor
 * - POST /api/wallet-plan/path-credentials — upload mnemonic hash + evm mapping
 * - POST /api/wallet-plan/send-release-link — send release link to authority
 * - GET /api/wallet-plan/recipient-addresses — resolve recipient multi-chain addresses
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data', 'test-wp-' + Date.now() + '.db');
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
  const messageBytes = Buffer.from(challenge, 'hex');
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return { challenge_id, signature: Buffer.from(signature).toString('hex') };
}

async function getSessionToken(pubkeyHex, secretKey) {
  const auth = await authenticate(pubkeyHex, secretKey);
  const res = await request.post('/api/auth/verify').send(auth).expect(200);
  return res.body.session_token;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wallet Plan CRUD', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('GET /api/wallet-plan returns null when no plan exists', async () => {
    const res = await request
      .get('/api/wallet-plan')
      .set('X-Client-Session', sessionToken)
      .expect(200);
    expect(res.body.plan).toBeNull();
  });

  test('PUT /api/wallet-plan saves a plan', async () => {
    const plan = {
      triggerTypes: { oracle: true, inactivity: false },
      recipients: [{ label: 'Alice', email: 'alice@test.com', address: '0x' + 'a'.repeat(40) }],
      triggerConfig: { oracle: {}, inactivityMonths: 12 },
    };

    const res = await request
      .put('/api/wallet-plan')
      .set('X-Client-Session', sessionToken)
      .send(plan)
      .expect(200);

    expect(res.body.plan.triggerTypes.oracle).toBe(true);
    expect(res.body.plan.recipients).toHaveLength(1);
    expect(res.body.plan.recipients[0].label).toBe('Alice');
    expect(res.body.plan.createdAt).toBeTruthy();
    expect(res.body.plan.updatedAt).toBeTruthy();
  });

  test('GET /api/wallet-plan returns saved plan', async () => {
    const res = await request
      .get('/api/wallet-plan?chain=ethereum&token=ETH')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    expect(res.body.plan).not.toBeNull();
    expect(res.body.plan.triggerTypes.oracle).toBe(true);
    expect(res.body.plan.recipients[0].label).toBe('Alice');
    expect(res.body.plan.chain_key).toBe('ethereum');
    expect(res.body.plan.token_symbol).toBe('ETH');
  });

  test('PUT /api/wallet-plan preserves createdAt on update', async () => {
    const first = await request
      .get('/api/wallet-plan?chain=ethereum&token=ETH')
      .set('X-Client-Session', sessionToken)
      .expect(200);

    const originalCreatedAt = first.body.plan.createdAt;

    const updated = await request
      .put('/api/wallet-plan')
      .set('X-Client-Session', sessionToken)
      .send({
        triggerTypes: { oracle: false, inactivity: true },
        recipients: [{ label: 'Bob', email: 'bob@test.com' }],
        triggerConfig: { inactivityMonths: 24 },
      })
      .expect(200);

    expect(updated.body.plan.createdAt).toBe(originalCreatedAt);
    expect(updated.body.plan.triggerTypes.inactivity).toBe(true);
    expect(updated.body.plan.recipients[0].label).toBe('Bob');
  });

  test('PUT /api/wallet-plan with empty body uses defaults', async () => {
    const kp2 = generateKeypair();
    const token2 = await getSessionToken(kp2.publicKey, kp2.secretKey);

    const res = await request
      .put('/api/wallet-plan')
      .set('X-Client-Session', token2)
      .send({})
      .expect(200);

    expect(res.body.plan.triggerTypes).toEqual({});
    expect(res.body.plan.recipients).toEqual([]);
    expect(res.body.plan.triggerConfig).toEqual({});
  });

  test('requires authentication', async () => {
    await request.get('/api/wallet-plan').expect(401);
    await request.put('/api/wallet-plan').send({}).expect(401);
  });
});

describe('Wallet Plan Admin Factor', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('POST /api/wallet-plan/admin-factor accepts valid data', async () => {
    const res = await request
      .post('/api/wallet-plan/admin-factor')
      .set('X-Client-Session', sessionToken)
      .send({
        recipientIndex: 0,
        label: 'Alice',
        admin_factor_hex: 'a'.repeat(64),
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  test('requires authentication', async () => {
    await request
      .post('/api/wallet-plan/admin-factor')
      .send({ recipientIndex: 0, label: 'Alice', admin_factor_hex: 'a'.repeat(64) })
      .expect(401);
  });
});

describe('Wallet Plan Path Credentials', () => {
  let kp;
  let sessionToken;
  const mnemonicHash = 'b'.repeat(64);
  const evmAddress = '0x' + 'c'.repeat(40);

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('POST /api/wallet-plan/path-credentials stores mnemonic hash mapping', async () => {
    const res = await request
      .post('/api/wallet-plan/path-credentials')
      .set('X-Client-Session', sessionToken)
      .send({
        recipientIndex: 0,
        label: 'Alice',
        mnemonic: 'word1 word2 word3 word4 word5 word6',
        passphrase: 'test-pass',
        mnemonic_hash: mnemonicHash,
        evm_address: evmAddress,
      })
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify the record was created in DB
    const db = require('../../server/db');
    const record = await db.recipientMnemonicAdmin.findById(mnemonicHash);
    expect(record).not.toBeNull();
    expect(record.evm_address).toBe(evmAddress);
    expect(record.mnemonic_hash).toBe(mnemonicHash);
    expect(record.admin_factor).toBeNull();
  });

  test('ignores invalid mnemonic hash format', async () => {
    const res = await request
      .post('/api/wallet-plan/path-credentials')
      .set('X-Client-Session', sessionToken)
      .send({
        recipientIndex: 1,
        label: 'Bob',
        mnemonic: 'word1 word2',
        passphrase: 'pass',
        mnemonic_hash: 'too-short',
        evm_address: '0xbob',
      })
      .expect(200);

    // Still returns ok (non-fatal), but does not store
    expect(res.body.ok).toBe(true);
  });
});

describe('Wallet Plan Send Release Link', () => {
  let kp;
  let sessionToken;

  beforeAll(async () => {
    kp = generateKeypair();
    sessionToken = await getSessionToken(kp.publicKey, kp.secretKey);
  });

  test('POST /api/wallet-plan/send-release-link creates record', async () => {
    const recipientId = 'd'.repeat(64);
    const res = await request
      .post('/api/wallet-plan/send-release-link')
      .set('X-Client-Session', sessionToken)
      .send({
        authority_id: 'auth-123',
        release_link: 'http://localhost:3001/api/authority/AdminFactor/release?recipient_id=' + recipientId + '&AdminFactor=secret123',
        recipient_id: recipientId,
        evm_address: '0x' + 'e'.repeat(40),
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBeTruthy();

    // Verify AdminFactor was stripped from stored link
    const db = require('../../server/db');
    const links = await db.authorityReleaseLinks.findByAuthority('auth-123');
    expect(links).toHaveLength(1);
    expect(links[0].release_link).not.toContain('AdminFactor=secret123');
    expect(links[0].release_link).not.toContain('admin_factor=');
    expect(links[0].recipient_id).toBe(recipientId);
  });

  test('rejects missing required fields', async () => {
    const res = await request
      .post('/api/wallet-plan/send-release-link')
      .set('X-Client-Session', sessionToken)
      .send({ authority_id: 'auth-123' })
      .expect(400);

    expect(res.body.error).toContain('required');
  });
});

describe('Wallet Plan Recipient Addresses', () => {
  let ownerKp;
  let ownerSession;
  let recipientKp;
  let recipientSession;
  let inviteId;
  let recipientPubkey; // full 64-char pubkey used as wallet id

  beforeAll(async () => {
    ownerKp = generateKeypair();
    ownerSession = await getSessionToken(ownerKp.publicKey, ownerKp.secretKey);

    recipientKp = generateKeypair();
    recipientSession = await getSessionToken(recipientKp.publicKey, recipientKp.secretKey);
    recipientPubkey = recipientKp.publicKey.toLowerCase();

    // Save recipient addresses (evm_address must match auth pubkey which is 64-char Ed25519)
    await request
      .put('/api/me/addresses')
      .set('X-Client-Session', recipientSession)
      .send({
        addresses: {
          bitcoin_address: 'bc1qtest',
          solana_address: 'So1ana...',
        },
      })
      .expect(200);

    // Create invite and accept it to link accounts
    const inviteRes = await request
      .post('/api/account-invites')
      .set('X-Client-Session', ownerSession)
      .send({ email: 'recipient@test.com' })
      .expect(201);

    inviteId = inviteRes.body.id;

    // Accept the invite (sets linked_wallet_address to full pubkey)
    const db = require('../../server/db');
    const invite = await db.accountInvites.findById(inviteId);
    await db.accountInvites.update(inviteId, {
      ...invite,
      status: 'accepted',
      linked_wallet_address: recipientPubkey,
    });
  });

  test('resolves addresses by wallet param', async () => {
    const res = await request
      .get('/api/wallet-plan/recipient-addresses')
      .query({ wallets: recipientPubkey })
      .set('X-Client-Session', ownerSession)
      .expect(200);

    expect(res.body.addresses).toBeDefined();
    const entry = res.body.addresses[recipientPubkey];
    expect(entry).toBeDefined();
    expect(entry.bitcoin_address).toBe('bc1qtest');
  });

  test('resolves addresses by invite_ids param', async () => {
    const res = await request
      .get('/api/wallet-plan/recipient-addresses')
      .query({ invite_ids: inviteId })
      .set('X-Client-Session', ownerSession)
      .expect(200);

    expect(res.body.addresses).toBeDefined();
    expect(res.body.inviteIdToEvm).toBeDefined();
    expect(res.body.inviteIdToEvm[inviteId]).toBeTruthy();
  });

  test('rejects when no wallets or invite_ids', async () => {
    await request
      .get('/api/wallet-plan/recipient-addresses')
      .set('X-Client-Session', ownerSession)
      .expect(400);
  });

  test('requires authentication', async () => {
    await request
      .get('/api/wallet-plan/recipient-addresses')
      .query({ wallets: 'abc123' })
      .expect(401);
  });
});
