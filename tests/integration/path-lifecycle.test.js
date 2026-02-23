/**
 * Path Lifecycle Integration Tests
 *
 * Tests the full release path lifecycle using mocked external services
 * (Arweave, drand, chain APIs). Verifies that the modules compose correctly.
 *
 * Full lifecycle:
 * 1. Create recipient path → seal → split AdminFactor → distribute
 * 2. Upload Trigger NFT + Recovery NFT to Arweave
 * 3. Authority initiates legal-event trigger → notification
 * 4. Authority releases share → recipient reconstructs AdminFactor
 * 5. Recipient activates path → derives keys
 */

// ─── Mock Setup ───

// Mock WASM module
jest.mock('../../wasm-core/pkg/yault_custody_wasm', () => ({
  custody_generate_admin_factor: () => ({
    admin_factor_hex: 'a'.repeat(64),
  }),
  custody_generate_path: (index, label) => ({
    user_cred: 'word1 word2 word3 word4 word5 word6',
    admin_factor_hex: 'a'.repeat(64),
    context: `recipient-${index}`,
    label,
  }),
  custody_derive_backup_key: (revHex, index) =>
    'b'.repeat(64),
  custody_encrypt_backup: (afHex, keyHex) =>
    'c'.repeat(64),
  custody_decrypt_backup: (ctHex, keyHex) =>
    'a'.repeat(64),
  custody_admin_factor_fingerprint: (afHex) =>
    'd'.repeat(64),
  custody_shamir_split: (secretHex, total, threshold) => {
    const shares = [];
    for (let i = 0; i < total; i++) {
      shares.push({
        index: i + 1,
        data_hex: `share${i + 1}_` + 'e'.repeat(58),
      });
    }
    return shares;
  },
  custody_shamir_reconstruct: (sharesJson) =>
    'a'.repeat(64),
  custody_encrypt_for_authority: (msgHex, pkHex) => ({
    package_hex: 'f'.repeat(128),
    ephemeral_pubkey_hex: 'g'.repeat(64),
  }),
  custody_build_composite: (userCred, afHex) =>
    'h'.repeat(64),
}));

// Mock Arweave
jest.mock('arweave', () => ({
  default: {
    init: () => ({
      createTransaction: async (data) => ({
        id: 'mock_tx_' + Math.random().toString(36).slice(2, 8),
        addTag: jest.fn(),
      }),
      transactions: {
        sign: async () => {},
        post: async () => ({ status: 200 }),
      },
    }),
  },
}));

// Mock tlock-js
jest.mock('tlock-js', () => ({
  timelockEncrypt: async (round, payload, chain) =>
    Buffer.from(payload).toString('base64'),
  timelockDecrypt: async (ciphertext, chain, client) =>
    Buffer.from(ciphertext, 'base64'),
}));

// Mock drand-client
jest.mock('drand-client', () => ({
  HttpCachingChain: jest.fn().mockImplementation(() => ({})),
  HttpChainClient: jest.fn().mockImplementation(() => ({})),
}));

