# Code Auditability Policy

> Version: 0.1 | Date: 2026-03-08 | Status: Policy Draft

---

## Purpose

In Web3, trust cannot rely on verbal promises alone. Yault leverages blockchain immutability and third-party deterministic proofs to ensure that what users see in the source code is exactly what runs on-chain — **"what you see is what you get."**

This document defines four core pillars of Yault's code auditability framework.

---

## 1. Deterministic Builds

Identical source code can produce different bytecode depending on the compiler version, optimizer settings, and OS environment. Deterministic builds eliminate this ambiguity.

### Policy

- **Solidity Standard JSON Input**: All compilations MUST use the Solidity Standard JSON Input format, recording every compilation parameter (compiler version, optimizer settings, remappings, EVM target) in a reproducible manifest.
- **Foundry as the canonical build tool**: Yault uses Foundry with pinned configuration. Any machine running `forge build` with the same `foundry.toml` MUST produce identical bytecode.
- **Pinned compiler version**: The Solidity compiler version is locked (currently `0.8.28`) and MUST NOT be changed without a documented review.

### Current Configuration

```toml
# contracts/foundry.toml
[profile.default]
solc = "0.8.28"
via_ir = true
optimizer = true
optimizer_runs = 200
```

### Verification Steps

1. Clone the repository at the exact commit hash
2. Run `forge build` in the `contracts/` directory
3. Compare the resulting bytecode in `contracts/out/` against the on-chain deployed bytecode
4. The two MUST be byte-identical

---

## 2. On-Chain Code Verification (Etherscan)

Etherscan verification is the current market "gold standard" for proving code-to-deployment consistency.

### Policy

- **All deployed contracts MUST be verified on Etherscan** (or the equivalent block explorer for the target chain) within 24 hours of deployment.
- **Verification process**: Submit source code and compilation parameters to Etherscan. Etherscan recompiles with the provided parameters and confirms the resulting bytecode matches the on-chain bytecode byte-for-byte.
- **Blue checkmark**: Upon successful match, the contract address displays a verification badge. Anyone can read and interact with the verified source code directly in the browser.
- **Patent notice**: Since Yault has filed patent applications, all verified source files MUST include a patent notice header in the top-level contract comment:

```solidity
// SPDX-License-Identifier: [LICENSE]
// Patent Pending — [Patent Application Number]
// Copyright (c) 2026 Yault. All rights reserved.
// This code is open-source for transparency and auditability purposes.
```

### Verification Command

```bash
forge verify-contract <DEPLOYED_ADDRESS> src/YaultVault.sol:YaultVault \
  --chain-id <CHAIN_ID> \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --watch
```

### Requirements

| Item | Requirement |
|------|-------------|
| Timing | Within 24 hours of deployment |
| Scope | All production contracts (vault, attestation, oracle, bridge) |
| Constructor args | Must be ABI-encoded and submitted with verification |
| Proxy contracts | Both proxy and implementation must be independently verified |

---

## 3. Decentralized Verification (Sourcify)

Etherscan is a centralized service. If it shuts down, verification records are lost. Sourcify provides a decentralized, permanent alternative.

### Policy

- **All deployed contracts MUST also be verified on Sourcify** as a redundant verification layer.
- **Metadata stored on IPFS**: Sourcify stores the contract's Metadata (compilation environment, source code, ABI) on IPFS, ensuring permanent availability independent of any single service.
- **Full Match required**: Sourcify performs a stricter "Full Match" verification — it not only verifies code logic, but also confirms that the Metadata hash appended to the on-chain bytecode matches the submitted Metadata hash. This provides a higher-dimensional trust guarantee than Etherscan alone.

### Verification Levels

| Level | What it proves | Required? |
|-------|---------------|-----------|
| **Partial Match** | Source code compiles to the same creation bytecode | Minimum |
| **Full Match** | Source code + Metadata hash match the on-chain bytecode appendix | **Required for Yault** |

### Verification Command

```bash
forge verify-contract <DEPLOYED_ADDRESS> src/YaultVault.sol:YaultVault \
  --chain-id <CHAIN_ID> \
  --verifier sourcify
```

### Why Both Etherscan and Sourcify?

