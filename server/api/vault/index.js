/**
 * server/api/vault/index.js — Vault API
 *
 * When VAULT_ADDRESS is set in config:
 *   GET  /balance/:address  → Read vault shares/assets from chain
 *   POST /deposit, /redeem, /harvest → Return transaction payload for client to sign and send
 * Deploy to mainnet: set VAULT_ADDRESS and EVM_RPC_URL to mainnet contract and RPC.
 *
 * When VAULT_ADDRESS is not set: stub behaviour (DB only).
 * When set: interact with YaultVault (ERC-4626) on-chain.
 * C-01/C-03: Auth required; positions in db.vaultPositions.
 *
 * C-01: All endpoints require wallet authentication.
 * Multi-chain: GET /balances/:address queries all supported chains in parallel.
 */

'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const { dualAuthMiddleware } = require('../../middleware/auth');
const db = require('../../db');
const config = require('../../config');
const { getMultiChainBalances } = require('../../services/chainProvider');
const { getEVMChains } = require('../../config/chains');
const vaultContract = require('../../services/vaultContract');
const escrowContract = require('../../services/escrowContract');

const router = Router();

const hasVaultContract = () => !!(config.contracts && config.contracts.vaultAddress);

// ─── Helpers ───

/** Validate that a string looks like a hex address (40 or 64 hex chars). */
function isValidAddress(addr) {
  return typeof addr === 'string' && /^[0-9a-fA-F]{40,64}$/.test(addr.replace(/^0x/i, ''));
}

/** Normalize address to lowercase without 0x prefix. */
function normalizeAddr(addr) {
  return addr.replace(/^0x/i, '').toLowerCase();
}

// ─── GET /balance/:address ───

