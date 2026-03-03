'use strict';

jest.mock('../../server/config', () => ({
  arweave: { gateway: 'https://arweave.net', appName: 'Yault' },
}));

jest.mock('../../server/db', () => ({
  ensureReady: jest.fn().mockResolvedValue(undefined),
  rwaReleaseRegistry: {
    findById: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock('arweave', () => ({
  __esModule: true,
  default: {
    init: () => ({
      createTransaction: jest.fn().mockResolvedValue({ id: 'mock-tx-id', addTag: jest.fn() }),
      transactions: {
        sign: jest.fn().mockResolvedValue(undefined),
        post: jest.fn().mockResolvedValue({ status: 200 }),
      },
    }),
  },
}));

const {
  manifestKey,
  registryKey,
  fetchFromArweave,
  uploadPayloadsAndManifest,
  getRegistryTxId,
  setRegistryTxId,
  getManifestTxIdFromRegistry,
} = require('../../server/services/arweaveReleaseStorage');
const db = require('../../server/db');

const originalFetch = global.fetch;

afterEach(() => {
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

describe('manifestKey', () => {
  test('returns deterministic 64-char hex for same inputs', () => {
    const key1 = manifestKey('wallet1', 'auth1', 0);
    const key2 = manifestKey('wallet1', 'auth1', 0);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different inputs produce different keys', () => {
    const a = manifestKey('wallet1', 'auth1', 0);
    const b = manifestKey('wallet1', 'auth1', 1);
    const c = manifestKey('wallet2', 'auth1', 0);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test('normalizes wallet_id to lowercase and trims', () => {
    const a = manifestKey('  WALLET1  ', 'auth1', 0);
    const b = manifestKey('wallet1', 'auth1', 0);
    expect(a).toBe(b);
  });

  test('handles null/undefined inputs gracefully', () => {
    const key = manifestKey(null, undefined, 0);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('registryKey', () => {
  test('returns deterministic 64-char hex', () => {
    const key1 = registryKey('wallet1', 'auth1');
    const key2 = registryKey('wallet1', 'auth1');
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different from manifestKey with same wallet/authority', () => {
    const rk = registryKey('wallet1', 'auth1');
    const mk = manifestKey('wallet1', 'auth1', 0);
    expect(rk).not.toBe(mk);
  });
});

describe('fetchFromArweave', () => {
  test('returns null for invalid tx ID format', async () => {
    expect(await fetchFromArweave(null)).toBeNull();
    expect(await fetchFromArweave('')).toBeNull();
    expect(await fetchFromArweave('too-short')).toBeNull();
    expect(await fetchFromArweave(123)).toBeNull();
  });

  test('returns null for non-43-char strings', async () => {
    expect(await fetchFromArweave('a'.repeat(42))).toBeNull();
    expect(await fetchFromArweave('a'.repeat(44))).toBeNull();
  });

  test('fetches valid tx ID and returns text', async () => {
    const validTxId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"data":"test"}'),
    });
    const result = await fetchFromArweave(validTxId);
    expect(result).toBe('{"data":"test"}');
    // Multi-gateway: races configured gateway + fallback gateways concurrently
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const calledUrls = global.fetch.mock.calls.map(c => c[0]);
    expect(calledUrls).toContain(`https://arweave.net/${validTxId}`);
  });

  test('returns null on HTTP error', async () => {
    const validTxId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchFromArweave(validTxId);
    expect(result).toBeNull();
  });

  test('returns null on network error', async () => {
    const validTxId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    const result = await fetchFromArweave(validTxId);
    expect(result).toBeNull();
  });

  test('passes abort signal for timeout', async () => {
    const validTxId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('ok'),
    });
    await fetchFromArweave(validTxId);
    const fetchOptions = global.fetch.mock.calls[0][1];
    expect(fetchOptions).toHaveProperty('signal');
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('getRegistryTxId', () => {
  test('returns DB value when present', async () => {
    db.rwaReleaseRegistry.findById.mockResolvedValue({ arweave_tx_id: 'db-tx-123' });
    const txId = await getRegistryTxId();
    expect(txId).toBe('db-tx-123');
  });

  test('falls back to env when DB has no value', async () => {
    db.rwaReleaseRegistry.findById.mockResolvedValue(null);
    const original = process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
    process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID = 'env-tx-456';
    try {
      const txId = await getRegistryTxId();
      expect(txId).toBe('env-tx-456');
    } finally {
      if (original === undefined) delete process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
      else process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID = original;
    }
  });

  test('returns null when neither DB nor env has value', async () => {
    db.rwaReleaseRegistry.findById.mockResolvedValue(null);
    const original = process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
    delete process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
    try {
      const txId = await getRegistryTxId();
      expect(txId).toBeNull();
    } finally {
      if (original !== undefined) process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID = original;
    }
  });
});

describe('setRegistryTxId', () => {
  test('persists tx id to DB', async () => {
    await setRegistryTxId('new-tx-789');
    expect(db.rwaReleaseRegistry.create).toHaveBeenCalledWith('default', { arweave_tx_id: 'new-tx-789' });
  });

  test('no-ops for null or non-string', async () => {
    await setRegistryTxId(null);
    await setRegistryTxId(undefined);
    await setRegistryTxId(123);
    expect(db.rwaReleaseRegistry.create).not.toHaveBeenCalled();
  });
});

describe('getManifestTxIdFromRegistry', () => {
  test('returns null when no registry tx id', async () => {
    db.rwaReleaseRegistry.findById.mockResolvedValue(null);
    const original = process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
    delete process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID;
    try {
      const result = await getManifestTxIdFromRegistry('w1', 'a1');
      expect(result).toBeNull();
    } finally {
      if (original !== undefined) process.env.RWA_RELEASE_REGISTRY_ARWEAVE_TX_ID = original;
    }
  });

  test('resolves manifest tx from registry on Arweave', async () => {
    const rKey = registryKey('w1', 'a1');
    const registryData = { [rKey]: 'manifest-tx-abc' };
    const registryTxId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';

    db.rwaReleaseRegistry.findById.mockResolvedValue({ arweave_tx_id: registryTxId });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(registryData)),
    });

    const result = await getManifestTxIdFromRegistry('w1', 'a1');
    expect(result).toBe('manifest-tx-abc');
  });

  test('returns null for unknown wallet/authority', async () => {
    const registryTxId = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';
    db.rwaReleaseRegistry.findById.mockResolvedValue({ arweave_tx_id: registryTxId });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ 'some-other-key': 'tx-999' })),
    });

    const result = await getManifestTxIdFromRegistry('unknown-wallet', 'unknown-auth');
    expect(result).toBeNull();
  });
});
