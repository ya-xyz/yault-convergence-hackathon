/**
 * Portfolio Tracker API — Chainlink Data Feeds Integration
 *
 * GET  /api/portfolio/:walletId         — Get portfolio value across all vaults
 * GET  /api/portfolio/:walletId/history — Get NAV snapshot history
 * POST /api/portfolio/:walletId/snapshot — Trigger a new NAV snapshot
 * GET  /api/portfolio/vaults            — List registered vaults with price feeds
 *
 * Reads on-chain data from ChainlinkPriceFeedTracker contract.
 */

import { ethers } from 'ethers';

// ChainlinkPriceFeedTracker ABI (minimal for reads)
const TRACKER_ABI = [
  'function getPortfolioValue(address user) view returns (uint256 totalUSD, tuple(address vault, uint256 shares, uint256 assetsUnderlying, uint256 valueUSD, int256 assetPriceUSD, uint8 feedDecimals)[] positions)',
  'function getAssetPrice(address vault) view returns (int256 priceUSD, uint8 decimals)',
  'function getShareValueUSD(address vault, uint256 shares) view returns (uint256 valueUSD)',
  'function getRegisteredVaults() view returns (address[])',
  'function getSnapshotCount(address user) view returns (uint256)',
  'function getSnapshot(address user, uint256 index) view returns (tuple(uint256 totalValueUSD, uint256 timestamp, uint256 vaultCount))',
  'function getLatestSnapshot(address user) view returns (tuple(uint256 totalValueUSD, uint256 timestamp, uint256 vaultCount))',
  'function takeSnapshot(address user)',
];

/**
 * Create portfolio tracker API routes.
 *
 * @param {import('express').Router} router - Express router.
 * @param {object} config - Server configuration.
 * @param {string} config.rpcUrl - Ethereum RPC URL.
 * @param {string} config.trackerAddress - ChainlinkPriceFeedTracker contract address.
 * @param {string} [config.privateKey] - Private key for write operations (snapshot).
 */
export function registerPortfolioRoutes(router, config) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const tracker = new ethers.Contract(config.trackerAddress, TRACKER_ABI, provider);

  // Optional signer for write operations
  let signer = null;
  if (config.privateKey) {
    signer = new ethers.Wallet(config.privateKey, provider);
  }

  // GET /api/portfolio/vaults — List registered vaults
  router.get('/api/portfolio/vaults', async (_req, res) => {
    try {
      const vaults = await tracker.getRegisteredVaults();
      const vaultData = [];

      for (const vaultAddr of vaults) {
        try {
          const [priceUSD, decimals] = await tracker.getAssetPrice(vaultAddr);
          vaultData.push({
            address: vaultAddr,
            priceUSD: ethers.formatUnits(priceUSD, decimals),
            feedDecimals: Number(decimals),
          });
        } catch {
          vaultData.push({ address: vaultAddr, priceUSD: null, error: 'price_unavailable' });
        }
      }

      res.json({ vaults: vaultData, count: vaultData.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch vaults', details: err.message });
    }
  });

  // GET /api/portfolio/:walletAddress — Get portfolio value
  router.get('/api/portfolio/:walletAddress', async (req, res) => {
    try {
      const { walletAddress } = req.params;
      if (!ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
      }

      const [totalUSD, positions] = await tracker.getPortfolioValue(walletAddress);

      const formatted = positions.map(p => ({
        vault: p.vault,
        shares: p.shares.toString(),
        assetsUnderlying: p.assetsUnderlying.toString(),
        valueUSD: ethers.formatUnits(p.valueUSD, 18),
        assetPriceUSD: p.assetPriceUSD.toString(),
        feedDecimals: Number(p.feedDecimals),
      }));

      res.json({
        walletAddress,
        totalValueUSD: ethers.formatUnits(totalUSD, 18),
        positions: formatted,
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch portfolio', details: err.message });
    }
  });

  // GET /api/portfolio/:walletAddress/history — NAV snapshot history
  router.get('/api/portfolio/:walletAddress/history', async (req, res) => {
    try {
      const { walletAddress } = req.params;
      if (!ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
      }

      const count = await tracker.getSnapshotCount(walletAddress);
      const snapshots = [];

      // Return last 100 snapshots max
      const start = count > 100n ? count - 100n : 0n;
      for (let i = start; i < count; i++) {
        const snap = await tracker.getSnapshot(walletAddress, i);
        snapshots.push({
          totalValueUSD: ethers.formatUnits(snap.totalValueUSD, 18),
          timestamp: Number(snap.timestamp),
          vaultCount: Number(snap.vaultCount),
        });
      }

      res.json({
        walletAddress,
        snapshots,
        totalSnapshots: Number(count),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch history', details: err.message });
    }
  });

  // POST /api/portfolio/:walletAddress/snapshot — Trigger NAV snapshot
  router.post('/api/portfolio/:walletAddress/snapshot', async (req, res) => {
    try {
      if (!signer) {
        return res.status(503).json({ error: 'Write operations not configured' });
      }

      const { walletAddress } = req.params;
      if (!ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
      }

      const trackerWithSigner = tracker.connect(signer);
      const tx = await trackerWithSigner.takeSnapshot(walletAddress);
      const receipt = await tx.wait();

      res.json({
        success: true,
        walletAddress,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to take snapshot', details: err.message });
    }
  });
}
