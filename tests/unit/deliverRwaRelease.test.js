'use strict';

jest.mock('../../server/config', () => ({
  rwa: { uploadAndMintApiUrl: 'https://mock-api.example.com/upload-and-mint' },
}));

jest.mock('../../server/db', () => ({
  rwaDeliveryLog: {
    findById: jest.fn(),
    create: jest.fn(),
    findPending: jest.fn(),
  },
  bindings: {
    findByWallet: jest.fn(),
  },
}));

jest.mock('../../server/services/arweaveReleaseStorage', () => ({
  manifestKey: jest.fn((_w, _a, idx) => `mock-key-${idx}`),
  fetchFromArweave: jest.fn(),
  getManifestTxIdFromRegistry: jest.fn(),
}));

const db = require('../../server/db');
const {
  manifestKey,
  fetchFromArweave,
  getManifestTxIdFromRegistry,
} = require('../../server/services/arweaveReleaseStorage');
const {
  deliverRwaPackageForRecipient,
  deliverByRegistry,
  retryPendingDeliveries,
} = require('../../server/services/deliverRwaRelease');

const originalFetch = global.fetch;

afterEach(() => {
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

describe('deliverRwaPackageForRecipient', () => {
  const binding = {
    wallet_id: 'wallet1',
    authority_id: 'auth1',
    manifest_arweave_tx_id: 'manifest-tx-abc',
  };

  test('skips delivery if already delivered (idempotent)', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue({ status: 'delivered', txId: 'existing-sig' });

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(true);
    expect(result.txId).toBe('existing-sig');
    // Should not have called the upload-and-mint API (fetch not replaced with mock)
    expect(fetchFromArweave).not.toHaveBeenCalled();
  });

  test('delivers via Arweave manifest path', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    manifestKey.mockReturnValue('mock-key-0');

    // Manifest fetch
    fetchFromArweave
      .mockResolvedValueOnce(JSON.stringify({ 'mock-key-0': 'payload-tx-123' })) // manifest
      .mockResolvedValueOnce(JSON.stringify({ data: 'test', leafOwner: 'sol-addr' })); // payload

    // Upload-and-mint API
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ mint: { signature: 'tx-sig-999' } }),
    });

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(true);
    expect(result.txId).toBe('tx-sig-999');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(db.rwaDeliveryLog.create).toHaveBeenCalled();
  });

  test('records failure when manifest fetch fails', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    fetchFromArweave.mockResolvedValue(null);

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('Failed to fetch manifest from Arweave');
    expect(db.rwaDeliveryLog.create).toHaveBeenCalled();
  });

  test('records failure when manifest is invalid JSON', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    fetchFromArweave.mockResolvedValue('not-json');

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('Invalid manifest from Arweave');
  });

  test('records failure when payload key not in manifest', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    manifestKey.mockReturnValue('mock-key-0');
    fetchFromArweave.mockResolvedValue(JSON.stringify({ 'different-key': 'tx-id' }));

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('No payload tx for this recipient in manifest');
  });

  test('delivers via legacy encrypted_packages path', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);

    const legacyBinding = {
      wallet_id: 'wallet1',
      authority_id: 'auth1',
      manifest_arweave_tx_id: null,
      encrypted_packages: [
        { index: 0, rwa_upload_body: { data: 'encrypted', leafOwner: 'sol-addr' } },
      ],
    };
    getManifestTxIdFromRegistry.mockResolvedValue(null);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ mint: { signature: 'legacy-sig' } }),
    });

    const result = await deliverRwaPackageForRecipient(legacyBinding, 0);
    expect(result.delivered).toBe(true);
    expect(result.txId).toBe('legacy-sig');
  });

  test('returns error when legacy package has no rwa_upload_body', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);

    const legacyBinding = {
      wallet_id: 'wallet1',
      authority_id: 'auth1',
      manifest_arweave_tx_id: null,
      encrypted_packages: [
        { index: 0, package_hex: 'aabbcc' },
      ],
    };
    getManifestTxIdFromRegistry.mockResolvedValue(null);

    const result = await deliverRwaPackageForRecipient(legacyBinding, 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/no rwa_upload_body/i);
  });

  test('records failure when upload-and-mint API returns error', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    manifestKey.mockReturnValue('mock-key-0');

    fetchFromArweave
      .mockResolvedValueOnce(JSON.stringify({ 'mock-key-0': 'payload-tx-123' }))
      .mockResolvedValueOnce(JSON.stringify({ data: 'test', leafOwner: 'addr' }));

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'invalid data' }),
    });

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('invalid data');
    expect(db.rwaDeliveryLog.create).toHaveBeenCalled();
  });

  test('records failure on network exception', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    manifestKey.mockReturnValue('mock-key-0');

    fetchFromArweave
      .mockResolvedValueOnce(JSON.stringify({ 'mock-key-0': 'payload-tx-123' }))
      .mockResolvedValueOnce(JSON.stringify({ data: 'test', leafOwner: 'addr' }));

    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  test('attempts Arweave registry recovery when binding has no manifest tx', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue(null);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);

    const noManifestBinding = {
      wallet_id: 'wallet1',
      authority_id: 'auth1',
      manifest_arweave_tx_id: null,
      encrypted_packages: null,
    };

    getManifestTxIdFromRegistry.mockResolvedValue('recovered-manifest-tx');
    manifestKey.mockReturnValue('mock-key-0');

    fetchFromArweave
      .mockResolvedValueOnce(JSON.stringify({ 'mock-key-0': 'payload-tx' }))
      .mockResolvedValueOnce(JSON.stringify({ data: 'recovered', leafOwner: 'addr' }));

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ mint: { signature: 'recovered-sig' } }),
    });

    const result = await deliverRwaPackageForRecipient(noManifestBinding, 0);
    expect(result.delivered).toBe(true);
    expect(getManifestTxIdFromRegistry).toHaveBeenCalledWith('wallet1', 'auth1');
  });

  test('marks status as failed after MAX_RETRY_ATTEMPTS', async () => {
    db.rwaDeliveryLog.findById.mockResolvedValue({ attempts: 4, status: 'pending' }); // 4 existing + 1 new = 5
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);
    fetchFromArweave.mockResolvedValue(null);

    const result = await deliverRwaPackageForRecipient(binding, 0);
    expect(result.delivered).toBe(false);

    const createCall = db.rwaDeliveryLog.create.mock.calls[0];
    const record = createCall[1];
    expect(record.status).toBe('failed');
    expect(record.attempts).toBe(5);
  });
});

