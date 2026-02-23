#!/usr/bin/env node
/**
 * Local test for Sepolia USDC balance query (without starting the full server)
 * Usage: NODE_ENV=development node scripts/test-usdc-balance.js <0xAddress>
 * Example: NODE_ENV=development node scripts/test-usdc-balance.js 0x00e1304043f99B88F89e7f7a742dc0D66a1de17a
 */
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const address = process.argv[2] || '0x0000000000000000000000000000000000000000';
if (!address.startsWith('0x') || address.length !== 42) {
  console.error('Please provide a valid EVM address, e.g.: 0x00e1304043f99B88F89e7f7a742dc0D66a1de17a');
  process.exit(1);
}

const path = require('path');
const projectRoot = path.resolve(__dirname, '..');
const chainProvider = require(path.join(projectRoot, 'server/services/chainProvider'));
const config = require(path.join(projectRoot, 'server/config'));

const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

(async () => {
  console.log('NODE_ENV=', process.env.NODE_ENV, 'config.useTestnet=', config.useTestnet);
  console.log('Query address:', address);
  console.log('---');

  try {
    const bal = await chainProvider.getEvmTokenBalance(
      'ethereum',
      address,
      SEPOLIA_USDC,
      6,
      10000,
      true
    );
    console.log('USDC (Sepolia) direct query:', bal);
  } catch (e) {
    console.error('USDC direct query failed:', e.message);
  }

  console.log('---');
  try {
    const multi = await chainProvider.getMultiChainBalances(
      { evmAddress: address },
      { useTestnet: true, includeTokens: true, chains: ['ethereum'], maxEvmChains: 1 }
    );
    console.log('getMultiChainBalances result:');
    console.log(JSON.stringify(multi, null, 2));
  } catch (e) {
    console.error('getMultiChainBalances failed:', e.message);
  }
})();
