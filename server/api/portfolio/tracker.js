/**
 * Portfolio Tracker API — Chainlink Integration
 *
 * GET  /vaults                    — List registered vaults with price feeds
 * GET  /automation/status         — AutoHarvest status (Chainlink Automation)
 * GET  /analytics/:walletAddress  — Portfolio analytics (Chainlink Functions)
 * GET  /ccip/status               — Cross-chain bridge status (Chainlink CCIP)
 * GET  /:walletAddress            — Get portfolio value across all vaults
 * GET  /:walletAddress/history    — Get NAV snapshot history
 * POST /:walletAddress/snapshot   — Trigger a new NAV snapshot
 *
 * Reads on-chain data from Chainlink-integrated contracts.
 * Mount at /api/portfolio in server/index.js.
 */

const { Router } = require('express');

const router = Router();

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
  'function vaultFeeds(address vault) view returns (address vault, address priceFeed, uint8 feedDecimals, uint8 assetDecimals, bool active)',
];

// Chainlink AggregatorV3 ABI for reading feed metadata
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
];

// AutoHarvest ABI (Chainlink Automation)
const AUTOHARVEST_ABI = [
  'function getTargetCount() view returns (uint256)',
  'function targets(uint256) view returns (address vault, address user, bool active)',
  'function getHistoryCount() view returns (uint256)',
  'function harvestHistory(uint256) view returns (address vault, address user, uint256 timestamp, bool success)',
  'function isTargetHarvestable(uint256 targetIndex) view returns (bool)',
  'function getEstimatedYield(uint256 targetIndex) view returns (uint256)',
  'function minYieldThreshold() view returns (uint256)',
  'function maxBatchSize() view returns (uint256)',
  'function minHarvestInterval() view returns (uint256)',
  'function automationForwarder() view returns (address)',
  'function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)',
];

// PortfolioAnalytics ABI (Chainlink Functions)
const ANALYTICS_ABI = [
  'function getAnalytics(address user) view returns (tuple(uint256 portfolioValueUSD, uint256 totalYieldEarned, uint16 riskScore, uint16 apyBps, uint256 sharpeRatioX1000, uint256 maxDrawdownBps, uint256 timestamp, bool valid))',
  'function hasValidAnalytics(address user, uint256 maxAge) view returns (bool)',
  'function subscriptionId() view returns (uint64)',
  'function donId() view returns (bytes32)',
  'function callbackGasLimit() view returns (uint32)',
  'function minRequestInterval() view returns (uint256)',
];

// CrossChainVaultBridge ABI (Chainlink CCIP)
const CCIP_BRIDGE_ABI = [
  'function getSupportedChains() view returns (uint64[])',
  'function remoteChains(uint64) view returns (address remoteBridge, bool allowed, uint256 lastMessageTime)',
  'function outgoingNonce() view returns (uint256)',
  'function minMessageInterval() view returns (uint256)',
  'function ccipGasLimit() view returns (uint256)',
];

// Lazy-init contract instances (only when env vars are set)
let provider = null;
let tracker = null;
let autoHarvest = null;
let analytics = null;
let ccipBridge = null;
let signer = null;

function ensureContract() {
  if (tracker) return true;
  const rpcUrl = process.env.RPC_URL;
  const trackerAddress = process.env.PORTFOLIO_TRACKER_ADDRESS;
  if (!rpcUrl || !trackerAddress) return false;

  const { ethers } = require('ethers');
  provider = new ethers.JsonRpcProvider(rpcUrl);
  tracker = new ethers.Contract(trackerAddress, TRACKER_ABI, provider);
  if (process.env.PORTFOLIO_SIGNER_KEY) {
    signer = new ethers.Wallet(process.env.PORTFOLIO_SIGNER_KEY, provider);
  }
  // Optional: AutoHarvest contract
  if (process.env.AUTOHARVEST_ADDRESS) {
    autoHarvest = new ethers.Contract(process.env.AUTOHARVEST_ADDRESS, AUTOHARVEST_ABI, provider);
  }
  // Optional: PortfolioAnalytics contract
  if (process.env.PORTFOLIO_ANALYTICS_ADDRESS) {
    analytics = new ethers.Contract(process.env.PORTFOLIO_ANALYTICS_ADDRESS, ANALYTICS_ABI, provider);
  }
  // Optional: CrossChainVaultBridge contract
  if (process.env.CCIP_BRIDGE_ADDRESS) {
    ccipBridge = new ethers.Contract(process.env.CCIP_BRIDGE_ADDRESS, CCIP_BRIDGE_ABI, provider);
  }
  return true;
}