router.get('/balance/:address', dualAuthMiddleware, async (req, res) => {
  const rawAddr = req.params.address;
  if (!isValidAddress(rawAddr)) {
    return res.status(400).json({ error: 'Invalid address format' });
  }
  const address = normalizeAddr(rawAddr);

  // C-01 FIX: Verify caller owns this address
  if (req.auth.pubkey !== address) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only view your own vault balance',
    });
  }

  const evmAddress = '0x' + address;
  let vaultData = { shares: '0.00', value: '0.00', yield: '0.00', source: 'db' };

  if (hasVaultContract()) {
    const onChain = await vaultContract.getVaultBalance(config, evmAddress);
    if (onChain) {
      const principal = parseFloat(onChain.principal) || 0;
      const value = parseFloat(onChain.assets) || 0;
      const yieldAmount = Math.max(0, value - principal);
      vaultData = {
        shares: onChain.shares,
        value: onChain.assets,
        yield: yieldAmount.toFixed(4),
        principal: onChain.principal,
        source: 'chain',
      };
    }
  }

  if (vaultData.source === 'db') {
    const pos = await db.vaultPositions.findById(address) || { shares: 0, deposited: 0 };
    vaultData = {
      shares: (pos.shares || 0).toFixed(4),
      value: (pos.deposited || 0).toFixed(4),
      yield: ((pos.deposited || 0) * 0.05).toFixed(4),
      source: 'db',
    };
  }

  // Wallet on-chain balances: query when we have at least EVM address (optional btc/sol from query).
  const useTestnet = !!config.useTestnet;
  if (process.env.NODE_ENV === 'development') {
    console.log('[vault/balance] useTestnet=', useTestnet, 'evmAddress=', evmAddress);
  }
  const bitcoinAddress = req.query.btc_address && String(req.query.btc_address).trim() ? String(req.query.btc_address).trim() : null;
  const solanaAddress = req.query.sol_address && String(req.query.sol_address).trim() ? String(req.query.sol_address).trim() : null;
  let walletData = { eth: '0.00', sol: '0.00', btc: '0.00', usdcEthereum: '0.00', usdcSolana: '0.00', wethEthereum: '0.00' };
  try {
    const balances = await getMultiChainBalances(
      { evmAddress, bitcoinAddress, solanaAddress },
      { useTestnet, includeTokens: true, chains: ['ethereum'], maxEvmChains: 1 }
    );
    const ethRow = balances.evm && balances.evm.find((r) => r.chain === 'ethereum' && r.symbol !== 'USDC' && r.symbol !== 'WETH');
    walletData.eth = ethRow && typeof ethRow.balance === 'string' ? ethRow.balance : '0.00';
    const usdcEth = balances.evm && balances.evm.find((r) => r.chain === 'ethereum' && r.symbol === 'USDC');
    walletData.usdcEthereum = usdcEth && typeof usdcEth.balance === 'string' ? usdcEth.balance : '0.00';
    const wethEth = balances.evm && balances.evm.find((r) => r.chain === 'ethereum' && r.symbol === 'WETH');
    walletData.wethEthereum = wethEth && typeof wethEth.balance === 'string' ? wethEth.balance : '0.00';
    if (process.env.NODE_ENV === 'development' && usdcEth) {
      console.log('[vault/balance] USDC result:', usdcEth.balance, usdcEth.error ? 'error=' + usdcEth.error : '');
    }
    if (process.env.NODE_ENV === 'development' && wethEth) {
      console.log('[vault/balance] WETH result:', wethEth.balance, wethEth.error ? 'error=' + wethEth.error : '');
    }
    walletData.sol = balances.solana && typeof balances.solana.balance === 'string' ? balances.solana.balance : '0.00';
    walletData.btc = balances.bitcoin && typeof balances.bitcoin.balance === 'string' ? balances.bitcoin.balance : '0.00';
  } catch (err) {
    console.warn('[vault/balance] Wallet balance query failed (non-fatal):', err.message);
  }

  // Query escrow balance (vault shares locked in VaultShareEscrow for this wallet)
  let escrowData = { shares: '0', value: '0', recipient_indices: [] };
  const escrowAddr = (config.escrow?.address || '').trim();
  if (escrowAddr && hasVaultContract()) {
    try {
      const { ethers } = require('ethers');
      const wHash = escrowContract.walletIdHash(evmAddress);
      const ctx = escrowContract.getEscrowReadOnly(config);
      if (ctx) {
        const deposited = await ctx.escrow.totalDeposited(wHash);
        if (deposited > 0n) {
          const decimals = config?.contracts?.underlyingDecimals ?? 18;
          const rpc = config?.escrow?.rpcUrl || config?.contracts?.evmRpcUrl || '';
          const provider = new ethers.JsonRpcProvider(rpc);
          const vaultAddr = config.contracts.vaultAddress;
          const vault = new ethers.Contract(vaultAddr, ['function convertToAssets(uint256) view returns (uint256)'], provider);
          const assets = await vault.convertToAssets(deposited);
          escrowData = {
            shares: ethers.formatUnits(deposited, decimals),
            value: ethers.formatUnits(assets, decimals),
            recipient_indices: [],
          };
          // Look up recipient indices: try active binding first, then scan on-chain as fallback
          try {
            let found = false;
            // 1. Try DB binding lookup (both lowercase and checksummed wallet_id)
            let walletBindings = await db.bindings.findByWallet(evmAddress);
            if (walletBindings.length === 0) {
              try {
                const checksummed = ethers.getAddress(evmAddress);
                if (checksummed !== evmAddress) {
                  walletBindings = await db.bindings.findByWallet(checksummed);
                }
              } catch (_) {}
            }
            const activeBinding = walletBindings.find((b) => b.status === 'active');
            if (activeBinding && Array.isArray(activeBinding.recipient_indices)) {
              escrowData.recipient_indices = activeBinding.recipient_indices.map(Number);
              found = true;
            }
            // 2. Fallback: scan on-chain for indices with non-zero allocatedShares (probe 1..10)
            if (!found) {
              const indices = [];
              const probes = await Promise.all(
                Array.from({ length: 10 }, (_, i) => i + 1).map(async (idx) => {
                  try {
                    const alloc = await ctx.escrow.allocatedShares(wHash, idx);
                    return { idx, alloc };
                  } catch (_) { return { idx, alloc: 0n }; }
                })
              );
              for (const p of probes) {
                if (p.alloc > 0n) indices.push(p.idx);
              }
              escrowData.recipient_indices = indices;
            }
          } catch (bindErr) {
            console.warn('[vault/balance] Binding/scan lookup failed (non-fatal):', bindErr.message);
          }
        }
      }
    } catch (err) {
      console.warn('[vault/balance] Escrow query failed (non-fatal):', err.message);
    }
  }

  const underlyingSymbol = config?.contracts?.underlyingSymbol || 'USDC';
  res.json({
    address,
    wallet: walletData,
    vault: { ...vaultData, underlying_symbol: underlyingSymbol },
    escrow: escrowData,
  });
});

