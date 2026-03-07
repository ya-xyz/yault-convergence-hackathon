# Yault — Deployment Guide

Complete deployment instructions for the Yault non-custodial asset release platform, covering smart contracts (Foundry), server (Node.js), WASM cryptography core (Rust), and Chainlink integrations.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Smart Contract Deployment](#smart-contract-deployment)
4. [Post-Deployment Configuration](#post-deployment-configuration)
5. [Yield Strategy Setup](#yield-strategy-setup)
6. [Chainlink Integrations](#chainlink-integrations)
7. [Oracle Workflow (CRE)](#oracle-workflow-cre)
8. [Server Deployment](#server-deployment)
9. [Docker Deployment](#docker-deployment)
10. [Multi-Chain Deployment](#multi-chain-deployment)
11. [Testnet Reference Addresses](#testnet-reference-addresses)

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Server runtime |
| Rust | 1.75+ | WASM cryptography core |
| wasm-pack | latest | Rust → WebAssembly build |
| Foundry (forge) | latest | Smart contract compilation, testing, deployment |
| Docker (optional) | 20+ | Containerized deployment |

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Install contract dependencies
cd contracts && forge install
```

---

## Environment Setup

Copy `.env.example` to `.env` and fill in secrets:

```bash
cp .env.example .env
```

Generate environment profile configs:

```bash
npm run env:dev          # development profile → env/.env.development
npm run env:prod         # production profile  → env/.env.production
```

### Key Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOYER_PRIVATE_KEY` | Yes (deploy) | Deployer wallet private key |
| `PLATFORM_FEE_RECIPIENT` | Yes (deploy) | Address receiving platform fees |
| `JWT_SECRET` | Yes (server) | Auth token signing key (`openssl rand -hex 32`) |
| `CLIENT_SESSION_SECRET` | Yes (server) | Client session HMAC secret (`openssl rand -hex 32`) |
| `VAULT_ADDRESS` | Yes (server) | Deployed YaultVault (ERC-4626) address |
| `EVM_RPC_URL` | Yes | EVM JSON-RPC endpoint |
| `VAULT_CHAIN_ID` | Yes | Target chain ID |
| `ARWEAVE_WALLET_JWK` | Yes (prod) | Path to Arweave wallet JWK for permanent storage |

---

## Smart Contract Deployment

Contracts are deployed in phases — each phase depends on outputs from the previous phase.

### Phase 1: Core Vault System

Deploys `YaultVaultCreator`, `YaultVaultFactory`, and initial ERC-4626 vaults.

```bash
cd contracts

# Required
export DEPLOYER_PRIVATE_KEY=0x...
export PLATFORM_FEE_RECIPIENT=0x...
export WETH_ADDRESS=0x...          # WETH on target chain

# Optional — deploy additional vaults
export WBTC_ADDRESS=0x...          # Deploys WBTC vault if set
export USDC_ADDRESS=0x...          # Deploys USDC vault if set

forge script script/Deploy.s.sol:Deploy \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify
```

**Output:** Save `Factory`, `Creator`, and `Vault` addresses from console output.

### Phase 2: ReleaseAttestation

Deploys the dual-source attestation contract (oracle primary + fallback).

```bash
forge script script/DeployReleaseAttestation.s.sol:DeployReleaseAttestation \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify
```

**Output:** Save `RELEASE_ATTESTATION_ADDRESS`.

### Phase 3: VaultShareEscrow

Deploys the escrow that holds vault shares and releases by attestation.

```bash
export VAULT_ADDRESS=0x...                  # From Phase 1
export RELEASE_ATTESTATION_ADDRESS=0x...    # From Phase 2

forge script script/DeployVaultShareEscrow.s.sol:DeployVaultShareEscrow \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify
```

### Phase 4: YaultPathClaim

Deploys the path-based claim contract with EIP-712 signature verification.

```bash
export RELEASE_ATTESTATION_ADDRESS=0x...    # From Phase 2
export PATH_CLAIM_ASSET_ADDRESS=0x...       # e.g. USDC address

forge script script/DeployYaultPathClaim.s.sol:DeployYaultPathClaim \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify
```

### Phase 5: Chainlink Integrations

Deploys `ChainlinkPriceFeedTracker`, `AutoHarvest`, and optionally `CrossChainVaultBridge` and `PortfolioAnalytics`.

```bash
export DEPLOYER_PRIVATE_KEY=0x...

# Optional — CCIP bridge (deploy only if CCIP Router available)
export CCIP_ROUTER=0x...
export LINK_TOKEN=0x...

# Optional — Chainlink Functions analytics
export FUNCTIONS_ROUTER=0x...
export FUNCTIONS_SUB_ID=...
export FUNCTIONS_DON_ID=0x...

# Optional — configure price feeds during deployment
export ETH_USD_FEED=0x...          # Chainlink ETH/USD feed
export USDC_USD_FEED=0x...         # Chainlink USDC/USD feed
export VAULT_ADDRESS=0x...         # Register vault with tracker

forge script script/DeployChainlinkIntegrations.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify
```

**Output:** Save `PORTFOLIO_TRACKER_ADDRESS`, `AUTOHARVEST_ADDRESS`, and (if deployed) `CCIP_BRIDGE_ADDRESS`, `PORTFOLIO_ANALYTICS_ADDRESS`.

---

## Post-Deployment Configuration

### ReleaseAttestation — Submitter Whitelisting

After deploying `ReleaseAttestation`, configure authorized submitters:

```solidity
// 1. Whitelist the Chainlink CRE forwarder (oracle source)
releaseAttestation.setOracleSubmitter(CRE_FORWARDER_ADDRESS);

// 2. Whitelist the platform relayer (fallback source)
releaseAttestation.setFallbackSubmitter(RELAYER_ADDRESS, true);
```

Use `cast send` for these calls:

```bash
cast send $RELEASE_ATTESTATION_ADDRESS \
  "setOracleSubmitter(address)" $CRE_FORWARDER_ADDRESS \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY

cast send $RELEASE_ATTESTATION_ADDRESS \
  "setFallbackSubmitter(address,bool)" $RELAYER_ADDRESS true \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY
```

### AutoHarvest — Register Targets

```bash
cast send $AUTOHARVEST_ADDRESS \
  "addTarget(address,uint256)" $VAULT_ADDRESS 3600 \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY
```

The second parameter is the minimum interval (seconds) between harvests.

### ChainlinkPriceFeedTracker — Register Vault Feeds

```bash
cast send $PORTFOLIO_TRACKER_ADDRESS \
  "registerVaultFeed(address,address)" $VAULT_ADDRESS $PRICE_FEED_ADDRESS \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY
```

---

## Yield Strategy Setup

After vault deployment, connect each vault to its Aave V3 yield strategy:

```bash
export VAULT_ADDRESS=0x...
export AAVE_POOL=0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2    # Aave V3 Pool (mainnet)
export ATOKEN=0x...                                              # aToken for the underlying asset

forge script script/SetStrategy.s.sol:SetStrategy \
  --rpc-url $RPC_URL \
  --broadcast
```

This calls `vault.setStrategy(aavePool, aToken)` which enables the 75/20/5 yield split (user / platform / authority).

### Testnet Mock Strategy

For Sepolia testing without a live Aave deployment:

```bash
export WETH_ADDRESS=0x...       # Sepolia WETH

forge script script/DeployMockStrategy.s.sol:DeployMockStrategy \
  --rpc-url $RPC_URL \
  --broadcast
```

Then manually:
1. `vault.setStrategy(mockPool, aToken)`
2. `vault.approveStrategyToken()`
3. `vault.investToStrategy(amount)`

---

## Chainlink Integrations

### Data Feeds (ChainlinkPriceFeedTracker)

Reads live Chainlink price feeds for portfolio valuation. No subscription required — price feeds are public.

**Sepolia feeds:**
- ETH/USD: `0x694AA1769357215DE4FAC081bf1f309aDC325306`

### Automation (AutoHarvest)

Register the `AutoHarvest` contract as a Chainlink Automation upkeep:

1. Go to [automation.chain.link](https://automation.chain.link)
2. Register new upkeep → Custom logic
3. Enter `AUTOHARVEST_ADDRESS`
4. Fund with LINK

The contract implements `checkUpkeep()` / `performUpkeep()` for automated yield harvesting.

### CCIP (CrossChainVaultBridge)

Cross-chain attestation relay and position sync. Requires:

- CCIP Router address for the source chain
- LINK tokens for message fees
- Remote chain configuration via `setRemoteChain()`

### Functions (PortfolioAnalytics)

Off-chain analytics computation via Chainlink Functions. Requires:

- A Chainlink Functions subscription funded with LINK
- DON ID for the target network

---

## Oracle Workflow (CRE)

The Chainlink CRE (Compute Runtime Environment) workflow automates oracle attestations.

### Configuration

Production config: `oracle/workflow/config.production.json`

```json
{
  "chainSelectorName": "evm-ethereum-sepolia",
  "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
  "releaseAttestationAddress": "0x410D42eAf9D0Ca036664eFE1E866a12d9f0fdc19",
  "platformApiBaseUrl": "https://api.yault.xyz",
  "drandUrl": "https://drand.cloudflare.com",
  "vaultAddress": "0xCdF23BF390B1c4BEb811371466b04BB17759FB14",
  "complianceApiUrl": "https://api.yault.xyz/api/compliance",
  "priceFeedAddress": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  "maxStalenessSeconds": 3600
}
```

### Simulation

```bash
cd oracle/workflow
npm install
npm run build
npm run simulate    # cre workflow simulate . --target staging
```

### Workflow Data Sources

The CRE workflow aggregates 4 independent data sources before submitting an on-chain attestation:

1. **drand beacon** — Cryptographic randomness timestamp
2. **Vault balance** — Verify asset availability on-chain
3. **Compliance API** — KYC/sanctions screening
4. **Chainlink Price Feed** — Current asset valuation

---

## Server Deployment

### Local Development

```bash
npm install
npm run build:wasm:webapp    # Build Rust → WASM and copy to webapp
npm run dev                  # Start development server on port 3001
```

### Production

```bash
npm install --omit=dev
npm run build:wasm:webapp
NODE_ENV=production node server/index.js
```

### Update `.env` with Deployed Addresses

After contract deployment, update `.env` with all contract addresses:

```bash
# Core
VAULT_ADDRESS=0x...
EVM_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VAULT_CHAIN_ID=11155111

# Attestation
ORACLE_ATTESTATION_ENABLED=true
RELEASE_ATTESTATION_ADDRESS=0x...
RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY=0x...

# Path Claim
PATH_CLAIM_ADDRESS=0x...
PATH_CLAIM_ASSET_ADDRESS=0x...

# Chainlink Integrations
PORTFOLIO_TRACKER_ADDRESS=0x...
AUTOHARVEST_ADDRESS=0x...
CCIP_BRIDGE_ADDRESS=0x...               # If deployed
PORTFOLIO_ANALYTICS_ADDRESS=0x...       # If deployed
```

### Database

The server uses SQLite via sql.js (WASM, no native dependencies). Database is auto-created at startup.

```bash
DATABASE_PATH=./data/yault.db    # Default path
```

---

## Docker Deployment

### Build and Run

```bash
docker compose up --build
```

This starts:
- **api** — Yault server (port 3001)
- **arlocal** — Local Arweave gateway for development (port 1984)

### Production Docker Build

```bash
docker build -t yault-server .
docker run -d \
  --name yault \
  -p 3001:3001 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  yault-server
```

The multi-stage Dockerfile:
1. Builds the Rust WASM cryptography core (`wasm-pack build --target web --release`)
2. Installs Node.js dependencies (production only)
3. Copies server, client, WASM output, and webapp
4. Runs with health check on `/health`

---

## Multi-Chain Deployment

Deploy the vault system across multiple EVM chains:

```bash
cd contracts

export DEPLOYER_PRIVATE_KEY=0x...
export PLATFORM_FEE_RECIPIENT=0x...

# Deploy to all supported chains
./script/deploy-multichain.sh

# Or deploy to specific chains
./script/deploy-multichain.sh ethereum arbitrum base
```

**Supported chains:** ethereum, arbitrum, optimism, base, polygon, bsc, avalanche

Each chain uses its native USDC address. Deployment artifacts are saved to `deployments/<chain>.json`.

Custom RPC endpoints can be set via environment variables:

```bash
export RPC_ETHEREUM=https://...
export RPC_ARBITRUM=https://...
export RPC_BASE=https://...
```

---

## Testnet Reference Addresses

### Sepolia (Chain ID: 11155111)

| Contract | Address |
|----------|---------|
| YaultVault (yWETH) | `0xCdF23BF390B1c4BEb811371466b04BB17759FB14` |
| ReleaseAttestation | `0x410D42eAf9D0Ca036664eFE1E866a12d9f0fdc19` |
| USDC (Sepolia) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| ETH/USD Price Feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |

### Running Tests

```bash
# Smart contract tests
cd contracts && forge test -vvv

# Server (development)
npm run dev
```

---

## Deployment Checklist

- [ ] Generate secrets: `JWT_SECRET`, `CLIENT_SESSION_SECRET`
- [ ] Deploy Phase 1: Core Vault System (`Deploy.s.sol`)
- [ ] Deploy Phase 2: ReleaseAttestation (`DeployReleaseAttestation.s.sol`)
- [ ] Configure: `setOracleSubmitter()` + `setFallbackSubmitter()`
- [ ] Deploy Phase 3: VaultShareEscrow (`DeployVaultShareEscrow.s.sol`)
- [ ] Deploy Phase 4: YaultPathClaim (`DeployYaultPathClaim.s.sol`)
- [ ] Deploy Phase 5: Chainlink Integrations (`DeployChainlinkIntegrations.s.sol`)
- [ ] Set yield strategy: `SetStrategy.s.sol`
- [ ] Update `.env` with all deployed addresses
- [ ] Build WASM: `npm run build:wasm:webapp`
- [ ] Start server and verify `/health` endpoint
- [ ] Register Automation upkeep on automation.chain.link
