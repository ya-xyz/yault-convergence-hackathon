'use strict';

let mockOracleEnabled = true;
jest.mock('../../server/config', () => ({
  oracle: {
    get enabled() {
      return mockOracleEnabled;
    },
    rpcUrl: 'https://rpc.example',
    releaseAttestationAddress: '0x0000000000000000000000000000000000000001',
  },
}));

jest.mock('../../server/services/attestationClient', () => ({
  getAttestation: jest.fn(),
}));

const { getAttestation } = require('../../server/services/attestationClient');
const { evaluateReleaseAttestationGate } = require('../../server/services/attestationGate');

describe('attestation gate policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects when attestation is missing', async () => {
    getAttestation.mockResolvedValue(null);
    const gate = await evaluateReleaseAttestationGate({ walletId: 'w1', recipientIndex: 0 });
    expect(gate.valid).toBe(false);
    expect(gate.code).toBe('ATTESTATION_MISSING');
  });

  test('rejects when attestation decision is not release', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'hold',
      timestamp: Math.floor(Date.now() / 1000),
    });
    const gate = await evaluateReleaseAttestationGate({ walletId: 'w1', recipientIndex: 0 });
    expect(gate.valid).toBe(false);
    expect(gate.code).toBe('ATTESTATION_DECISION_MISMATCH');
  });

  test('rejects when attestation is expired', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'release',
      timestamp: Math.floor(Date.now() / 1000) - (8 * 24 * 60 * 60),
    });
    const gate = await evaluateReleaseAttestationGate({ walletId: 'w1', recipientIndex: 0 });
    expect(gate.valid).toBe(false);
    expect(gate.code).toBe('ATTESTATION_EXPIRED');
  });

  test('accepts valid oracle release attestation', async () => {
    getAttestation.mockResolvedValue({
      source: 'oracle',
      decision: 'release',
      timestamp: Math.floor(Date.now() / 1000),
    });
    const gate = await evaluateReleaseAttestationGate({ walletId: 'w1', recipientIndex: 0 });
    expect(gate.valid).toBe(true);
    expect(gate.code).toBeNull();
  });

  test('when oracle is not configured, allows release (pass-through)', async () => {
    mockOracleEnabled = false;
    try {
      const gate = await evaluateReleaseAttestationGate({ walletId: 'w1', recipientIndex: 0 });
      expect(gate.valid).toBe(true);
      expect(gate.code).toBeNull();
      expect(getAttestation).not.toHaveBeenCalled();
    } finally {
      mockOracleEnabled = true;
    }
  });
});

