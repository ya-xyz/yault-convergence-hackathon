'use strict';

/**
 * scheduler.test.js — Unit tests for scheduler cooldown finalization logic.
 *
 * Uses a real sql.js-backed test database (isolated per run) so that
 * processDueAllowances() and maybeFinalizeDecision() exercise the actual
 * DB read/write paths, while Arweave and RWA delivery are neutralised
 * by unsetting the wallet JWK.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Environment — must be set BEFORE any require() that touches db.js
// ---------------------------------------------------------------------------

const TEST_DB_PATH = path.join(
  __dirname, '..', '..', 'data',
  'test-scheduler-' + Date.now() + '.db'
);
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'test';
process.env.DEFAULT_COOLDOWN_HOURS = '0';

// Ensure Arweave / RWA delivery paths are inert
delete process.env.ARWEAVE_WALLET_JWK;

// ---------------------------------------------------------------------------
// Module references (loaded after env is configured)
// ---------------------------------------------------------------------------

let db;
let processDueAllowances;
let maybeFinalizeDecision;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a trigger data object in cooldown state with sensible defaults. */
function makeCooldownTrigger(overrides = {}) {
  const now = Date.now();
  return {
    trigger_id: overrides.trigger_id || 'trig-test-' + crypto.randomBytes(4).toString('hex'),
    wallet_id: 'wallet-abc',
    authority_id: 'auth-xyz',
    status: 'cooldown',
    decision: 'release',
    trigger_type: 'legal_event',
    recipient_index: 1,
    effective_at: now - 1000,           // already past cooldown
    decided_at: now - 60000,
    decided_by: 'pubkey-hex',
    decision_reason: 'verified death',
    decision_reason_code: 'verified_event',
    decision_evidence_hash: 'hash123',
    decision_signature: 'sig123',
    cooldown_ms: 3600000,
    created_at: now - 120000,
    ...overrides,
  };
}

/** Insert a trigger into the DB and return the data object. */
async function insertTrigger(data) {
  const id = data.trigger_id;
  await db.triggers.create(id, data);
  return data;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  db = require('../../server/db');
  await db.ensureReady();

  // Scheduler exports
  const scheduler = require('../../server/services/scheduler');
  processDueAllowances = scheduler.processDueAllowances;

  // Decision router — exposes _maybeFinalizeDecision
  const decisionRouter = require('../../server/api/trigger/decision');
  maybeFinalizeDecision = decisionRouter._maybeFinalizeDecision;
});