// ─── GET /balances/:address — Multi-chain balance query ───

router.get('/balances/:address', dualAuthMiddleware, async (req, res) => {
  const rawAddr = req.params.address;
  if (!isValidAddress(rawAddr)) {
    return res.status(400).json({ error: 'Invalid address format' });
  }
  const address = normalizeAddr(rawAddr);

  // C-01 FIX: Verify caller owns this address
  if (req.auth.pubkey !== address) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only view your own balances',
    });
  }

  // Query parameters: btc_address, sol_address, tokens; chains (e.g. ethereum,arbitrum,base), max_evm_chains (cap for faster response)
  const evmAddress = '0x' + address;
  const bitcoinAddress = req.query.btc_address || null;
  const solanaAddress = req.query.sol_address || null;

  const chainsParam = req.query.chains;
  const chains = chainsParam ? chainsParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const maxEvmChains = req.query.max_evm_chains ? parseInt(req.query.max_evm_chains, 10) : null;

  try {
    const balances = await getMultiChainBalances(
      { evmAddress, bitcoinAddress, solanaAddress },
      {
        includeTokens: req.query.tokens !== 'false',
        chains: chains && chains.length > 0 ? chains : undefined,
        maxEvmChains: Number.isFinite(maxEvmChains) && maxEvmChains > 0 ? maxEvmChains : undefined,
      }
    );

    // Also include vault position
    const pos = await db.vaultPositions.findById(address) || { shares: 0, deposited: 0 };

    res.json({
      address,
      multichain: balances,
      saving: {
        shares: (pos.shares || 0).toFixed(4),
        value: (pos.deposited || 0).toFixed(4),
        yield: ((pos.deposited || 0) * 0.05).toFixed(4),
      },
      supported_chains: getEVMChains().map((c) => ({
        key: c.key,
        name: c.name,
        chainId: c.chainId,
      })).concat([
        { key: 'bitcoin', name: 'Bitcoin' },
        { key: 'solana', name: 'Solana' },
      ]),
    });
  } catch (err) {
    console.error('[vault/balances] Multi-chain query failed:', err.message);
    res.status(500).json({ error: 'Failed to query chain balances' });
  }
});

// ─── POST /deposit ───

router.post('/deposit', dualAuthMiddleware, async (req, res) => {
  const { address, amount, asset } = req.body || {};
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Valid address is required' });
  }
  if (!amount) {
    return res.status(400).json({ error: 'amount is required' });
  }

  const normalizedAddr = normalizeAddr(address);

  // C-01 FIX: Verify caller owns this address
  if (req.auth.pubkey !== normalizedAddr) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only deposit into your own vault',
    });
  }

  // 'max' not implemented: would require wallet balance lookup; avoid silently depositing 0
  if (amount === 'max') {
    return res.status(400).json({
      error: 'Amount "max" is not supported',
      detail: 'Please specify a numeric amount. Max-deposit may be added in a future release.',
    });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  if (hasVaultContract()) {
    const receiver = normalizedAddr.startsWith('0x') ? normalizedAddr : '0x' + normalizedAddr;
    const tx = await vaultContract.buildDepositTx(config, String(numAmount), receiver);
    const assetAddress = await vaultContract.getAssetAddress(config);
    if (tx) {
      const underlyingDecimals = config?.contracts?.underlyingDecimals ?? 6;
      return res.json({
        status: 'pending_signature',
        address: normalizedAddr,
        amount: numAmount.toFixed(4),
        transaction: tx,
        asset_address: assetAddress || undefined,
        underlying_decimals: underlyingDecimals,
        message: 'Sign and send this transaction in your wallet. Approve the underlying asset for the vault first if needed.',
      });
    }
  }

  // Fallback: stub (DB only)
  const pos = await db.vaultPositions.findById(normalizedAddr) || { shares: 0, deposited: 0 };
  pos.shares = (pos.shares || 0) + numAmount;
  pos.deposited = (pos.deposited || 0) + numAmount;
  pos.updated_at = Date.now();
  await db.vaultPositions.create(normalizedAddr, pos);

  res.json({
    status: 'deposited',
    address: normalizedAddr,
    amount: numAmount.toFixed(4),
    asset: asset || 'ETH',
    shares_received: numAmount.toFixed(4),
    message: 'Stub: deposit recorded (no VAULT_ADDRESS). Set VAULT_ADDRESS in config for on-chain deposit.',
  });
});

