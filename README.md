# Yault Guardian Vault

**Self-custodial inheritance and conditional asset release with auditable yield sharing, powered by Chainlink-triggered attestations.**

> Hackathon Tracks: Risk & Compliance | DeFi & Tokenization

---

## Problem

Crypto inheritance and conditional release systems today face a trilemma:

1. **Custodial trust** — traditional solutions require handing keys to a third party
2. **Weak enforcement** — purely social or legal mechanisms have no on-chain teeth
3. **No audit trail** — release decisions are opaque and hard to verify after the fact

## Our Approach

Yault is a **fully non-custodial** platform where no single party — not the platform, not the authority, not the recipient — can unilaterally access or move assets. The system is built entirely on cryptographic primitives:

| Layer | Mechanism |
|-------|-----------|
| Asset custody | Owner's wallet — keys never leave the client |
| Key protection | AES-256-GCM-SIV + Argon2id (ACE-GF framework) |
| Conditional release | Shamir Secret Sharing — authority holds a share, not a key |
| Timelock fallback | drand BLS threshold IBE (tlock) |
| Attestation trigger | Chainlink oracle workflow → on-chain `ReleaseAttestation` |
| Yield management | ERC-4626 vault with auditable user/platform/authority split |
| Permanent storage | Arweave for encrypted release artifacts |

**Core insight:** authorities in this system are equivalent to drand BLS signing nodes — they hold a protocol share with zero standalone capability. A threshold must be reached before any operation can execute.

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
  │                         │                       │  4. Release Shamir    │
  │                         │                       │  share (factor)       │
  │                         │                       │─────────────────────>│
  │                         │                       │                      │  5. Combine factors
  │                         │                       │                      │  & claim assets
```

## How Chainlink Is Used

1. **Oracle workflow** (`oracle/workflow/`) — CRE workflow monitors conditions and produces attestation signals
2. **On-chain attestation** (`contracts/src/ReleaseAttestation.sol`) — immutable attestation record written by the oracle
3. **Trigger pipeline** (`server/api/trigger/oracle.js`) — platform reads attestation events and creates cooldown-gated triggers

This provides trusted, externalized attestation input — separating event source, policy execution, and custody logic.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Smart Contracts | Solidity 0.8.28 · Foundry · OpenZeppelin |
| Backend | Node.js · Express · sql.js |
| Cryptography (WASM) | Rust · wasm-pack · X25519 · AES-GCM-SIV · Shamir |
| Frontend | Vanilla JS · Web3 wallet connect |
| Oracle | Chainlink CRE workflow (TypeScript) |
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

## Repository Structure

```
yault/
├── contracts/           # Solidity contracts (Foundry)
│   ├── src/             #   Contract source
│   ├── test/            #   Forge tests
│   └── script/          #   Deployment scripts
├── server/              # Express API backend
│   ├── api/             #   Route handlers (auth, trigger, release, vault, etc.)
│   ├── services/        #   Business logic (attestation, escrow, chain provider)
│   └── config/          #   Environment & chain config
├── webapp/              # Web application (owner / authority / ops portals)
│   └── public/
│       ├── js/          #   Portal JS (client, authority, ops)
│       └── wasm/        #   Compiled WASM modules
├── wasm-core/           # Rust/WASM cryptographic primitives
│   └── src/custody/     #   Shamir, AdminFactor, E2E encryption
├── oracle/              # Chainlink CRE oracle workflow
│   └── workflow/        #   TypeScript workflow + config
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
2. **Chainlink oracle** workflow monitors conditions and writes an attestation on-chain
3. **Platform** reads the attestation event and creates a trigger (enters cooldown)
4. **Authority** verifies conditions and submits release factors (Shamir shares)
5. **Recipient** combines factors and claims released assets
6. **Audit** — yield split records visible for user / platform / authority

## Security Notes

- This is a hackathon build; third-party security audits are required before production deployment
- No private keys or assets are held server-side — fully non-custodial architecture
- Authority holds only a Shamir share with zero standalone cryptographic capability
- Demo includes controlled assumptions and mocked components where noted

## License

Proprietary — All rights reserved.