afterAll(() => {
  db._close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch (_) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler — cooldown finalization via processDueAllowances()', () => {

  afterEach(async () => {
    // Clean the triggers table between tests so state does not leak.
    const allIds = await db.triggers.findAllIds();
    for (const id of allIds) {
      await db.triggers.delete(id);
    }
  });

  // 1. Finalize expired cooldown trigger (release)
  test('finalizes an expired cooldown trigger with decision=release to status=released', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-release-001',
      decision: 'release',
      effective_at: Date.now() - 5000,
    });
    await insertTrigger(data);

    await processDueAllowances();

    const updated = await db.triggers.findById('trig-release-001');
    expect(updated).not.toBeNull();
    expect(updated.status).toBe('released');
    expect(typeof updated.finalized_at).toBe('number');
    expect(updated.finalized_at).toBeGreaterThan(0);
  });

  // 2. Skip non-expired cooldown trigger
  test('does NOT finalize a cooldown trigger whose effective_at is in the future', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-future-001',
      effective_at: Date.now() + 60 * 60 * 1000, // 1 hour from now
    });
    await insertTrigger(data);

    await processDueAllowances();

    const updated = await db.triggers.findById('trig-future-001');
    expect(updated).not.toBeNull();
    expect(updated.status).toBe('cooldown');
    expect(updated.finalized_at).toBeUndefined();
  });

  // 3. Skip non-cooldown triggers
  test('does NOT touch triggers that are not in cooldown status', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-pending-001',
      status: 'pending',
      effective_at: Date.now() - 5000,
    });
    await insertTrigger(data);

    await processDueAllowances();

    const updated = await db.triggers.findById('trig-pending-001');
    expect(updated).not.toBeNull();
    expect(updated.status).toBe('pending');
    expect(updated.finalized_at).toBeUndefined();
  });

  // 4. Finalize hold decision
  test('finalizes an expired cooldown trigger with decision=hold to status=hold', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-hold-001',
      decision: 'hold',
      effective_at: Date.now() - 5000,
    });
    await insertTrigger(data);

    await processDueAllowances();

    const updated = await db.triggers.findById('trig-hold-001');
    expect(updated).not.toBeNull();
    expect(updated.status).toBe('hold');
    expect(typeof updated.finalized_at).toBe('number');
  });

  // 8. Multiple cooldown triggers finalized in a single tick
  test('finalizes multiple expired cooldown triggers in a single processDueAllowances tick', async () => {
    const ids = ['trig-batch-001', 'trig-batch-002', 'trig-batch-003'];

    for (const id of ids) {
      await insertTrigger(makeCooldownTrigger({
        trigger_id: id,
        decision: 'release',
        effective_at: Date.now() - 2000,
      }));
    }

    await processDueAllowances();

    for (const id of ids) {
      const updated = await db.triggers.findById(id);
      expect(updated).not.toBeNull();
      expect(updated.status).toBe('released');
      expect(typeof updated.finalized_at).toBe('number');
    }
  });
});

describe('maybeFinalizeDecision — direct invocation', () => {

  afterEach(async () => {
    const allIds = await db.triggers.findAllIds();
    for (const id of allIds) {
      await db.triggers.delete(id);
    }
  });

  // 5. Cooldown expired — should finalize to released
  test('returns trigger with status=released when cooldown has expired', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-direct-001',
      decision: 'release',
      effective_at: Date.now() - 3000,
    });
    await insertTrigger(data);

    const result = await maybeFinalizeDecision('trig-direct-001', data);

    expect(result).not.toBeNull();
    expect(result.status).toBe('released');
    expect(typeof result.finalized_at).toBe('number');

    // Also verify the DB was updated
    const fromDb = await db.triggers.findById('trig-direct-001');
    expect(fromDb.status).toBe('released');
  });

  // 6. Not yet expired — should leave as cooldown
  test('returns trigger unchanged when effective_at is in the future', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-direct-002',
      effective_at: Date.now() + 60000,
    });
    await insertTrigger(data);

    const result = await maybeFinalizeDecision('trig-direct-002', data);

    expect(result.status).toBe('cooldown');
    expect(result.finalized_at).toBeUndefined();

    // DB should be unchanged
    const fromDb = await db.triggers.findById('trig-direct-002');
    expect(fromDb.status).toBe('cooldown');
  });

  // 7. Non-cooldown status — should return trigger as-is
  test('returns trigger unchanged when status is not cooldown', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-direct-003',
      status: 'pending',
    });
    await insertTrigger(data);

    const result = await maybeFinalizeDecision('trig-direct-003', data);

    expect(result.status).toBe('pending');
    expect(result.finalized_at).toBeUndefined();

    const fromDb = await db.triggers.findById('trig-direct-003');
    expect(fromDb.status).toBe('pending');
  });

  // Bonus: decision=reject should finalize to status=reject
  test('finalizes decision=reject to status=reject', async () => {
    const data = makeCooldownTrigger({
      trigger_id: 'trig-direct-reject',
      decision: 'reject',
      effective_at: Date.now() - 1000,
    });
    await insertTrigger(data);

    const result = await maybeFinalizeDecision('trig-direct-reject', data);

    expect(result.status).toBe('reject');
    expect(typeof result.finalized_at).toBe('number');
  });
});
