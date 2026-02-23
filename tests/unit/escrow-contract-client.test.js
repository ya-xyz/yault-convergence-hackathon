/**
 * Unit tests for server/services/escrowContract.js
 *
 * Tests walletIdHash, getEscrowReadOnly with various config shapes,
 * and cross-module hash consistency with the frontend yault-escrow.js module.
 */

'use strict';

const { ethers } = require('ethers');
const {
  walletIdHash,
  getEscrowReadOnly,
} = require('../../server/services/escrowContract');

// Load the frontend module for cross-module consistency test
global.ethers = ethers;
const YaultEscrowFrontend = require('../../webapp/public/js/yault-escrow');

// ---------------------------------------------------------------------------
//  walletIdHash
// ---------------------------------------------------------------------------

describe('escrowContract.walletIdHash', () => {
  test('returns keccak256(toUtf8Bytes(walletId))', () => {
    const input = 'test-wallet';
    const expected = ethers.keccak256(ethers.toUtf8Bytes(input));
    expect(walletIdHash(input)).toBe(expected);
  });

  test('returns 0x-prefixed 64-char hex', () => {
    const out = walletIdHash('hello');
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('is deterministic', () => {
    expect(walletIdHash('abc')).toBe(walletIdHash('abc'));
  });

  test('different inputs produce different hashes', () => {
    expect(walletIdHash('a')).not.toBe(walletIdHash('b'));
  });

  test('empty string produces valid bytes32', () => {
    const out = walletIdHash('');
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out).toBe(ethers.keccak256(ethers.toUtf8Bytes('')));
  });
});

// ---------------------------------------------------------------------------
//  walletIdHash consistency: server vs frontend
// ---------------------------------------------------------------------------

describe('walletIdHash cross-module consistency', () => {
  const testInputs = [
    'test-wallet',
    '0x1234567890abcdef1234567890abcdef12345678',
    '',
    'a',
    'some-longer-wallet-identifier-string',
  ];

  test.each(testInputs)('server and frontend produce the same hash for "%s"', (input) => {
    expect(walletIdHash(input)).toBe(YaultEscrowFrontend.walletIdHash(input));
  });
});

// ---------------------------------------------------------------------------
//  getEscrowReadOnly
// ---------------------------------------------------------------------------

describe('escrowContract.getEscrowReadOnly', () => {
  test('returns non-null object with provider, escrow, escrowAddress for valid config', () => {
    const validAddr = '0x' + 'a'.repeat(40);
    const result = getEscrowReadOnly({ escrow: { address: validAddr } });
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('provider');
    expect(result).toHaveProperty('escrow');
    expect(result).toHaveProperty('escrowAddress');
    // The module stores the trimmed addr string directly
    expect(result.escrowAddress).toBe(validAddr);
  });

  test('returns null when address is empty string', () => {
    const result = getEscrowReadOnly({ escrow: { address: '' } });
    expect(result).toBeNull();
  });

  test('returns null when address is zero address', () => {
    const result = getEscrowReadOnly({
      escrow: { address: '0x0000000000000000000000000000000000000000' },
    });
    expect(result).toBeNull();
  });

  test('returns null when config is null', () => {
    const result = getEscrowReadOnly(null);
    expect(result).toBeNull();
  });

  test('returns null when config is undefined', () => {
    const result = getEscrowReadOnly(undefined);
    expect(result).toBeNull();
  });

  test('returns null when config is empty object', () => {
    const result = getEscrowReadOnly({});
    expect(result).toBeNull();
  });

  test('returns null when escrow key is missing', () => {
    const result = getEscrowReadOnly({ someOtherKey: 'value' });
    expect(result).toBeNull();
  });

  test('returns null when escrow.address is missing', () => {
    const result = getEscrowReadOnly({ escrow: {} });
    expect(result).toBeNull();
  });

  test('returns null when address is invalid hex', () => {
    const result = getEscrowReadOnly({ escrow: { address: 'not-an-address' } });
    expect(result).toBeNull();
  });

  test('returns null when address is whitespace only', () => {
    const result = getEscrowReadOnly({ escrow: { address: '   ' } });
    expect(result).toBeNull();
  });

  test('returns null for address with invalid checksum mixed case', () => {
    // ethers.getAddress throws for bad checksum mixed-case, so getEscrowReadOnly returns null
    const badChecksum = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    const result = getEscrowReadOnly({ escrow: { address: badChecksum } });
    expect(result).toBeNull();
  });

  test('returns valid result for properly checksummed address', () => {
    // Use ethers to produce a valid checksummed address
    const checksummed = ethers.getAddress('0x' + 'ab'.repeat(20));
    const result = getEscrowReadOnly({ escrow: { address: checksummed } });
    expect(result).not.toBeNull();
    expect(result.escrowAddress).toBe(checksummed);
  });

  test('uses custom rpcUrl from escrow config', () => {
    const addr = '0x' + 'a'.repeat(40);
    const result = getEscrowReadOnly({
      escrow: { address: addr, rpcUrl: 'https://custom-rpc.example.com' },
    });
    expect(result).not.toBeNull();
    expect(result.provider).toBeDefined();
  });

  test('falls back to contracts.evmRpcUrl if escrow.rpcUrl is not set', () => {
    const addr = '0x' + 'a'.repeat(40);
    const result = getEscrowReadOnly({
      escrow: { address: addr },
      contracts: { evmRpcUrl: 'https://fallback-rpc.example.com' },
    });
    expect(result).not.toBeNull();
    expect(result.provider).toBeDefined();
  });
});
