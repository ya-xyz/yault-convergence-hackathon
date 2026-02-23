'use strict';

jest.mock('../../server/db', () => ({
  triggers: {
    findAll: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('../../server/services/attestationGate', () => ({
  evaluateReleaseAttestationGate: jest.fn(),
}));

const db = require('../../server/db');
const { evaluateReleaseAttestationGate } = require('../../server/services/attestationGate');
const pendingRouter = require('../../server/api/trigger/pending');

describe('trigger pending cooldown finalizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps cooldown state on ATTESTATION_RPC_ERROR (soft failure)', async () => {
    const now = Date.now();
    const trigger = {
      trigger_id: 't-1',
      status: 'cooldown',
      trigger_type: 'oracle',
      wallet_id: 'w1',
      recipient_index: 0,
      effective_at: now - 1000,
    };
    db.triggers.findAll.mockResolvedValue([trigger]);
    evaluateReleaseAttestationGate.mockResolvedValue({
      valid: false,
      code: 'ATTESTATION_RPC_ERROR',
      detail: 'timeout',
    });

    await pendingRouter._finalizeCooldowns();

    expect(db.triggers.update).toHaveBeenCalledTimes(1);
    const updated = db.triggers.update.mock.calls[0][1];
    expect(updated.status).toBe('cooldown');
    expect(updated.blocked_reason_code).toBeUndefined();
  });

  test('marks attestation_blocked on hard policy failure', async () => {
    const now = Date.now();
    const trigger = {
      trigger_id: 't-2',
      status: 'cooldown',
      trigger_type: 'oracle',
      wallet_id: 'w2',
      recipient_index: 1,
      effective_at: now - 1000,
    };
    db.triggers.findAll.mockResolvedValue([trigger]);
    evaluateReleaseAttestationGate.mockResolvedValue({
      valid: false,
      code: 'ATTESTATION_DECISION_MISMATCH',
      detail: 'hold',
    });

    await pendingRouter._finalizeCooldowns();

    expect(db.triggers.update).toHaveBeenCalledTimes(1);
    const updated = db.triggers.update.mock.calls[0][1];
    expect(updated.status).toBe('attestation_blocked');
    expect(updated.blocked_reason_code).toBe('ATTESTATION_DECISION_MISMATCH');
  });

  test('finalizes to released without gate for non-oracle trigger (legal_event / time-based)', async () => {
    const now = Date.now();
    const trigger = {
      trigger_id: 't-3',
      status: 'cooldown',
      trigger_type: 'legal_event',
      wallet_id: 'w3',
      recipient_index: 0,
      effective_at: now - 1000,
    };
    db.triggers.findAll.mockResolvedValue([trigger]);

    await pendingRouter._finalizeCooldowns();

    expect(evaluateReleaseAttestationGate).not.toHaveBeenCalled();
    expect(db.triggers.update).toHaveBeenCalledTimes(1);
    const updated = db.triggers.update.mock.calls[0][1];
    expect(updated.status).toBe('released');
  });
});