// ─── POST /redeem ───

router.post('/redeem', dualAuthMiddleware, async (req, res) => {
  const { address, shares } = req.body || {};
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Valid address is required' });
  }
  if (!shares) {
    return res.status(400).json({ error: 'shares is required' });
  }

  const normalizedAddr = normalizeAddr(address);

  // C-01 FIX: Verify caller owns this address
  if (req.auth.pubkey !== normalizedAddr) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only redeem from your own vault',
    });
  }

  const pos = await db.vaultPositions.findById(normalizedAddr) || { shares: 0, deposited: 0 };
  let numShares = shares === 'max' ? (pos.shares || 0) : parseFloat(shares);

  // When on-chain vault exists and shares === 'max', prefer on-chain balance
  // (local DB may be out of sync with direct on-chain deposits/harvests)
  if (shares === 'max' && hasVaultContract()) {
    const onChain = await vaultContract.getVaultBalance(config, normalizedAddr);
    if (onChain && parseFloat(onChain.shares) > 0) {
      numShares = parseFloat(onChain.shares);
    }
  }

  if (shares !== 'max' && (isNaN(numShares) || numShares <= 0)) {
    return res.status(400).json({ error: 'shares must be a positive number or "max"' });
  }
  if (numShares <= 0) {
    return res.status(400).json({ error: 'No shares available to redeem' });
  }

  if (hasVaultContract()) {
    const tx = await vaultContract.buildRedeemTx(config, String(numShares), normalizedAddr, normalizedAddr);
    if (tx) {
      return res.json({
        status: 'pending_signature',
        address: normalizedAddr,
        shares: numShares.toFixed(4),
        transaction: tx,
        message: 'Sign and send this transaction in your wallet to redeem vault shares.',
      });
    }
  }

  if (numShares > (pos.shares || 0)) {
    return res.status(400).json({ error: 'Insufficient shares' });
  }

  const ratio = pos.shares > 0 ? numShares / pos.shares : 0;
  const assetsReturned = (pos.deposited || 0) * ratio;
  pos.shares = (pos.shares || 0) - numShares;
  pos.deposited = (pos.deposited || 0) - assetsReturned;
  pos.updated_at = Date.now();
  await db.vaultPositions.create(normalizedAddr, pos);

  try {
    const redeemId = crypto.randomBytes(16).toString('hex');
    await db.allowances.create(redeemId, {
      allowance_id: redeemId,
      from_wallet_id: address,
      to_wallet_id: address,
      amount: assetsReturned.toFixed(4),
      currency: 'ETH',
      type: 'vault_redeem',
      memo: 'Vault redeem to checking',
      status: 'completed',
      created_at: Date.now(),
    });
  } catch { /* non-fatal */ }

  res.json({
    status: 'redeemed',
    address: normalizedAddr,
    shares_redeemed: numShares.toFixed(4),
    assets_returned: assetsReturned.toFixed(4),
    message: 'Stub: redeem recorded (no VAULT_ADDRESS).',
  });
});

// ─── POST /harvest ───

router.post('/harvest', dualAuthMiddleware, async (req, res) => {
  const { address } = req.body || {};
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Valid address is required' });
  }

  const normalizedAddr = normalizeAddr(address);

  // C-01 FIX: Verify caller owns this address
  if (req.auth.pubkey !== normalizedAddr) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only harvest from your own vault',
    });
  }

  if (hasVaultContract()) {
    const tx = await vaultContract.buildHarvestTx(config);
    if (tx) {
      return res.json({
        status: 'pending_signature',
        address: normalizedAddr,
        transaction: tx,
        message: 'Sign and send this transaction in your wallet to harvest yield.',
      });
    }
  }

  const pos = await db.vaultPositions.findById(normalizedAddr) || { shares: 0, deposited: 0 };
  const grossYield = (pos.deposited || 0) * 0.05;
  const userYield = grossYield * 0.80;

  res.json({
    status: 'harvested',
    address: normalizedAddr,
    gross_yield: grossYield.toFixed(4),
    harvested: userYield.toFixed(4),
    platform_fee: (grossYield * 0.15).toFixed(4),
    authority_fee: (grossYield * 0.05).toFixed(4),
    message: 'Stub: yield harvested (no VAULT_ADDRESS). In production: YaultVault.harvest().',
  });
});

