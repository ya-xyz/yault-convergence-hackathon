# Auditability — Outstanding Work Items

> Last updated: 2026-03-08 | Maintained by: Core Team

This document tracks all transparency and auditability improvements that have been identified but not yet implemented. Items are prioritized by their impact on user trust and protocol verifiability.

---

## Legend

| Priority | Meaning |
|:---:|---------|
| **P0** | Must complete before mainnet launch |
| **P1** | Should complete within 30 days of mainnet |
| **P2** | Target for next major release |

---

## 1. Event & Logging Gaps

All state-changing operations MUST emit events to enable third-party monitoring, indexing, and forensic analysis. The following gaps have been identified.

### 1.1 Missing Events in YaultVault.sol

| # | Function / Hook | State Change | Priority | Notes |
|---|----------------|-------------|:---:|-------|
| E-01 | `_deposit()` hook | `userPrincipal[user]` increases | **P0** | Deposits are currently silent on-chain. Emit `PrincipalUpdated(user, oldPrincipal, newPrincipal, isDeposit)` or similar. Without this, no external tool (Tenderly, Dune, TheGraph) can track deposit activity. |
| E-02 | `_withdraw()` hook | `userPrincipal[user]` decreases | **P0** | Same as E-01 for withdrawals. ERC-4626 `Withdraw` event exists but does not capture principal tracking. A custom event is needed. |
| E-03 | `sweepUnderlying()` | Tokens transferred to arbitrary address | **P0** | Owner can move excess underlying tokens without any on-chain log. Emit `UnderlyingSwept(amount, to)`. |
| E-04 | `sweepToken()` | ERC-20 transferred to arbitrary address | **P0** | Same as E-03 for non-vault tokens. Emit `TokenSwept(token, amount, to)`. |
| E-05 | `_update()` transfer block | Share transfer silently reverted | **P2** | Non-exempt share transfers revert but leave no trace. Consider emitting `TransferBlocked(from, to, amount)` for monitoring blocked transfer attempts (note: this would require changing the revert to an event + return pattern, which may not be desirable). |

### 1.2 Event Quality Improvements

| # | Event | Issue | Priority |
|---|-------|-------|:---:|
| E-06 | `YieldHarvested` | Does not include the yield amount (total) or user's new principal. Adding these would make the event self-contained for indexers. | **P1** |
| E-07 | `InvestedToStrategy` / `WithdrawnFromStrategy` | Does not include the resulting idle balance or strategy balance. Useful for dashboards. | **P2** |

---

## 2. On-Chain / Off-Chain State Reconciliation

The server database (SQLite/Postgres) stores critical state that has no on-chain counterpart or verification anchor. This creates a trust gap.

### 2.1 State Reconciliation Mechanisms Needed

| # | Off-Chain Data | On-Chain Anchor | Gap | Priority | Recommended Approach |
|---|---------------|----------------|-----|:---:|----|
| S-01 | Authority profiles (name, contact, fee config) | Only `authorityAddress` stored on-chain | Authority identity not verifiable on-chain | **P1** | Publish a Merkle root of authority registry on-chain periodically; allow anyone to verify inclusion. |
| S-02 | Trigger events (death certificates, court orders) | `ReleaseAttestation.evidenceHash` | Evidence hash exists but no standard for what it hashes | **P0** | Define and publish the evidence hashing schema (e.g., `keccak256(abi.encodePacked(documentType, documentHash, issuingAuthority, issueDate))`). |
| S-03 | Revenue records (off-chain DB) | `pendingAuthorityRevenue`, `YieldHarvested` events | Off-chain records may diverge from on-chain state | **P1** | Implement a periodic reconciliation job that compares DB revenue records against on-chain events and flags discrepancies. |
| S-04 | User-authority bindings (off-chain DB) | `_revenueConfigs[user]` on-chain | DB stores richer binding metadata not on-chain | **P1** | Treat on-chain `_revenueConfigs` as the source of truth; DB is a cache/index. Add a sync-check endpoint. |
| S-05 | KYC status | None | Entirely off-chain; no on-chain representation | **P2** | Consider a privacy-preserving KYC attestation (e.g., ZK proof of KYC completion) or at minimum publish a commitment hash. |

### 2.2 Reconciliation Infrastructure

| # | Task | Priority |
|---|------|:---:|
| S-06 | Build an indexer (TheGraph subgraph or Ponder) that indexes all vault events into a queryable database | **P0** |
| S-07 | Create a `/api/health/reconciliation` endpoint that compares off-chain DB state with on-chain event-derived state | **P1** |
| S-08 | Publish reconciliation reports (automated, daily) to a public dashboard or IPFS | **P2** |

