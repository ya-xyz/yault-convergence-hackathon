# Yault Crypto Asset Management Platform

**Self-custodial inheritance and conditional asset release with auditable yield sharing, powered by Chainlink CRE-orchestrated attestations and real-time portfolio analytics.**

> **Convergence: A Chainlink Hackathon**
> Tracks: **DeFi & Tokenization** | **Risk & Compliance**
> Submission Deadline: March 8, 2026 11:59 PM ET

---

## Demo Video

> **[Watch the demo video →](https://youtu.be/oey9bS2sctM)**
>
> The video demonstrates:
> - Setting up asset distribution plan and simulation 
> - Chainlink event triggering off credential release
> - Asset recipients claiming shares
> - Asset portfolio introduction

---

## Problem: The Self-Custody Trilemma

Over **$100 billion** in crypto is permanently lost because holders die and keys vanish. The root cause is the **self-custody trilemma** — three properties that every crypto holder needs, but no existing solution can deliver simultaneously:

1. **Custody** — The holder retains sole control of private keys; no third party can access or freeze assets
2. **Inheritance** — Assets can be reliably transferred to designated recipients upon real-world events (death, incapacity, legal triggers)
3. **Yield** — Locked or escrowed assets continue earning returns while awaiting release

**Why are they mutually exclusive today?**

- **Custody + Inheritance, no Yield**: Multi-sig or social recovery can pass keys on, but locked assets sit idle earning nothing
- **Custody + Yield, no Inheritance**: DeFi vaults generate yield, but have zero inheritance logic — when the holder dies, keys are lost forever
- **Inheritance + Yield, no Custody**: Centralized custodians (exchanges, trusts) can handle succession and earn yield, but the holder surrenders private keys — no longer self-custodial

Dead-man's switches attempt to bridge custody and inheritance, but they use time-locks (time ≠ death) and still earn no yield. No existing solution solves all three simultaneously — until Yault.

## Landscape: Why Existing Solutions Fall Short

| Approach | Self-Custody | Yield | Auto Trigger | Low Trust Dependency | Revocable | Main Weakness |
|----------|:---:|:---:|:---:|:---:|:---:|---------------|
| Centralized Custodial Inheritance | — | Partial | — | — | — | Platform risk; policy changes; lock-up; not self-custody |
| Legal / Trust Custody | — | — | — | — | ~| Single point of trust; key exposure; slow; expensive |
| Multi-Sig Inheritance | Yes | Theoretical | — | ~ | ~ | Coordination burden; signer collusion; no yield management |
| MPC Custody | ~ | Yes | — | — | — | High cost; service disruption risk; still centralized nodes |
| Dead Man's Switch | Yes | — | Time-based | ~ | ~ | Time ≠ death; irreversible misfire; can't manage DeFi state |
| Social Recovery | Yes | Yes | — | ~ | Yes | Collusion risk; not true inheritance; no yield handoff |
| DeFi Vaults (non-inheritance) | Yes | Yes | — | Yes | Yes | No inheritance logic; liquidation risk; complex state |
| **Yault Guardian Vault** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | Hackathon build; requires production audit |

> Legend: Yes = fully supported, ~ = partial / depends, — = not supported

Yault is the only approach that combines self-custody, native yield, oracle-driven automatic triggers, low institutional dependency, and revocability in a single system.

## Our Approach

Yault is a **fully non-custodial** platform where no single party — not the platform, not the authority, not the recipient — can unilaterally access or move assets. The system is built entirely on cryptographic primitives:

| Layer | Mechanism |
|-------|-----------|
| Asset custody | Owner's wallet — keys never leave the client |
| Key protection | AES-256-GCM-SIV + Argon2id (ACE-GF framework) |
| Conditional release | E2E encryption — authority holds release share, not a key |
| Timelock fallback | drand BLS threshold IBE (tlock) |
| Attestation trigger | Chainlink CRE workflow → on-chain `ReleaseAttestation` |
| Portfolio valuation | Chainlink Data Feeds (AggregatorV3Interface) |
| Yield automation | Chainlink Automation (Keepers) for auto-harvesting |
| Cross-chain relay | Chainlink CCIP for attestation bridging |
| Off-chain analytics | Chainlink Functions for risk/APY computation |
| Yield management | ERC-4626 vault with auditable user/platform/authority split |
| Permanent storage | Arweave for encrypted release artifacts |

## How It Works

```
Owner                  Chainlink Oracle         Authority              Recipient
  │                         │                       │                      │
  │  1. Configure paths     │                       │                      │
  │  & deposit to vault     │                       │                      │
  │─────────────────────────┤                       │                      │
  │                         │  2. Attestation        │                      │
  │                         │  event written         │                      │
  │                         │  on-chain              │                      │
  │                         │──────────────────────> │                      │
  │                         │                       │  3. Cooldown +        │
  │                         │                       │  verify conditions    │
  │                         │                       │                      │
  │                         │                       │  4. Release           │
  │                         │                       │  encrypted share      │
  │                         │                       │─────────────────────>│
  │                         │                       │                      │  5. Decrypt & claim
  │                         │                       │                      │  assets
```

---

## How Chainlink Is Used

Yault integrates **five Chainlink services** as the orchestration and data backbone:

### 1. CRE Workflow — Attestation Pipeline (Core)
- **`oracle/workflow/`** — CRE workflow monitors conditions (cron + HTTP triggers), queries 4 external data sources (drand beacon, vault state, compliance API, Chainlink price feed), and writes attestation on-chain via EVM target
- Simulated via `cre workflow simulate` CLI and configured for Sepolia deployment

### 2. Chainlink Data Feeds — Real-Time Portfolio Valuation
- **`ChainlinkPriceFeedTracker.sol`** — Reads live prices from `AggregatorV3Interface` feeds for multi-vault USD valuation
- Stale price detection, NAV snapshots, multi-asset tracking

### 3. Chainlink Automation (Keepers) — Auto-Harvest Yield
- **`AutoHarvest.sol`** — Automation-compatible contract (`checkUpkeep` / `performUpkeep`) for batch yield harvesting
- Configurable thresholds and intervals; forwarder-aware access control

### 4. Chainlink CCIP — Cross-Chain Attestation Relay
- **`CrossChainVaultBridge.sol`** — Sends/receives attestation messages and position sync across chains via CCIP Router
- Replay protection, rate limiting, whitelisted senders, ETH/token withdrawal

### 5. Chainlink Functions — Off-Chain Portfolio Analytics
- **`PortfolioAnalytics.sol`** — Functions consumer that runs off-chain JS on the DON
- Computes risk score, APY, Sharpe ratio, max drawdown; results stored on-chain

### CRE Workflow Data Sources

| Data Source | Purpose | External Integration |
|-------------|---------|---------------------|
| **A — drand Beacon** | Timelock randomness for tlock-based fallback release | drand HTTP API |
| **B — Vault State** | Current vault asset state gate (`totalAssets()`) | EVM JSON-RPC `eth_call` |
| **C — Compliance Screen** | OFAC / sanctions check on recipient address | Yault compliance endpoint |
| **D — Price Feed Enrichment (optional)** | Chainlink Data Feed prices for evidence enrichment/freshness gating | Chainlink AggregatorV3 |

---

## Files Using Chainlink (Hackathon Requirement)

All code that uses Chainlink / CRE in this repo:

### CRE Workflow

| File | Role |
|------|------|
| [oracle/workflow/src/main.ts](oracle/workflow/src/main.ts) | CRE workflow — cron/HTTP triggers, 4 data sources (drand, vault, compliance, price feed), EVM write to `ReleaseAttestation` |
| [oracle/workflow/src/price-feed-enrichment.ts](oracle/workflow/src/price-feed-enrichment.ts) | Data Source D — Chainlink price feed enrichment for CRE workflow |
| [oracle/workflow/workflow.yaml](oracle/workflow/workflow.yaml) | CRE workflow definition config |
| [oracle/workflow/config.staging.json](oracle/workflow/config.staging.json) | Chain, contract, and external API config (template) |

### Chainlink Functions

| File | Role |
|------|------|
| [oracle/functions/portfolio-analytics.js](oracle/functions/portfolio-analytics.js) | Chainlink Functions JS source — executed on DON for off-chain analytics (risk score, APY, Sharpe ratio, max drawdown) |

### Smart Contracts (Chainlink Integrations)

| File | Role |
|------|------|
| [contracts/src/ChainlinkPriceFeedTracker.sol](contracts/src/ChainlinkPriceFeedTracker.sol) | Chainlink Data Feeds — real-time portfolio valuation via `AggregatorV3Interface` |
| [contracts/src/AutoHarvest.sol](contracts/src/AutoHarvest.sol) | Chainlink Automation — auto-harvest vault yield (`checkUpkeep` / `performUpkeep`) |
| [contracts/src/CrossChainVaultBridge.sol](contracts/src/CrossChainVaultBridge.sol) | Chainlink CCIP — cross-chain attestation relay and position sync |
| [contracts/src/PortfolioAnalytics.sol](contracts/src/PortfolioAnalytics.sol) | Chainlink Functions — off-chain analytics consumer |
| [contracts/src/ReleaseAttestation.sol](contracts/src/ReleaseAttestation.sol) | On-chain attestation contract; `oracleSubmitter` receives attestations from CRE Forwarder |

### Chainlink Interfaces

| File | Role |
|------|------|
| [contracts/src/interfaces/IChainlinkPriceFeed.sol](contracts/src/interfaces/IChainlinkPriceFeed.sol) | AggregatorV3Interface for Data Feeds |
| [contracts/src/interfaces/IAutomationCompatible.sol](contracts/src/interfaces/IAutomationCompatible.sol) | Automation-compatible interface (Keepers) |
| [contracts/src/interfaces/ICCIPRouter.sol](contracts/src/interfaces/ICCIPRouter.sol) | CCIP Router + Client library interfaces |
| [contracts/src/interfaces/IFunctionsClient.sol](contracts/src/interfaces/IFunctionsClient.sol) | Functions Router + Client interfaces |

### Deployment & Tests

| File | Role |
|------|------|
| [contracts/script/DeployChainlinkIntegrations.s.sol](contracts/script/DeployChainlinkIntegrations.s.sol) | Foundry deployment script for all 4 Chainlink contracts |
| [contracts/test/ChainlinkPriceFeedTracker.t.sol](contracts/test/ChainlinkPriceFeedTracker.t.sol) | Forge tests for Data Feeds tracker |
| [contracts/test/AutoHarvest.t.sol](contracts/test/AutoHarvest.t.sol) | Forge tests for Automation harvester |
| [contracts/test/CrossChainVaultBridge.t.sol](contracts/test/CrossChainVaultBridge.t.sol) | Forge tests for CCIP bridge |
| [contracts/test/PortfolioAnalytics.t.sol](contracts/test/PortfolioAnalytics.t.sol) | Forge tests for Functions analytics |

### Backend (Chainlink-Related)

| File | Role |
|------|------|
| [server/api/trigger/oracle.js](server/api/trigger/oracle.js) | Reads attestation events, creates triggers; `simulate-chainlink` for demo |
| [server/api/compliance/screen.js](server/api/compliance/screen.js) | Compliance screening endpoint (Data Source C used by CRE workflow) |
| [server/api/portfolio/tracker.js](server/api/portfolio/tracker.js) | Portfolio tracker API — exposes Chainlink price feed valuations |
| [server/services/attestationGate.js](server/services/attestationGate.js) | Gates release on oracle vs fallback attestation source |
| [server/services/attestationSubmitter.js](server/services/attestationSubmitter.js) | Submits oracle-source attestations (used by simulate-chainlink) |

See [oracle/workflow/README.md](oracle/workflow/README.md) for CRE setup and simulation instructions.

---

## CRE Simulation & On-Chain Evidence

### Running CRE Simulation

```bash
# Install CRE CLI
npm install -g @chainlink/cre-cli

# Run one-shot simulation
cd oracle/workflow
cre workflow simulate . --target staging
```

### On-Chain Write Evidence

> **Testnet:** Ethereum Sepolia
> **Contract:** `ReleaseAttestation` — deployed at `0x410D42eAf9D0Ca036664eFE1E866a12d9f0fdc19`
> **Explorer:** [Sepolia Etherscan](https://sepolia.etherscan.io/address/0x410D42eAf9D0Ca036664eFE1E866a12d9f0fdc19)

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Smart Contracts | Solidity 0.8.28 · Foundry · OpenZeppelin |
| Chainlink Data Feeds | AggregatorV3Interface — real-time price oracles |
| Chainlink Automation | Keepers — auto-harvest yield |
| Chainlink CCIP | Cross-chain messaging — attestation relay |
| Chainlink Functions | DON off-chain compute — portfolio analytics |
| Chainlink CRE | Workflow orchestration — attestation pipeline |
| Backend | Node.js · Express · sql.js |
| Cryptography (WASM) | Rust · wasm-pack · X25519 · AES-GCM-SIV |
| Frontend | Vanilla JS · Web3 wallet connect |
| Storage | Arweave · AO |
| Timelock | drand network · tlock-js |
| Testnet | Ethereum Sepolia |

## Smart Contracts

| Contract | Purpose |
|----------|---------|
| `YaultVault.sol` | ERC-4626 yield vault with platform/authority fee split |
| `YaultVaultFactory.sol` | Factory for deploying per-asset vaults |
| `ReleaseAttestation.sol` | On-chain attestation record (oracle + fallback submitter) |
| `YaultPathClaim.sol` | Path-based asset claim with hash verification |
| `VaultShareEscrow.sol` | Escrow for vault shares pending recipient claim |
| `ChainlinkPriceFeedTracker.sol` | Real-time portfolio valuation via Chainlink Data Feeds |
| `AutoHarvest.sol` | Automated yield harvesting via Chainlink Automation |
| `CrossChainVaultBridge.sol` | Cross-chain attestation relay via Chainlink CCIP |
| `PortfolioAnalytics.sol` | Off-chain analytics via Chainlink Functions |

## Repository Structure

```
yault/
├── contracts/           # Solidity contracts (Foundry)
│   ├── src/             #   Contract source (9 contracts + interfaces)
│   ├── test/            #   Forge tests (8 test files)
│   └── script/          #   Deployment scripts
├── server/              # Express API backend
│   ├── api/             #   Route handlers (auth, trigger, release, vault, portfolio, etc.)
│   ├── services/        #   Business logic (attestation, escrow, chain provider)
│   └── config/          #   Environment & chain config
├── webapp/              # Web application (owner / authority / ops portals)
│   └── public/
│       ├── js/          #   Portal JS (client, authority, ops)
│       └── wasm/        #   Compiled WASM modules
├── wasm-core/           # Rust/WASM cryptographic primitives
│   └── src/custody/     #   AdminFactor, E2E encryption
├── oracle/              # Chainlink integrations
│   ├── workflow/        #   CRE workflow (TypeScript) + config
│   └── functions/       #   Chainlink Functions JS source
├── client/              # JS client SDK (release logic, tlock, Arweave NFT)
├── tests/               # Integration & unit tests
│   ├── integration/     #   API + flow tests
│   └── unit/            #   Module-level tests
├── env/                 # Environment configs (dev / test / production)
└── docs/                # Architecture & design docs
```

## Quick Start

### Prerequisites

- Node.js >= 18
- Rust + wasm-pack (for WASM build, optional)
- Foundry (for contract compilation/testing, optional)
- CRE CLI (for Chainlink workflow simulation)

### 1. Install & configure

```bash
npm install
cp .env.example .env
# Edit .env with your keys (see comments in .env.example)
```

### 2. Start the server

```bash
npm run dev
# Server starts at http://localhost:3001
# Web app served at /
# API endpoints at /api/*
```

### 3. Run tests

```bash
# All tests
npm run test:all

# Individual test suites
npm run test:js          # Jest — integration & unit tests
npm run test:contracts   # Forge — Solidity tests
npm run test:wasm        # Cargo — Rust/WASM tests
```

### 4. Build WASM (optional)

```bash
npm run build:wasm:webapp   # Build Rust → WASM and copy to webapp/public/wasm
```

### Docker

```bash
docker compose up          # Starts API server + ArLocal (local Arweave)
```

## End-to-End Demo Flow

1. **Owner** configures recipient paths and deposits assets into the vault
2. **Chainlink CRE workflow** monitors conditions (drand beacon, vault state, compliance screen, price feeds) and writes an attestation on-chain
3. **Chainlink Automation** auto-harvests accrued yield based on configurable thresholds
4. **Chainlink Data Feeds** provide real-time portfolio valuation across all tracked vaults
5. **Platform** reads the attestation event and creates a trigger (enters cooldown)
6. **Authority** verifies conditions and submits encrypted release share
7. **Recipient** decrypts share and claims released assets
8. **Chainlink CCIP** relays attestations cross-chain for multi-chain positions
9. **Chainlink Functions** computes risk scores, APY, Sharpe ratio on the DON
10. **Audit** — yield split records visible for user / platform / authority

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Chainlink CRE Workflow                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ drand    │  │ Vault    │  │ Compliance│  │ Price Feed        │  │
│  │ Beacon   │  │ State    │  │ Screen   │  │ Enrichment        │  │
│  │ (Src A)  │  │ (Src B)  │  │ (Src C)  │  │ (Src D)           │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬──────────────┘  │
│       └──────────────┼───────────  │  ───────────┘                  │
│                      ▼                                              │
│              ┌───────────────┐                                      │
│              │ EVM Write     │                                      │
│              │ (Attestation) │                                      │
│              └───────┬───────┘                                      │
└──────────────────────┼──────────────────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      On-Chain (Ethereum Sepolia)                     │
│                                                                      │
│  ┌────────────────────┐  ┌────────────────────────────────────────┐  │
│  │ ReleaseAttestation │  │ ChainlinkPriceFeedTracker              │  │
│  │ (CRE → on-chain)   │  │ (Data Feeds → USD valuation)          │  │
│  └────────────────────┘  └────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────┐  ┌────────────────────────────────────────┐  │
│  │ AutoHarvest        │  │ CrossChainVaultBridge                  │  │
│  │ (Automation/Keepers)│  │ (CCIP cross-chain relay)              │  │
│  └────────────────────┘  └────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────┐  ┌────────────────────────────────────────┐  │
│  │ PortfolioAnalytics │  │ YaultVault + Escrow + PathClaim       │  │
│  │ (Functions/DON)    │  │ (Core vault logic)                    │  │
│  └────────────────────┘  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Security Notes

- This is a hackathon build; third-party security audits are required before production deployment
- No private keys or assets are held server-side — fully non-custodial architecture
- Authority holds only an encrypted share with zero standalone cryptographic capability

### Security Environment Variables

The following env vars control the latest backend hardening behavior:

| Variable | Default | Description | Recommended (Production) |
|----------|---------|-------------|---------------------------|
| `ADMIN_SESSION_IP_PINNING` | `false` | When `true`, admin session tokens are bound to the originating client IP. Requests from a different IP are rejected. | Set to `true` behind a stable reverse proxy/load balancer. |
| `MULTISIG_REQUEST_WINDOW_MS` | `60000` | Time window (ms) for per-admin/per-IP multi-sig action rate limiting. | Keep `60000` or increase slightly for high-latency ops networks. |
| `MULTISIG_MAX_REQUESTS_PER_WINDOW` | `24` | Max multi-sig requests per action, per admin address and IP, inside the window. | Lower for stricter abuse resistance (e.g. `10`-`20`). |
| `ARWEAVE_GATEWAY_ALLOWLIST` | `https://arweave.net,https://ar-io.net,https://arweave.developerdao.com,https://turbo-gateway.com` | Comma-separated list of allowed Arweave gateway hosts/URLs used for reads. Non-allowlisted gateways are blocked unless explicitly enabled. | Keep a minimal trusted list managed by ops. |
| `ARWEAVE_EXTRA_GATEWAYS` | empty | Optional extra Arweave gateways appended to fetch candidates (still checked against allowlist unless override is enabled). | Add only vetted gateways. |
| `ALLOW_UNLISTED_ARWEAVE_GATEWAYS` | `false` | If `true`, disables strict allowlist enforcement for Arweave gateways. | Keep `false`. Enable only for temporary debugging. |

Notes:
- `allowFallback` attestation source is now treated as an explicit emergency path in server policy code. Normal release checks default to oracle attestation source.
- If `ADMIN_SESSION_IP_PINNING=true`, ensure `X-Forwarded-For` is trustworthy and set correctly by your ingress/proxy.
- CRE-supported testnets only — no mainnet wallets, real funds, or production credentials used
- Demo includes controlled assumptions and mocked components where noted

## License

Proprietary — All rights reserved.