// ─── POST /transfer (internal vault share transfer for allowances) ───

router.post('/transfer', dualAuthMiddleware, async (req, res) => {
  const { from_address, to_address, amount, currency } = req.body || {};
  if (!from_address || !to_address || !amount) {
    return res.status(400).json({ error: 'from_address, to_address, and amount are required' });
  }
  const normalizedFrom = normalizeAddr(from_address);
  const normalizedTo = normalizeAddr(to_address);
  if (!isValidAddress(from_address) || !isValidAddress(to_address)) {
    return res.status(400).json({ error: 'Invalid address format' });
  }

  // Verify caller is the sender (use normalized address for comparison)
  if (req.auth.pubkey !== normalizedFrom) {
    return res.status(403).json({ error: 'Cannot transfer from a different address' });
  }

  // Security: to_address must be a sub-account of from_address (parent->member transfer)
  const members = await db.subAccounts.findByParent(normalizedFrom);
  const isMember = members.some(
    (m) => (m.member_wallet_id || '').replace(/^0x/i, '').toLowerCase() === normalizedTo && m.status === 'active'
  );
  if (!isMember) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only transfer to an active sub-account member of your wallet',
    });
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const fromPos = await db.vaultPositions.findById(normalizedFrom) || { shares: 0, deposited: 0 };

  if (numAmount > (fromPos.deposited || 0)) {
    return res.status(400).json({
      error: 'Insufficient vault balance',
      available: (fromPos.deposited || 0).toFixed(4),
      requested: numAmount.toFixed(4),
    });
  }

  // Enforce withdrawal limit on the recipient (sub-account receiving funds)
  const { checkLimit } = require('../../services/withdrawalLimits');
  const limitCheck = await checkLimit(normalizedTo, numAmount);
  if (!limitCheck.allowed) {
    return res.status(400).json({
      error: 'Withdrawal limit exceeded for recipient',
      detail: `This transfer would exceed the ${limitCheck.period} limit of ${limitCheck.limit} for the recipient`,
      used: limitCheck.used,
      remaining: limitCheck.remaining,
      limit: limitCheck.limit,
      period: limitCheck.period,
    });
  }

  // Move shares from parent to member (proportional principal transfer)
  const shareRatio = (fromPos.shares || 0) > 0 ? numAmount / fromPos.deposited : 0;
  const sharesToMove = (fromPos.shares || 0) * shareRatio;

  fromPos.shares = (fromPos.shares || 0) - sharesToMove;
  fromPos.deposited = (fromPos.deposited || 0) - numAmount;
  fromPos.updated_at = Date.now();
  await db.vaultPositions.create(normalizedFrom, fromPos);

  const toPos = await db.vaultPositions.findById(normalizedTo) || { shares: 0, deposited: 0 };
  toPos.shares = (toPos.shares || 0) + sharesToMove;
  toPos.deposited = (toPos.deposited || 0) + numAmount;
  toPos.updated_at = Date.now();
  await db.vaultPositions.create(normalizedTo, toPos);

  const transferMessage = hasVaultContract()
    ? 'Recorded in platform DB. YaultVault disables on-chain share transfer; internal allocation only.'
    : 'Recorded in platform DB (no VAULT_ADDRESS).';

  res.json({
    status: 'transferred',
    from: normalizedFrom,
    to: normalizedTo,
    amount: numAmount.toFixed(4),
    currency: currency || 'ETH',
    shares_moved: sharesToMove.toFixed(4),
    from_remaining: fromPos.deposited.toFixed(4),
    message: transferMessage,
  });
});

// ─── POST /simulate-yield (dev/demo: inject WETH into vault to simulate yield) ───

