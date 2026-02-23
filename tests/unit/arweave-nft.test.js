/**
 * Arweave NFT unit tests
 *
 * Tests for Arweave NFT operations with mocked Arweave SDK.
 * Uses Jest with fetch mocking.
 */

// Mock Arweave SDK — create mocks inside factory (jest.mock is hoisted, so top-level const not yet in scope)
jest.mock('arweave', () => {
  const createTx = jest.fn();
  const signFn = jest.fn();
  const postFn = jest.fn();
  global.__arweaveMockCreateTransaction = createTx;
  global.__arweaveMockSign = signFn;
  global.__arweaveMockPost = postFn;
  return {
    __esModule: true,
    default: {
      init: () => ({
        createTransaction: createTx,
        transactions: { sign: signFn, post: postFn },
      }),
    },
  };
});

const mockCreateTransaction = () => global.__arweaveMockCreateTransaction;
const mockSign = () => global.__arweaveMockSign;
const mockPost = () => global.__arweaveMockPost;

// Mock fetch for GraphQL queries
const originalFetch = global.fetch;

import {
  uploadTriggerNFT,
  uploadRecoveryNFT,
  uploadReleaseRecord,
  fetchTriggerNFTs,
  fetchRecoveryNFTs,
  markNFTSuperseded,
  getLatestTriggerNFT,
} from '../../client/release/arweave-nft.js';

describe('uploadTriggerNFT', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTransaction().mockResolvedValue({
      id: 'tx_trigger_001',
      addTag: jest.fn(),
    });
    mockSign().mockResolvedValue(undefined);
    mockPost().mockResolvedValue({ status: 200 });
  });

  test('creates transaction with correct data', async () => {
    const result = await uploadTriggerNFT(
      'wallet_abc', 1, 'authority_xyz', 'ciphertext_base64', 12345678, {}
    );

    expect(result.txId).toBe('tx_trigger_001');
    expect(mockCreateTransaction()).toHaveBeenCalledTimes(1);

    const createArgs = mockCreateTransaction().mock.calls[0][0];
    const parsed = JSON.parse(createArgs.data);
    expect(parsed.type).toBe('YALLET_TRIGGER_NFT');
    expect(parsed.walletId).toBe('wallet_abc');
    expect(parsed.recipientIndex).toBe(1);
    expect(parsed.authorityId).toBe('authority_xyz');
    expect(parsed.tlockCiphertext).toBe('ciphertext_base64');
    expect(parsed.tlockRound).toBe(12345678);
  });

  test('adds correct tags', async () => {
    const mockTx = { id: 'tx_trigger_002', addTag: jest.fn() };
    mockCreateTransaction().mockResolvedValue(mockTx);

    await uploadTriggerNFT('wallet_abc', 2, 'authority_xyz', 'ct', 999, {});

    const tagCalls = mockTx.addTag.mock.calls;
    const tags = Object.fromEntries(tagCalls);

    expect(tags['Content-Type']).toBe('application/json');
    expect(tags['App-Name']).toBe('Yault');
    expect(tags['Type']).toBe('YALLET_TRIGGER_NFT');
    expect(tags['Wallet-Id']).toBe('wallet_abc');
    expect(tags['Recipient-Index']).toBe('2');
    expect(tags['Authority-Id']).toBe('authority_xyz');
    expect(tags['Tlock-Round']).toBe('999');
  });

  test('throws on missing required params', async () => {
    await expect(uploadTriggerNFT('', 1, 'lf', 'ct', 1, {})).rejects.toThrow();
    await expect(uploadTriggerNFT('w', 1, '', 'ct', 1, {})).rejects.toThrow();
    await expect(uploadTriggerNFT('w', 1, 'lf', '', 1, {})).rejects.toThrow();
  });

  test('throws on upload failure', async () => {
    mockPost().mockResolvedValue({ status: 500, statusText: 'Internal Error' });
    await expect(
      uploadTriggerNFT('wallet', 1, 'lf', 'ct', 1, {})
    ).rejects.toThrow(/failed/i);
  });
});

