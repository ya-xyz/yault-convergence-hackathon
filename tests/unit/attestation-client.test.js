/**
 * Unit tests for server/services/attestationClient.js
 *
 * Tests walletIdHash (deterministic, format) and getAttestation/hasAttestation
 * with invalid/empty contract address (no real RPC).
 */

'use strict';

const {
  walletIdHash,
  getAttestation,
  hasAttestation,
  SOURCE_ORACLE,
  SOURCE_FALLBACK,
  DECISION_RELEASE,
  DECISION_HOLD,
  DECISION_REJECT,
} = require('../../server/services/attestationClient');

describe('attestationClient.walletIdHash', () => {
  test('returns 0x-prefixed 64-char hex for string', () => {
    const out = walletIdHash('wallet-1');
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('is deterministic for same input', () => {
    expect(walletIdHash('abc')).toBe(walletIdHash('abc'));
    expect(walletIdHash('')).toBe(walletIdHash(''));
  });

  test('different inputs produce different hashes', () => {
    expect(walletIdHash('a')).not.toBe(walletIdHash('b'));
    expect(walletIdHash('wallet-1')).not.toBe(walletIdHash('wallet-2'));
  });

  test('empty string produces valid bytes32', () => {
    const out = walletIdHash('');
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('attestationClient.getAttestation', () => {
  test('returns null when contractAddress is missing', async () => {
    const result = await getAttestation({
      rpcUrl: 'https://eth.llamarpc.com',
      contractAddress: '',
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBeNull();
  });

  test('returns null when contractAddress is null', async () => {
    const result = await getAttestation({
      rpcUrl: 'https://eth.llamarpc.com',
      contractAddress: null,
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBeNull();
  });

  test('returns null when contractAddress is zero address', async () => {
    const result = await getAttestation({
      rpcUrl: 'https://eth.llamarpc.com',
      contractAddress: '0x0000000000000000000000000000000000000000',
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBeNull();
  });

  test('returns null for invalid address format', async () => {
    const result = await getAttestation({
      rpcUrl: 'https://eth.llamarpc.com',
      contractAddress: 'not-an-address',
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBeNull();
  });

  // With valid address but unreachable RPC, getAttestation catches and returns null.
  // Skipped by default to avoid ethers retry logs; run with --testNamePattern to include.
  test.skip('returns null when contractAddress is valid but RPC unreachable', async () => {
    const result = await getAttestation({
      rpcUrl: 'http://127.0.0.1:9999',
      contractAddress: '0x0000000000000000000000000000000000000001',
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBeNull();
  }, 5000);
});

describe('attestationClient.hasAttestation', () => {
  test('returns false when contractAddress is missing', async () => {
    const result = await hasAttestation({
      rpcUrl: 'https://eth.llamarpc.com',
      contractAddress: '',
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBe(false);
  });

  test('returns false for invalid address format', async () => {
    const result = await hasAttestation({
      rpcUrl: 'https://eth.llamarpc.com',
      contractAddress: 'invalid',
      walletId: 'w1',
      recipientIndex: 0,
    });
    expect(result).toBe(false);
  });
});

describe('attestationClient constants', () => {
  test('SOURCE_ORACLE and SOURCE_FALLBACK are 0 and 1', () => {
    expect(SOURCE_ORACLE).toBe(0);
    expect(SOURCE_FALLBACK).toBe(1);
  });

  test('DECISION_RELEASE, HOLD, REJECT are 0, 1, 2', () => {
    expect(DECISION_RELEASE).toBe(0);
    expect(DECISION_HOLD).toBe(1);
    expect(DECISION_REJECT).toBe(2);
  });
});