router.post('/simulate-yield', dualAuthMiddleware, async (req, res) => {
  const { address, amount } = req.body || {};
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Valid address is required' });
  }

  const normalizedAddr = normalizeAddr(address);
  if (req.auth.pubkey !== normalizedAddr) {
    return res.status(403).json({ error: 'Forbidden', detail: 'You can only simulate yield for your own vault' });
  }

  if (!hasVaultContract()) {
    return res.status(400).json({ error: 'No vault contract configured (VAULT_ADDRESS not set)' });
  }

  // Use relayer private key to send WETH to vault (simulates yield accrual)
  const relayerKey = config.oracle.releaseAttestationRelayerPrivateKey;
  if (!relayerKey) {
    return res.status(500).json({ error: 'Relayer key not configured (RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY)' });
  }

  const { ethers } = require('ethers');
  const rpcUrl = config.contracts.evmRpcUrl;
  const vaultAddress = config.contracts.vaultAddress;
  const wethAddress = process.env.WETH_SEPOLIA || process.env.WETH_ADDRESS || '';

  if (!wethAddress) {
    return res.status(500).json({ error: 'WETH address not configured (set WETH_SEPOLIA in .env)' });
  }

  // Default: 0.005 WETH (~$15 at $3k/ETH) — enough to see yield but small for testnet faucet budgets
  const yieldAmountEth = parseFloat(amount) || 0.005;
  const yieldAmountWei = ethers.parseEther(String(yieldAmountEth));

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const relayerWallet = new ethers.Wallet(relayerKey, provider);

    // Step 1: Wrap ETH → WETH (call WETH.deposit{value: amount})
    const wrapTx = await relayerWallet.sendTransaction({
      to: wethAddress,
      value: yieldAmountWei,
      data: '0xd0e30db0', // deposit() selector
      gasLimit: 60000,
    });
    await wrapTx.wait();

    // Step 2: Transfer WETH → vault
    const wethIface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const transferData = wethIface.encodeFunctionData('transfer', [vaultAddress, yieldAmountWei]);
    const transferTx = await relayerWallet.sendTransaction({
      to: wethAddress,
      data: transferData,
      gasLimit: 60000,
    });
    const receipt = await transferTx.wait();

    console.log(`[simulate-yield] Injected ${yieldAmountEth} WETH into vault. tx=${receipt.hash}`);

    res.json({
      status: 'simulated',
      amount: yieldAmountEth,
      symbol: config.contracts.underlyingSymbol || 'WETH',
      tx_hash: receipt.hash,
      message: `Simulated ${yieldAmountEth} WETH yield injected into vault.`,
    });
  } catch (err) {
    console.error('[simulate-yield] Error:', err.message);
    res.status(500).json({ error: 'Simulation failed: ' + err.message });
  }
});

// ─── GET /reserve/:address (check reserve status for an address) ───

router.get('/reserve/:address', dualAuthMiddleware, async (req, res) => {
  const { address } = req.params;
  if (!address) {
    return res.status(400).json({ error: 'address is required' });
  }
  const normalizedAddr = normalizeAddr(address);
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: 'Invalid address format' });
  }
  // Security: caller can only view own reserve status
  if (req.auth.pubkey !== normalizedAddr) {
    return res.status(403).json({
      error: 'Forbidden',
      detail: 'You can only view your own vault reserve status',
    });
  }

  const pos = await db.vaultPositions.findById(normalizedAddr) || { shares: 0, deposited: 0 };
  const reserveRatioBps = config.vault?.reserveRatioBps || 2000;
  const reserveRatio = reserveRatioBps / 10000;
  const reserveAmount = (pos.deposited || 0) * reserveRatio;
  const investedAmount = (pos.deposited || 0) * (1 - reserveRatio);

  res.json({
    address: normalizedAddr,
    total_deposited: pos.deposited.toFixed(4),
    reserve: reserveAmount.toFixed(4),
    invested: investedAmount.toFixed(4),
    reserve_ratio_bps: reserveRatioBps,
    available_for_transfer: ((pos.deposited || 0) - reserveAmount).toFixed(4),
  });
});

module.exports = router;
// Expose vault position helpers for internal use (scheduler, allowances)
module.exports._getPosition = async (address) => {
  return await db.vaultPositions.findById(address) || { shares: 0, deposited: 0 };
};
module.exports._setPosition = async (address, pos) => {
  pos.updated_at = Date.now();
  await db.vaultPositions.create(address, pos);
};