// Normalize wallet address (Yallet may omit 0x prefix)
function normalizeAddress(addr) {
  if (addr && !addr.startsWith('0x')) return '0x' + addr;
  return addr;
}

// GET /vaults — List registered vaults
router.get('/vaults', async (_req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured (PORTFOLIO_TRACKER_ADDRESS missing)' });
  }
  try {
    const { ethers } = require('ethers');
    const vaults = await tracker.getRegisteredVaults();
    const vaultData = [];

    for (const vaultAddr of vaults) {
      try {
        const [priceUSD, decimals] = await tracker.getAssetPrice(vaultAddr);
        const vaultFeed = await tracker.vaultFeeds(vaultAddr);
        const feedAddress = vaultFeed.priceFeed;

        // Read Chainlink feed metadata directly from the AggregatorV3 contract
        let chainlinkFeed = { address: feedAddress };
        try {
          const feed = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);
          const [roundId, answer, startedAt, updatedAt, answeredInRound] = await feed.latestRoundData();
          const description = await feed.description();
          chainlinkFeed = {
            address: feedAddress,
            description,
            roundId: roundId.toString(),
            answer: answer.toString(),
            startedAt: Number(startedAt),
            updatedAt: Number(updatedAt),
            answeredInRound: answeredInRound.toString(),
          };
        } catch { /* feed metadata optional */ }

        vaultData.push({
          address: vaultAddr,
          priceUSD: ethers.formatUnits(priceUSD, decimals),
          feedDecimals: Number(decimals),
          chainlinkFeed,
        });
      } catch {
        vaultData.push({ address: vaultAddr, priceUSD: null, error: 'price_unavailable' });
      }
    }

    res.json({
      vaults: vaultData,
      count: vaultData.length,
      trackerContract: process.env.PORTFOLIO_TRACKER_ADDRESS,
      network: 'Ethereum Sepolia',
      chainId: 11155111,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vaults', details: err.message });
  }
});