describe('uploadRecoveryNFT', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTransaction().mockResolvedValue({
      id: 'tx_recovery_001',
      addTag: jest.fn(),
    });
    mockSign().mockResolvedValue(undefined);
    mockPost().mockResolvedValue({ status: 200 });
  });

  test('creates Recovery NFT with correct data', async () => {
    const result = await uploadRecoveryNFT(
      'wallet_abc', 1, 'encrypted_af_hex', 'fingerprint_hex', {}
    );

    expect(result.txId).toBe('tx_recovery_001');
    const createArgs = mockCreateTransaction().mock.calls[0][0];
    const parsed = JSON.parse(createArgs.data);
    expect(parsed.type).toBe('YALLET_RECOVERY_NFT');
    expect(parsed.encryptedAdminFactor).toBe('encrypted_af_hex');
  });

  test('throws on missing walletId', async () => {
    await expect(
      uploadRecoveryNFT('', 1, 'ct', 'fp', {})
    ).rejects.toThrow();
  });
});

describe('uploadReleaseRecord', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTransaction().mockResolvedValue({
      id: 'tx_release_001',
      addTag: jest.fn(),
    });
    mockSign().mockResolvedValue(undefined);
    mockPost().mockResolvedValue({ status: 200 });
  });

  test('creates Release Record with correct data', async () => {
    const result = await uploadReleaseRecord(
      'wallet_abc', 1, 'authority_xyz', 'verified_event_confirmed',
      'evidence_hash_hex', 'sig_hex', {}
    );

    expect(result.txId).toBe('tx_release_001');
    const createArgs = mockCreateTransaction().mock.calls[0][0];
    const parsed = JSON.parse(createArgs.data);
    expect(parsed.type).toBe('YALLET_RELEASE_RECORD');
    expect(parsed.reason).toBe('verified_event_confirmed');
  });
});

describe('markNFTSuperseded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTransaction().mockResolvedValue({
      id: 'tx_supersede_001',
      addTag: jest.fn(),
    });
    mockSign().mockResolvedValue(undefined);
    mockPost().mockResolvedValue({ status: 200 });
  });

  test('creates supersede record linking old and new NFTs', async () => {
    const mockTx = { id: 'tx_supersede_001', addTag: jest.fn() };
    mockCreateTransaction().mockResolvedValue(mockTx);

    const result = await markNFTSuperseded('old_tx_id', 'new_tx_id', 'wallet_abc', {});
    expect(result.txId).toBe('tx_supersede_001');

    const tagCalls = mockTx.addTag.mock.calls;
    const tags = Object.fromEntries(tagCalls);
    expect(tags['Type']).toBe('YALLET_SUPERSEDE_RECORD');
    expect(tags['Superseded-Tx']).toBe('old_tx_id');
    expect(tags['Superseded-By']).toBe('new_tx_id');
  });

  test('throws on missing params', async () => {
    await expect(markNFTSuperseded('', 'new', 'w', {})).rejects.toThrow();
    await expect(markNFTSuperseded('old', '', 'w', {})).rejects.toThrow();
    await expect(markNFTSuperseded('old', 'new', '', {})).rejects.toThrow();
  });
});

describe('fetchTriggerNFTs', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('queries Arweave GraphQL and returns parsed results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          transactions: {
            edges: [
              {
                node: {
                  id: 'tx_001',
                  tags: [
                    { name: 'Type', value: 'YALLET_TRIGGER_NFT' },
                    { name: 'Wallet-Id', value: 'wallet_abc' },
                    { name: 'Tlock-Round', value: '12345' },
                  ],
                  block: { height: 100, timestamp: 1700000000 },
                },
              },
            ],
          },
        },
      }),
    });

    const results = await fetchTriggerNFTs('wallet_abc');
    expect(results).toHaveLength(1);
    expect(results[0].txId).toBe('tx_001');
    expect(results[0].tags['Tlock-Round']).toBe('12345');
  });

  test('throws on missing walletId', async () => {
    await expect(fetchTriggerNFTs('')).rejects.toThrow();
  });
});

describe('getLatestTriggerNFT', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns null when no trigger NFTs exist', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { transactions: { edges: [] } },
      }),
    });

    const result = await getLatestTriggerNFT('wallet_abc', 1);
    expect(result).toBeNull();
  });
});