---

## 3. Oracle Trust Model Documentation

Yault depends on multiple Chainlink services. The trust assumptions for each MUST be explicitly documented.

| # | Task | Priority |
|---|------|:---:|
| O-01 | Document the trust model for Chainlink Price Feeds: What happens if a feed returns stale/incorrect data? What is the fallback? How does `maxStaleness` protect users? | **P0** |
| O-02 | Document the trust model for Chainlink Functions (PortfolioAnalytics): The `handleOracleFulfillment()` callback accepts results without cryptographic proof. What are the implications? Can analytics results be spoofed by the DON? | **P1** |
| O-03 | Document the trust model for Chainlink CRE Workflow (oracle attestations): How is the off-chain trigger condition verified? Who can submit? What prevents a compromised oracle from issuing false release attestations? | **P0** |
| O-04 | Define an oracle failure playbook: If Chainlink goes down, what functions degrade? What manual interventions are available? Reference the fallback attestation path. | **P1** |
| O-05 | Evaluate adding a secondary oracle (e.g., Pyth, Redstone, API3) as a fallback for price feeds. At minimum, document why a single oracle is or isn't acceptable. | **P2** |

---

## 4. CI/CD Verification Pipeline

Per the [Code Auditability Policy](code-auditability-policy.md), a CI/CD pipeline is required but not yet implemented.

| # | Task | Priority |
|---|------|:---:|
| C-01 | Implement GitHub Actions workflow: `forge build` → `forge test` → bytecode diff against deployed contracts | **P0** |
| C-02 | Add automated Etherscan verification step to CI/CD on deployment | **P0** |
| C-03 | Add automated Sourcify verification step to CI/CD on deployment | **P1** |
| C-04 | Generate and publish build report artifacts (JSON) per the Code Auditability Policy spec | **P1** |
| C-05 | Implement bytecode drift detection: periodically compare on-chain bytecode against latest build output | **P2** |

---

## 5. Public Transparency Dashboard

Users should be able to verify protocol state without reading Solidity or using Etherscan directly.

| # | Task | Priority |
|---|------|:---:|
| D-01 | Build a public-facing transparency page showing: total TVL, fee recipient address, pause status, strategy allocation, last harvest times | **P1** |
| D-02 | Display contract addresses as clickable links to Etherscan verified source | **P1** |
| D-03 | Show pending timelock transactions (once timelock is implemented per Governance policy) | **P1** |
| D-04 | Display multisig signer addresses and threshold (once multisig is implemented) | **P1** |
| D-05 | Historical fee distribution chart sourced from on-chain `YieldHarvested` events | **P2** |

---

## 6. Additional Audit & Verification

| # | Task | Priority |
|---|------|:---:|
| A-01 | Establish a bug bounty program on Immunefi before mainnet launch (see [Emergency Response Policy](../governance/EMERGENCY_RESPONSE.md)) | **P0** |
| A-02 | Commission a second independent audit focused on the harvest/fee logic and authority escrow mechanism | **P1** |
| A-03 | Conduct a formal verification of the yield split arithmetic (USER_SHARE + PLATFORM_SHARE invariant, rounding behavior) | **P2** |
| A-04 | Add Slither and Mythril to CI/CD for automated static analysis on every PR | **P1** |
| A-05 | Implement invariant/fuzz tests for: total assets = user shares + escrowed revenue + strategy balance | **P0** |

---

## Summary by Priority

| Priority | Count | Categories |
|:---:|:---:|------------|
| **P0** | 11 | Missing events (E-01–E-04), evidence schema (S-02), indexer (S-06), oracle trust docs (O-01, O-03), CI/CD (C-01, C-02), bug bounty (A-01), invariant tests (A-05) |
| **P1** | 14 | Event quality, state reconciliation, oracle docs, CI/CD reports, transparency dashboard, second audit, static analysis |
| **P2** | 8 | Transfer blocking events, KYC attestation, reconciliation reports, secondary oracle, bytecode drift, formal verification, fee charts |

---

## Process

- Items are added as gaps are identified during development, audits, or community review
- Priority is re-evaluated at least monthly
- Completed items are moved to a `## Completed` section at the bottom with completion date
- Each item should reference the PR or commit that resolves it

---

## Completed

_No items completed yet._
