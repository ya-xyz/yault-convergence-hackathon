# Emergency Response & Migration Policy

> Version: 0.1 | Date: 2026-03-08 | Status: Policy Draft

---

## Purpose

Yault contracts are **immutable** (no proxy or upgrade patterns). This is a deliberate security decision — it eliminates upgrade-related attack vectors — but it means that bugs, exploits, or compromised dependencies can only be addressed through migration. This document defines the emergency response framework and migration procedures.

---

## 1. Incident Severity Classification

| Severity | Definition | Examples | Response Time |
|----------|-----------|----------|:---:|
| **P0 — Critical** | Active exploit; user funds at immediate risk | Reentrancy exploit, oracle manipulation draining funds | < 15 minutes |
| **P1 — High** | Vulnerability discovered but not yet exploited | Logic bug allowing unauthorized withdrawals, access control bypass | < 4 hours |
| **P2 — Medium** | Degraded functionality; no fund risk | Oracle staleness, failed auto-harvests, analytics downtime | < 24 hours |
| **P3 — Low** | Minor issue; cosmetic or non-critical | Incorrect event data, UI display errors | Next business day |

---

## 2. Emergency Response Procedures

### 2.1 P0 — Active Exploit Response

```
1. PAUSE — Owner calls pause() immediately (Tier 0, no timelock)
     ↓
2. ASSESS — Determine scope: which vaults, which users, how much at risk
     ↓
3. CONTAIN — If strategy is compromised: withdrawFromStrategy() to pull funds from Aave
           — If fee recipient is compromised: setPlatformFeeRecipient() to safe address
     ↓
4. COMMUNICATE — Post incident notice to all channels within 30 minutes
     ↓
5. REMEDIATE — Deploy patched contract, initiate migration (see Section 3)
     ↓
6. POST-MORTEM — Publish full incident report within 7 days
```

### 2.2 P1 — Vulnerability Response

```
1. VERIFY — Reproduce the vulnerability in a forked environment
     ↓
2. ASSESS — Determine if it can be exploited under current conditions
     ↓
3. DECIDE — Pause if exploitation path is practical; continue monitoring if theoretical
     ↓
4. FIX — Develop and audit the fix
     ↓
5. MIGRATE — Deploy patched contract and migrate users (see Section 3)
     ↓
6. DISCLOSE — Publish vulnerability details after migration is complete
```

### 2.3 Emergency Contacts & Roles

| Role | Responsibility | Authorization |
|------|---------------|---------------|
| **Incident Commander** | Coordinates response, makes pause/unpause decisions | Multisig signer |
| **Security Lead** | Analyzes vulnerability, develops fix | Core team |
| **Communications Lead** | Manages public disclosure | Core team |
| **External Auditor** | Reviews fix before redeployment | Retained audit firm |

---

## 3. Migration Procedures

Since contracts are immutable, migration to a patched contract requires user action or an assisted process.

### 3.1 Migration Architecture

```
Old Vault (paused)          New Vault (patched)
┌──────────────────┐        ┌──────────────────┐
│  User deposits   │        │                  │
│  Strategy funds  │  ───►  │  User deposits   │
│  Escrowed revenue│        │  Strategy funds   │
│  Principal data  │        │  Escrowed revenue │
└──────────────────┘        └──────────────────┘
         │                           ▲
         │    Migration Contract     │
         └──────────────────────────┘
           1. Withdraw from old
           2. Deposit to new
           3. Preserve principal tracking
```

### 3.2 Migration Steps

1. **Pause** the old vault — blocks new deposits
2. **Withdraw from strategy** — pull all Aave funds back to vault (`withdrawFromStrategy()`)
3. **Deploy** the patched vault contract
4. **Verify** the new contract on Etherscan + Sourcify (per Code Auditability Policy)
5. **Deploy migration helper** — a contract that atomically:
   - Redeems shares from old vault on user's behalf (requires user approval)
   - Deposits underlying into new vault
   - Preserves `userPrincipal` mapping via constructor or initialization
6. **Migrate escrowed authority revenue** — owner sweeps escrowed amounts and re-deposits
7. **Update integrations** — AutoHarvest targets, PriceFeedTracker registrations, bridge configurations
8. **Deprecate** old vault — leave paused permanently with a pointer to new vault

### 3.3 User Communication During Migration

| Timeline | Action |
|----------|--------|
| T+0 | Announce migration with reason, new contract address, and timeline |
| T+24h | Migration helper contract deployed and verified |
| T+48h | Guided migration available via UI |
| T+7d | Reminder to remaining users |
| T+30d | Final reminder; old vault remains paused indefinitely |

### 3.4 Data Preservation Checklist

| Data | Source | Migration Method |
|------|--------|-----------------|
| User principal (`userPrincipal`) | Old vault | Snapshot and seed into new vault constructor or migration tx |
| Authority bindings (`_revenueConfigs`) | Old vault + off-chain DB | Re-bind in new vault; users must re-confirm |
| Escrowed authority revenue | Old vault | Owner withdraws and re-escrows in new vault |
| Harvest history | Events on old vault | No migration needed; historical events remain on-chain |
| AutoHarvest targets | AutoHarvest contract | Re-register targets for new vault |
| Price feed registrations | PriceFeedTracker | Re-register new vault address |
| Attestations | ReleaseAttestation | Independent contract; no migration needed |

---

## 4. Bug Bounty Program

A bug bounty program SHOULD be established before mainnet launch to incentivize responsible disclosure.

### Recommended Structure

| Severity | Reward Range | Scope |
|----------|-------------|-------|
| Critical (fund loss) | $25,000 – $100,000 | YaultVault, VaultShareEscrow, CrossChainVaultBridge |
| High (privilege escalation) | $5,000 – $25,000 | All contracts |
| Medium (griefing, DoS) | $1,000 – $5,000 | All contracts |
| Low (informational) | $100 – $1,000 | All contracts + off-chain services |

### Platforms

- **Immunefi** (recommended — DeFi-focused, industry standard)
- **Code4rena** or **Sherlock** for competitive audit contests

---

## 5. Disaster Recovery for Off-Chain Components

### 5.1 Server Database

| Measure | Description |
|---------|-------------|
| Automated backups | Database snapshots every 6 hours, retained for 90 days |
| Geo-redundancy | Replicate to a secondary region |
| Recovery test | Monthly restore drill from backup |
| On-chain anchor | Critical decisions (attestations) are written on-chain; DB is supplementary |

### 5.2 Oracle Infrastructure

| Failure Mode | Response |
|-------------|----------|
| Chainlink price feed goes stale | `maxStaleness` check reverts; manual intervention to switch feeds |
| Chainlink CRE workflow down | Fallback attestation path via authorized entity submitters |
| Chainlink Functions unavailable | Analytics degrade gracefully; core vault operations unaffected |

---

## References

- [Ethereum Foundation — Smart Contract Security Best Practices](https://ethereum.org/en/developers/docs/smart-contracts/security/)
- [Immunefi Bug Bounty Platform](https://immunefi.com/)
- [OpenZeppelin Incident Response](https://docs.openzeppelin.com/defender/)
- [Trail of Bits — Building Secure Contracts](https://github.com/crytic/building-secure-contracts)