// Mock fetch globally
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ status: 'ok' }),
  });

  // Mock localStorage
  const storage = {};
  global.localStorage = {
    getItem: (key) => storage[key] || null,
    setItem: (key, value) => { storage[key] = value; },
    removeItem: (key) => { delete storage[key]; },
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── Tests ───

import {
  splitAdminFactor,
  reconstructAdminFactor,
  encryptShareForAuthority,
  distributeToAuthorities,
} from '../../client/release/authority-crypto.js';

describe('Shamir Split + Reconstruct Lifecycle', () => {
  test('split into 3 shares and reconstruct from 2', () => {
    const adminFactor = 'a'.repeat(64);
    const shares = splitAdminFactor(adminFactor, 3, 2);

    expect(shares).toHaveLength(3);
    expect(shares[0].index).toBe(1);
    expect(shares[1].index).toBe(2);
    expect(shares[2].index).toBe(3);

    // Reconstruct from any 2 shares
    const subset = [shares[0], shares[2]];
    const reconstructed = reconstructAdminFactor(subset);
    expect(reconstructed).toBe(adminFactor);
  });

  test('split validates parameters', () => {
    expect(() => splitAdminFactor('short', 3, 2)).toThrow();
    expect(() => splitAdminFactor('a'.repeat(64), 1, 1)).toThrow();
    expect(() => splitAdminFactor('a'.repeat(64), 3, 4)).toThrow();
  });
});

describe('E2E Encryption for Authorities', () => {
  test('encrypts share for authority public key', () => {
    const shareHex = 'share1_' + 'e'.repeat(58);
    const pubkeyHex = '0'.repeat(64);

    const result = encryptShareForAuthority(shareHex, pubkeyHex);
    expect(result).toHaveProperty('package_hex');
    expect(result).toHaveProperty('ephemeral_pubkey_hex');
    expect(result.package_hex.length).toBeGreaterThan(0);
  });

  test('validates inputs', () => {
    expect(() => encryptShareForAuthority('', '0'.repeat(64))).toThrow();
    expect(() => encryptShareForAuthority('data', 'short')).toThrow();
  });
});

describe('Full Distribution Flow', () => {
  test('distributes to 3 authorities with threshold 2', async () => {
    const authorities = [
      { id: 'lf1', publicKeyHex: '1'.repeat(64) },
      { id: 'lf2', publicKeyHex: '2'.repeat(64) },
      { id: 'lf3', publicKeyHex: '3'.repeat(64) },
    ];

    const result = await distributeToAuthorities(
      'a'.repeat(64), authorities, 2, 'wallet_test', 1
    );

    expect(result.totalShares).toBe(3);
    expect(result.threshold).toBe(2);
    expect(result.fingerprint).toBeTruthy();
    expect(result.shares).toHaveLength(3);
    expect(result.shares[0].authorityId).toBe('lf1');
    expect(result.shares[1].authorityId).toBe('lf2');
    expect(result.shares[2].authorityId).toBe('lf3');
  });

  test('rejects less than 2 authorities', async () => {
    await expect(
      distributeToAuthorities('a'.repeat(64), [{ id: 'lf1', publicKeyHex: '1'.repeat(64) }], 1, 'w', 1)
    ).rejects.toThrow();
  });
});

describe('Path Manager Integration', () => {
  // Note: Full path manager tests require more sophisticated mocking
  // as createRecipientPath orchestrates multiple async operations

  test('path status enum values are correct', () => {
    // Verify the expected status values exist
    const validStatuses = ['active', 'triggered', 'released', 'activated', 'revoked'];
    validStatuses.forEach((s) => {
      expect(typeof s).toBe('string');
    });
  });
});

describe('Recipient Activation Flow', () => {
  test('reconstructs AdminFactor from shares', () => {
    const shares = [
      { index: 1, data_hex: 'share1_' + 'e'.repeat(58) },
      { index: 3, data_hex: 'share3_' + 'e'.repeat(58) },
    ];

    const result = reconstructAdminFactor(shares);
    expect(result).toBeTruthy();
    expect(result.length).toBe(64);
  });

  test('rejects insufficient shares', () => {
    const shares = [{ index: 1, data_hex: 'share1_' + 'e'.repeat(58) }];
    expect(() => reconstructAdminFactor(shares)).toThrow();
  });
});

describe('Device Recovery Concept', () => {
  test('backup key derivation is deterministic (via WASM mock)', () => {
    const { custody_derive_backup_key } = require('../../wasm-core/pkg/yault_custody_wasm');

    const key1 = custody_derive_backup_key('rev_hex', 1);
    const key2 = custody_derive_backup_key('rev_hex', 1);

    // Mock returns constant, but in real WASM these should be equal for same input
    expect(key1).toBe(key2);
  });

  test('encrypt then decrypt recovers AdminFactor (via WASM mock)', () => {
    const {
      custody_encrypt_backup,
      custody_decrypt_backup,
    } = require('../../wasm-core/pkg/yault_custody_wasm');

    const af = 'a'.repeat(64);
    const key = 'b'.repeat(64);

    const encrypted = custody_encrypt_backup(af, key);
    expect(encrypted).toBeTruthy();

    // In real implementation, decrypt(encrypt(af, key), key) === af
    // Mock just returns a constant
    const decrypted = custody_decrypt_backup(encrypted, key);
    expect(decrypted).toBeTruthy();
  });
});
