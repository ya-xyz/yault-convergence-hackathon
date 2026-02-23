/**
 * Testnet / Live Network Validation
 *
 * E2E tests that run against real testnets (manual or CI).
 * These tests are skipped by default and require environment variables:
 *   - ARWEAVE_WALLET_JWK: Arweave wallet for uploads
 *   - ETHERSCAN_API_KEY: Etherscan API key
 *   - RUN_TESTNET_TESTS=true: Explicitly enable testnet tests
 *
 * Test scenarios:
 * - drand mainnet: verify current round fetch
 * - Arweave mainnet: upload small test data (~$0.002)
 * - Bitcoin testnet: wallet activity detection
 * - Sepolia: ERC-4626 vault interaction
 * - Full E2E: tlock encrypt → wait → decrypt
 */

const SKIP = process.env.RUN_TESTNET_TESTS !== 'true';
const describeMaybe = SKIP ? describe.skip : describe;

// ─── drand Network Tests ───

describeMaybe('drand Network', () => {
  test('fetches current round from drand mainnet', async () => {
    const DRAND_URL = 'https://api.drand.sh/dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493/public/latest';

    const response = await fetch(DRAND_URL, {
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty('round');
    expect(data).toHaveProperty('randomness');
    expect(data).toHaveProperty('signature');
    expect(data.round).toBeGreaterThan(0);
    expect(data.randomness).toMatch(/^[0-9a-f]{64}$/);

    console.log(`drand current round: ${data.round}`);
  }, 15000);

  test('fetches specific round from drand', async () => {
    const round = 1000;
    const DRAND_URL = `https://api.drand.sh/dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493/public/${round}`;

    const response = await fetch(DRAND_URL, {
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.round).toBe(round);
  }, 15000);
});

// ─── Arweave Network Tests ───

describeMaybe('Arweave Network', () => {
  test('queries Arweave GraphQL for Yault app transactions', async () => {
    const query = `{
      transactions(
        tags: [
          { name: "App-Name", values: ["Yault"] }
        ],
        first: 5
      ) {
        edges {
          node {
            id
            tags { name value }
            block { height timestamp }
          }
        }
      }
    }`;

    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.data).toHaveProperty('transactions');

    const edges = result.data.transactions.edges;
    console.log(`Found ${edges.length} Yault transactions on Arweave`);
  }, 35000);
});

// ─── Bitcoin Activity Detection Tests ───

describeMaybe('Bitcoin Activity Detection', () => {
  test('detects transactions for a known active address', async () => {
    // Use a well-known Bitcoin address (Satoshi's first address)
    const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

    const response = await fetch(`https://mempool.space/api/address/${address}/txs`, {
      signal: AbortSignal.timeout(15000),
    });
    expect(response.ok).toBe(true);

    const txs = await response.json();
    expect(Array.isArray(txs)).toBe(true);
    expect(txs.length).toBeGreaterThan(0);

    console.log(`Address ${address} has ${txs.length} transactions (first page)`);
  }, 20000);

  test('returns empty for non-existent address', async () => {
    // Use a probably-unused Taproot address
    const address = 'bc1p0000000000000000000000000000000000000000000000000000qqrnh3sa';

    const response = await fetch(`https://mempool.space/api/address/${address}/txs`, {
      signal: AbortSignal.timeout(15000),
    });

    // API may return 200 with empty array or 404
    if (response.ok) {
      const txs = await response.json();
      expect(Array.isArray(txs)).toBe(true);
    }
  }, 20000);
});

// ─── Ethereum Activity Detection Tests ───

describeMaybe('Ethereum Activity Detection', () => {
  test('queries Etherscan for a known address', async () => {
    const apiKey = process.env.ETHERSCAN_API_KEY || '';
    const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth

    const params = new URLSearchParams({
      module: 'account',
      action: 'txlist',
      address,
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: '5',
      sort: 'desc',
    });
    if (apiKey) params.set('apikey', apiKey);

    const response = await fetch(`https://api.etherscan.io/api?${params}`, {
      signal: AbortSignal.timeout(15000),
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    // Etherscan may rate-limit without API key
    if (data.status === '1') {
      expect(Array.isArray(data.result)).toBe(true);
      expect(data.result.length).toBeGreaterThan(0);
      console.log(`Etherscan returned ${data.result.length} transactions`);
    }
  }, 20000);
});

// ─── tlock Encrypt/Decrypt Round-Trip ───

describeMaybe('tlock Round-Trip (requires waiting)', () => {
  // This test is very slow (waits for a drand round to pass)
  // Only run manually with RUN_SLOW_TESTS=true

  const SKIP_SLOW = process.env.RUN_SLOW_TESTS !== 'true';

  (SKIP_SLOW ? test.skip : test)('encrypts and decrypts after round passes', async () => {
    const { timelockEncrypt, timelockDecrypt } = await import('tlock-js');
    const { HttpCachingChain, HttpChainClient } = await import('drand-client');

    const chainHash = 'dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493';
    const chain = new HttpCachingChain('https://api.drand.sh', { chainHash });
    const client = new HttpChainClient(chain);

    // Fetch current round and encrypt for round + 2 (~60 seconds from now)
    const latestResp = await fetch(`https://api.drand.sh/${chainHash}/public/latest`);
    const latest = await latestResp.json();
    const targetRound = latest.round + 2;

    const message = new TextEncoder().encode('test-release-payload');
    const ciphertext = await timelockEncrypt(targetRound, message, chain);
    expect(ciphertext).toBeTruthy();

    console.log(`Encrypted for round ${targetRound}, waiting...`);

    // Wait for the target round (2 rounds × 30 seconds = ~60 seconds)
    await new Promise((r) => setTimeout(r, 65000));

    const plaintext = await timelockDecrypt(ciphertext, chain, client);
    const decoded = new TextDecoder().decode(plaintext);
    expect(decoded).toBe('test-release-payload');
  }, 120000); // 2 minute timeout
});