describe('deliverByRegistry', () => {
  test('returns error when no manifest in registry', async () => {
    getManifestTxIdFromRegistry.mockResolvedValue(null);

    const result = await deliverByRegistry('w1', 'a1', 0);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/No manifest in registry/);
  });

  test('delegates to deliverRwaPackageForRecipient when manifest found', async () => {
    getManifestTxIdFromRegistry.mockResolvedValue('reg-manifest-tx');
    db.rwaDeliveryLog.findById.mockResolvedValue({ status: 'delivered', txId: 'prev-sig' });

    const result = await deliverByRegistry('w1', 'a1', 0);
    expect(result.delivered).toBe(true);
    expect(result.txId).toBe('prev-sig');
  });
});

describe('retryPendingDeliveries', () => {
  test('returns zeros when no pending entries', async () => {
    db.rwaDeliveryLog.findPending.mockResolvedValue([]);

    const result = await retryPendingDeliveries();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  test('marks entry as permanently failed when max attempts reached', async () => {
    db.rwaDeliveryLog.findPending.mockResolvedValue([
      { wallet_id: 'w1', authority_id: 'a1', recipient_index: 0, attempts: 5, status: 'pending' },
    ]);
    db.rwaDeliveryLog.create.mockResolvedValue(undefined);

    const result = await retryPendingDeliveries();
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);

    const createCall = db.rwaDeliveryLog.create.mock.calls[0];
    expect(createCall[1].status).toBe('failed');
  });

  test('fails when no matching binding found', async () => {
    db.rwaDeliveryLog.findPending.mockResolvedValue([
      { wallet_id: 'w1', authority_id: 'a1', recipient_index: 0, attempts: 1, status: 'pending' },
    ]);
    db.bindings.findByWallet.mockResolvedValue([]);

    const result = await retryPendingDeliveries();
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
  });

  test('retries delivery for pending entry with matching binding', async () => {
    db.rwaDeliveryLog.findPending.mockResolvedValue([
      { wallet_id: 'w1', authority_id: 'a1', recipient_index: 0, attempts: 1, status: 'pending' },
    ]);
    db.bindings.findByWallet.mockResolvedValue([
      { wallet_id: 'w1', authority_id: 'a1', status: 'active', manifest_arweave_tx_id: 'mtx' },
    ]);
    // deliverRwaPackageForRecipient will be called — mock its dependencies
    db.rwaDeliveryLog.findById.mockResolvedValue({ status: 'delivered', txId: 'retry-sig' });

    const result = await retryPendingDeliveries();
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
  });
});