// GET /automation/status — AutoHarvest status (Chainlink Automation / Keepers)
router.get('/automation/status', async (_req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured' });
  }
  try {
    // If AutoHarvest is not deployed, return contract info only
    if (!autoHarvest) {
      return res.json({
        deployed: false,
        contractAddress: process.env.AUTOHARVEST_ADDRESS || null,
        description: 'Chainlink Automation (Keepers) compatible contract for auto-harvesting YaultVault yield when it exceeds a configurable threshold.',
        features: [
          'Periodic off-chain condition checks via Chainlink Automation nodes',
          'Batch-harvest for multiple users in a single transaction',
          'Configurable yield threshold and harvest intervals',
          'On-chain harvest history for transparency',
        ],
        chainlinkService: 'Chainlink Automation (Keepers)',
        network: 'Ethereum Sepolia',
      });
    }

    const [targetCount, historyCount, minThreshold, batchSize, interval, forwarder] = await Promise.all([
      autoHarvest.getTargetCount(),
      autoHarvest.getHistoryCount(),
      autoHarvest.minYieldThreshold(),
      autoHarvest.maxBatchSize(),
      autoHarvest.minHarvestInterval(),
      autoHarvest.automationForwarder(),
    ]);

    // Check if upkeep is needed
    let upkeepNeeded = false;
    try {
      const [needed] = await autoHarvest.checkUpkeep('0x');
      upkeepNeeded = needed;
    } catch { /* checkUpkeep may revert if no targets */ }

    // Fetch targets (up to 20)
    const count = Math.min(Number(targetCount), 20);
    const targets = [];
    for (let i = 0; i < count; i++) {
      try {
        const t = await autoHarvest.targets(i);
        const harvestable = await autoHarvest.isTargetHarvestable(i).catch(() => false);
        const estimatedYield = await autoHarvest.getEstimatedYield(i).catch(() => 0n);
        targets.push({
          index: i,
          vault: t.vault,
          user: t.user,
          active: t.active,
          harvestable,
          estimatedYield: estimatedYield.toString(),
        });
      } catch { /* skip inaccessible targets */ }
    }

    // Fetch recent harvest history (last 10)
    const hCount = Number(historyCount);
    const history = [];
    const hStart = Math.max(0, hCount - 10);
    for (let i = hStart; i < hCount; i++) {
      try {
        const h = await autoHarvest.harvestHistory(i);
        history.push({
          vault: h.vault,
          user: h.user,
          timestamp: Number(h.timestamp),
          success: h.success,
        });
      } catch { break; }
    }

    res.json({
      deployed: true,
      contractAddress: process.env.AUTOHARVEST_ADDRESS,
      chainlinkService: 'Chainlink Automation (Keepers)',
      upkeepNeeded,
      config: {
        minYieldThreshold: minThreshold.toString(),
        maxBatchSize: Number(batchSize),
        minHarvestInterval: Number(interval),
        automationForwarder: forwarder,
      },
      targets,
      totalTargets: Number(targetCount),
      history,
      totalHarvests: hCount,
      network: 'Ethereum Sepolia',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch automation status', details: err.message });
  }
});

// GET /analytics/:walletAddress — Portfolio Analytics (Chainlink Functions)
router.get('/analytics/:walletAddress', async (req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured' });
  }
  try {
    const { ethers } = require('ethers');
    const walletAddress = normalizeAddress(req.params.walletAddress);
    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // If PortfolioAnalytics is not deployed, return contract info
    if (!analytics) {
      return res.json({
        deployed: false,
        contractAddress: process.env.PORTFOLIO_ANALYTICS_ADDRESS || null,
        walletAddress,
        description: 'Chainlink Functions consumer for off-chain portfolio analytics — computes risk scores, APY, Sharpe ratio, and max drawdown using the Chainlink DON.',
        metrics: [
          { key: 'riskScore', label: 'Risk Score', description: 'Portfolio risk assessment (0-100%)' },
          { key: 'apyBps', label: 'APY', description: 'Annualized yield in basis points' },
          { key: 'sharpeRatio', label: 'Sharpe Ratio', description: 'Risk-adjusted return metric' },
          { key: 'maxDrawdown', label: 'Max Drawdown', description: 'Largest peak-to-trough decline' },
        ],
        chainlinkService: 'Chainlink Functions',
        network: 'Ethereum Sepolia',
      });
    }

    const result = await analytics.getAnalytics(walletAddress);
    const hasValid = await analytics.hasValidAnalytics(walletAddress, 86400).catch(() => false);

    const [subId, donId, gasLimit, minInterval] = await Promise.all([
      analytics.subscriptionId(),
      analytics.donId(),
      analytics.callbackGasLimit(),
      analytics.minRequestInterval(),
    ]);

    res.json({
      deployed: true,
      contractAddress: process.env.PORTFOLIO_ANALYTICS_ADDRESS,
      walletAddress,
      chainlinkService: 'Chainlink Functions',
      hasValidAnalytics: hasValid,
      analytics: {
        portfolioValueUSD: ethers.formatUnits(result.portfolioValueUSD, 18),
        totalYieldEarned: ethers.formatUnits(result.totalYieldEarned, 18),
        riskScore: Number(result.riskScore) / 100,  // basis points to percentage
        apyBps: Number(result.apyBps),
        apyPercent: Number(result.apyBps) / 100,
        sharpeRatio: Number(result.sharpeRatioX1000) / 1000,
        maxDrawdownBps: Number(result.maxDrawdownBps),
        maxDrawdownPercent: Number(result.maxDrawdownBps) / 100,
        timestamp: Number(result.timestamp),
        valid: result.valid,
      },
      config: {
        subscriptionId: Number(subId),
        donId: donId,
        callbackGasLimit: Number(gasLimit),
        minRequestInterval: Number(minInterval),
      },
      network: 'Ethereum Sepolia',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics', details: err.message });
  }
});

// GET /ccip/status — CrossChain Bridge status (Chainlink CCIP)
router.get('/ccip/status', async (_req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured' });
  }
  try {
    // If CCIP Bridge is not deployed, return capability info
    if (!ccipBridge) {
      return res.json({
        deployed: false,
        contractAddress: process.env.CCIP_BRIDGE_ADDRESS || null,
        description: 'Chainlink CCIP bridge for cross-chain vault operations — attestation relay, portfolio position sync, and cross-chain deposit intents.',
        capabilities: [
          { type: 'Attestation Relay', description: 'Forward release attestations between chains' },
          { type: 'Position Sync', description: 'Broadcast vault position data across chains' },
          { type: 'Deposit Intent', description: 'Signal cross-chain deposit intentions' },
        ],
        chainlinkService: 'Chainlink CCIP',
        network: 'Ethereum Sepolia',
      });
    }

    const [chains, nonce, minInterval, gasLimit] = await Promise.all([
      ccipBridge.getSupportedChains(),
      ccipBridge.outgoingNonce(),
      ccipBridge.minMessageInterval(),
      ccipBridge.ccipGasLimit(),
    ]);

    const chainDetails = [];
    for (const selector of chains) {
      try {
        const config = await ccipBridge.remoteChains(selector);
        chainDetails.push({
          chainSelector: selector.toString(),
          remoteBridge: config.remoteBridge,
          allowed: config.allowed,
          lastMessageTime: Number(config.lastMessageTime),
        });
      } catch { /* skip */ }
    }

    res.json({
      deployed: true,
      contractAddress: process.env.CCIP_BRIDGE_ADDRESS,
      chainlinkService: 'Chainlink CCIP',
      supportedChains: chainDetails,
      totalChains: chainDetails.length,
      outgoingMessages: Number(nonce),
      config: {
        minMessageInterval: Number(minInterval),
        ccipGasLimit: Number(gasLimit),
      },
      network: 'Ethereum Sepolia',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch CCIP status', details: err.message });
  }
});

// GET /:walletAddress — Get portfolio value
router.get('/:walletAddress', async (req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured' });
  }
  try {
    const { ethers } = require('ethers');
    const walletAddress = normalizeAddress(req.params.walletAddress);
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
      source: 'Chainlink Data Feeds',
      trackerContract: process.env.PORTFOLIO_TRACKER_ADDRESS,
      network: 'Ethereum Sepolia',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch portfolio', details: err.message });
  }
});

// GET /:walletAddress/history — NAV snapshot history
router.get('/:walletAddress/history', async (req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured' });
  }
  try {
    const { ethers } = require('ethers');
    const walletAddress = normalizeAddress(req.params.walletAddress);
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

// POST /:walletAddress/snapshot — Trigger NAV snapshot
router.post('/:walletAddress/snapshot', async (req, res) => {
  if (!ensureContract()) {
    return res.status(503).json({ error: 'Portfolio tracker not configured' });
  }
  try {
    const { ethers } = require('ethers');
    if (!signer) {
      return res.status(503).json({ error: 'Write operations not configured (PORTFOLIO_SIGNER_KEY missing)' });
    }

    const walletAddress = normalizeAddress(req.params.walletAddress);
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

module.exports = router;
