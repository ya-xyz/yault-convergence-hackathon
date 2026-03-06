'use strict';

describe('chainProvider token balance edge cases', () => {
  const DUMMY_ADDR = '0x00e1304043f99b88f89e7f7a742dc0d66a1de17a';

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body || '{}');
      if (body.method === 'eth_getBalance') {
        return { ok: true, json: async () => ({ result: '0x0' }) };
      }
      if (body.method === 'eth_call') {
        return { ok: true, json: async () => ({ result: '0x' }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('getEvmTokenBalance treats eth_call 0x as zero', async () => {
    const { getEvmTokenBalance } = require('../../server/services/chainProvider');
    const out = await getEvmTokenBalance('ethereum', DUMMY_ADDR, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 6, 1000, true);
    expect(out.balance).toBe('0');
    expect(out.balanceRaw).toBe('0');
  });

  test('getMultiChainBalances does not query mainnet WBTC on Sepolia when testnet WBTC is null', async () => {
    const { getMultiChainBalances } = require('../../server/services/chainProvider');
    const out = await getMultiChainBalances(
      { evmAddress: DUMMY_ADDR },
      { includeTokens: true, chains: ['ethereum'], useTestnet: true, rpcTimeoutMs: 1000, overallTimeoutMs: 2000 }
    );

    expect(out.evm.some((r) => r.symbol === 'WBTC')).toBe(false);

    const rpcBodies = global.fetch.mock.calls
      .map(([, options]) => options && options.body)
      .filter(Boolean)
      .map((b) => JSON.parse(b));
    const calledWbtc = rpcBodies.some((b) =>
      b.method === 'eth_call' &&
      b.params &&
      b.params[0] &&
      String(b.params[0].to || '').toLowerCase() === '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'
    );
    expect(calledWbtc).toBe(false);
  });
});
