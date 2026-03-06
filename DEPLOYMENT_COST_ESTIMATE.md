# Yault Guardian Vault - Mainnet Deployment Cost Estimate

> Generated: March 6, 2026

## Summary

| Scenario | Estimated Total Gas | ETH Cost | USD Cost |
|----------|-------------------|----------|----------|
| Ethereum Mainnet (current ~1 gwei) | ~7.5M–10M gas | ~0.0075–0.01 ETH | **$15–$21** |
| Ethereum Mainnet (moderate 10 gwei) | ~7.5M–10M gas | ~0.075–0.1 ETH | **$156–$208** |
| Ethereum Mainnet (busy 30 gwei) | ~7.5M–10M gas | ~0.225–0.3 ETH | **$468–$625** |
| Ethereum Mainnet (high 100 gwei) | ~7.5M–10M gas | ~0.75–1.0 ETH | **$1,560–$2,080** |

**Current market conditions (March 2026): Gas ~1 gwei, ETH ~$2,080 → Total ~$15–$21**

---

## Per-Contract Gas Estimates

| Contract | LOC | Estimated Deploy Gas | Notes |
|----------|-----|---------------------|-------|
| **YaultVault.sol** | 736 | 2,000,000–2,500,000 | Largest contract; ERC-4626 + Aave strategy + revenue split |
| **YaultVaultFactory.sol** | 148 | 400,000–600,000 | Factory pattern, deploys per-strategy vaults |
| **YaultVaultCreator.sol** | 45 | 150,000–250,000 | Minimal bytecode helper for EIP-170 compliance |
| **ReleaseAttestation.sol** | 176 | 350,000–500,000 | Attestation storage + Chainlink CRE integration |
| **VaultShareEscrow.sol** | 224 | 450,000–650,000 | ERC-4626 share escrow + per-recipient tracking |
| **YaultPathClaim.sol** | 317 | 600,000–850,000 | ECDSA signature verification + replay protection |
| **AutoHarvest.sol** | 311 | 550,000–800,000 | Chainlink Automation compatible + batch harvesting |
| **ChainlinkPriceFeedTracker.sol** | 355 | 650,000–900,000 | Multi-vault NAV tracking + stale price detection |
| **PortfolioAnalytics.sol** | 306 | 600,000–850,000 | Chainlink Functions consumer |
| **CrossChainVaultBridge.sol** | 409 | 750,000–1,100,000 | Chainlink CCIP + rate limiting + 3 message types |
| **Total** | **3,027** | **~6,500,000–9,000,000** | |

> Additional gas for constructor arguments, factory vault creation calls (WETH/WBTC/USDC), and post-deploy configuration transactions adds ~1M–2M gas.

---

## Assumptions

- **Compiler**: Solidity 0.8.28 with `via_ir = true`, optimizer enabled (200 runs)
- **ETH Price**: ~$2,080 (March 6, 2026)
- **Gas Price**: Currently ~1 gwei on Ethereum mainnet (historically low)
- **EIP-170**: YaultVault is near the 24 KiB limit; the Creator pattern is already used to mitigate this

## Additional Ongoing Costs

Beyond one-time deployment, operating this system requires:

| Service | Cost Type | Estimate |
|---------|-----------|----------|
| **Chainlink Automation** (AutoHarvest) | LINK token | ~1–5 LINK/month depending on harvest frequency |
| **Chainlink Functions** (PortfolioAnalytics) | LINK token | ~0.1–0.5 LINK per request |
| **Chainlink CCIP** (CrossChainVaultBridge) | LINK token | ~0.5–2 LINK per cross-chain message |
| **Chainlink Data Feeds** (PriceFeedTracker) | Free | Reads from existing Chainlink oracles (no direct cost) |
| **Vault creation** (via Factory) | Gas per vault | ~2M–2.5M gas per new vault deployment |
| **User transactions** (deposit/withdraw/harvest) | Gas per tx | ~100K–300K gas per operation |

## Recommendations

1. **Deploy now**: Gas prices are at historic lows (~1 gwei). Total deployment cost is under $25.
2. **Consider L2**: For ongoing user transaction costs, deploying on Base, Arbitrum, or Optimism would reduce per-transaction fees by 10–100x. The CCIP bridge contract already supports cross-chain operations.
3. **Batch deployments**: Use a single deployment script (`Deploy.s.sol` + `DeployChainlinkIntegrations.s.sol`) to minimize overhead.
4. **Fund LINK**: Budget ~50–100 LINK ($300–$600 at current prices) for initial Chainlink service subscriptions.