| Property | Etherscan | Sourcify |
|----------|-----------|---------|
| Accessibility | High (widely used UI) | Moderate (less mainstream) |
| Centralization risk | Yes (single company) | No (IPFS-backed) |
| Metadata verification | No | Yes (Full Match) |
| Permanence | Dependent on Etherscan | IPFS-pinned |
| User familiarity | Very high | Growing |

Using both provides: **broad accessibility** (Etherscan) + **permanent, decentralized trust** (Sourcify).

---

## 4. Automation and Third-Party Audit Disclosure

Manual verification is error-prone and non-repeatable. Yault implements automated pipelines to enforce auditability at every code change.

### 4.1 CI/CD Verification Pipeline

**Policy**: Every push to the `main` branch MUST trigger an automated verification pipeline.

**Pipeline stages:**

```
Push to main
    │
    ▼
┌─────────────────────────────┐
│  1. Compile (forge build)   │  Deterministic build
├─────────────────────────────┤
│  2. Test (forge test)       │  Full test suite passes
├─────────────────────────────┤
│  3. Bytecode diff           │  Compare output against
│                             │  deployed on-chain bytecode
├─────────────────────────────┤
│  4. Verify on Etherscan     │  Auto-submit if new
│     + Sourcify              │  deployment detected
├─────────────────────────────┤
│  5. Generate build report   │  Commit hash, bytecode hash,
│                             │  compiler version, timestamp
└─────────────────────────────┘
```

**Build report artifact** (generated per deployment):

```json
{
  "contract": "YaultVault",
  "address": "0x...",
  "chainId": 11155111,
  "commitHash": "abc1234",
  "solcVersion": "0.8.28",
  "optimizerRuns": 200,
  "viaIR": true,
  "bytecodeHash": "0x...",
  "etherscanVerified": true,
  "sourcifyFullMatch": true,
  "timestamp": "2026-03-08T12:00:00Z"
}
```

### 4.2 Third-Party Audit Report Disclosure

**Policy**: All audit reports MUST be publicly linked and anchored to specific code versions.

| Requirement | Description |
|-------------|-------------|
| **Git commit hash binding** | Every audit report MUST specify the exact Git commit hash that was audited |
| **Public availability** | Reports are stored in this repository (`docs/security-audit-report.md`) and linked from the web application |
| **UI integration** | The Yault web application MUST display contract addresses as hyperlinks to their Etherscan verified source page |
| **Audit scope clarity** | Reports MUST clearly state which contracts were in scope and which were excluded |
| **Remediation tracking** | Findings and their resolution status MUST be tracked publicly |

### 4.3 Trust Chain Summary

The complete trust chain from source code to user-facing application:

```
Developer writes code
    │
    ▼
GitHub repository (public, version-controlled)
    │
    ▼
CI/CD compiles deterministically (pinned Foundry + Solidity)
    │
    ▼
Bytecode deployed to chain (immutable, timestamped)
    │
    ▼
Etherscan verification (centralized, high-visibility)
    │
    ▼
Sourcify verification (decentralized, IPFS-permanent)
    │
    ▼
Third-party audit report (anchored to Git commit hash)
    │
    ▼
User sees: verified source ← matches on-chain bytecode ← matches audited code
```

---

## Implementation Status

| Pillar | Status | Notes |
|--------|--------|-------|
| Deterministic builds (Foundry) | Implemented | `foundry.toml` pinned, `solc 0.8.28` |
| Etherscan verification | Partial | Testnet contracts verified; mainnet pending |
| Sourcify verification | Not started | To be added alongside mainnet deployment |
| CI/CD pipeline | Not started | GitHub Actions workflow to be implemented |
| Audit report linking | Implemented | `docs/security-audit-report.md` available |
| UI contract links | Not started | To be integrated into Portfolio page |

---

## References

- [Solidity Standard JSON Input](https://docs.soliditylang.org/en/v0.8.28/using-the-compiler.html#input-description)
- [Foundry Verification Docs](https://book.getfoundry.sh/reference/forge/forge-verify-contract)
- [Sourcify Documentation](https://docs.sourcify.dev/)
- [Etherscan Verification](https://docs.etherscan.io/tutorials/verifying-contracts-programmatically)
- [Yault Security Audit Report](../security-audit-report.md)
