# Admin Privilege & Timelock Policy

> Version: 0.1 | Date: 2026-03-08 | Status: Policy Draft

---

## Purpose

This document defines the access control model, privilege boundaries, and timelock requirements for all owner-controlled functions across the Yault protocol. It follows the principle of **least privilege with defense-in-depth**, aligned with industry standards set by OpenZeppelin Defender, Compound Governor, and MakerDAO's governance framework.

---

## 1. Current Access Control Model

All Yault contracts inherit OpenZeppelin `Ownable`. The `owner` address has unilateral control over administrative functions. There is currently **no multisig or DAO governance** layer.

### 1.1 Owner-Controlled Functions — Full Inventory

#### YaultVault.sol (Core Vault)

| Function | Impact | Current Delay | Risk Level |
|----------|--------|:---:|:---:|
| `setPlatformFeeRecipient(address)` | Redirects all future platform revenue | Immediate | **Critical** |
| `setMinHarvestYield(uint256)` | Changes dust-filter threshold | Immediate | Low |
| `pause()` | Blocks all new deposits | Immediate | High |
| `unpause()` | Re-enables deposits | Immediate | Medium |
| `setTransferExempt(address, bool)` | Whitelists addresses for share transfers | Immediate | Medium |
| `sweepUnderlying(uint256, address)` | Recovers excess underlying tokens | Immediate | **Critical** |
| `sweepToken(IERC20, address)` | Recovers non-vault ERC-20 tokens | Immediate | High |
| `setStrategy(address, address)` | Configures/changes Aave V3 strategy | Immediate | **Critical** |
| `investToStrategy(uint256)` | Deploys idle funds to Aave | Immediate | High |
| `withdrawFromStrategy(uint256)` | Pulls funds back from Aave | Immediate | High |
| `approveStrategyToken(uint256)` | Approves Aave aToken spending | Immediate | Medium |
| `harvestFor(address)` | Triggers harvest on behalf of user | Immediate | Medium |

#### YaultVaultFactory.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `createVault(...)` | Deploys new vault instance | Immediate |
| `setPlatformFeeRecipient(address)` | Sets default fee recipient for new vaults | Immediate |

#### ReleaseAttestation.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `setOracleSubmitter(address)` | Controls who can submit oracle attestations | Immediate |
| `setFallbackSubmitter(address, bool)` | Whitelists fallback attestation submitters | Immediate |

#### AutoHarvest.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `addTarget(address, address)` | Adds vault/user pair to auto-harvest list | Immediate |
| `removeTarget(uint256)` | Removes from auto-harvest list | Immediate |
| `setMinYieldThreshold(uint256)` | Configures minimum yield for auto-harvest | Immediate |
| `setMaxBatchSize(uint256)` | Limits batch size per execution | Immediate |
| `setAutomationForwarder(address)` | Sets Chainlink Automation address | Immediate |
| `harvestTarget(uint256)` | Manually triggers a specific harvest | Immediate |

#### ChainlinkPriceFeedTracker.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `registerVaultFeed(address, address)` | Links a vault to a Chainlink price feed | Immediate |
| `removeVaultFeed(address)` | Disconnects price feed | Immediate |
| `setMaxStaleness(uint256)` | Adjusts stale-price window | Immediate |
| `setEthUsdFeed(address)` | Sets ETH/USD reference feed | Immediate |

#### CrossChainVaultBridge.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `configureRemoteChain(...)` | Enables/disables cross-chain messaging | Immediate |
| `setCcipGasLimit(uint256)` | Configures CCIP gas parameter | Immediate |
| `setMinMessageInterval(uint256)` | Rate-limits cross-chain messages | Immediate |
| `withdrawETH(address, uint256)` | Withdraws ETH from bridge contract | Immediate |
| `withdrawToken(address, address, uint256)` | Withdraws ERC-20 from bridge contract | Immediate |

#### PortfolioAnalytics.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `setAnalyticsSource(string)` | Updates Chainlink Functions JavaScript source | Immediate |
| `setSubscriptionId(uint64)` | Changes Functions subscription | Immediate |
| `setDonId(bytes32)` | Changes DON identifier | Immediate |
| `setCallbackGasLimit(uint32)` | Adjusts callback gas | Immediate |
| `setMinRequestInterval(uint256)` | Rate-limits analytics requests | Immediate |

#### VaultShareEscrow.sol / YaultPathClaim.sol

| Function | Impact | Current Delay |
|----------|--------|:---:|
| `registerWallet(bytes32, address)` | Registers wallet owner for claims | Immediate |

---

## 2. Existing Timelock

Only **one** timelock mechanism exists today:

- **Authority address change** (user-initiated, not admin): After the first-time binding, subsequent changes to a user's authority address require a **2-day waiting period** (`AUTHORITY_CHANGE_DELAY = 2 days`).
- Flow: `setAuthorityAddress()` → wait 2 days → `confirmAuthorityAddress()`

**No admin function has any timelock.**

---

## 3. Required Governance Improvements

### 3.1 Multisig Requirement (Priority: Critical)

The `owner` address for all production contracts MUST be a multisig wallet.

| Parameter | Requirement |
|-----------|-------------|
| Wallet type | Gnosis Safe (Safe{Wallet}) or equivalent audited multisig |
| Threshold | Minimum 3-of-5 signers for mainnet |
| Signer diversity | Signers MUST NOT share the same custodial infrastructure |
| Key management | At least 1 signer SHOULD use a hardware wallet |

### 3.2 Timelock Tiers (Priority: Critical)

All owner-controlled functions MUST be subject to a timelock proportional to their impact. The following tiers are recommended, modeled after Compound's `Timelock` and OpenZeppelin `TimelockController`:

| Tier | Delay | Applies To |
|------|-------|------------|
| **Tier 0 — Emergency** | No delay (multisig only) | `pause()` |
| **Tier 1 — Operational** | 6 hours | `unpause()`, `harvestFor()`, `addTarget()`, `removeTarget()`, parameter tuning (thresholds, gas limits, intervals) |
| **Tier 2 — Significant** | 48 hours | `setPlatformFeeRecipient()`, `setStrategy()`, `investToStrategy()`, `withdrawFromStrategy()`, `setOracleSubmitter()`, `setFallbackSubmitter()`, `configureRemoteChain()` |
| **Tier 3 — Critical** | 7 days | `sweepUnderlying()`, `sweepToken()`, `withdrawETH()`, `withdrawToken()`, `setAnalyticsSource()` (arbitrary code execution via Chainlink Functions) |

### 3.3 Implementation Path

**Phase 1 — Immediate (pre-mainnet):**
- Deploy a Gnosis Safe multisig
- Transfer ownership of all contracts to the multisig
- Document all signer identities (pseudonymous is acceptable)

**Phase 2 — Short-term (within 30 days of mainnet):**
- Deploy an OpenZeppelin `TimelockController` with the tier structure above
- Set the multisig as the sole proposer; set a broader set of addresses as executors
- All admin calls route through the timelock except Tier 0

**Phase 3 — Medium-term:**
- Evaluate transition to on-chain governance (Governor + token voting) if/when protocol token launches
- Implement Tally or Snapshot integration for community visibility

---

## 4. Monitoring & Alerting

All owner-controlled function calls MUST be monitored in real-time:

| Tool | Purpose |
|------|---------|
| OpenZeppelin Defender Sentinels | Monitor all `onlyOwner` transactions; alert on execution |
| Tenderly Alerts | Track contract state changes (fee recipient, strategy, pause status) |
| On-chain event indexing | All admin actions MUST emit events (see Event & Logging TODO) |

---

## 5. Transparency Obligations

| Obligation | Description |
|------------|-------------|
| **Public signer disclosure** | Multisig signer addresses MUST be published (pseudonymous acceptable) |
| **Timelock queue visibility** | All pending timelock transactions MUST be visible on-chain and via a public dashboard |
| **Execution notifications** | Community MUST be notified (Discord/Telegram/on-chain) before any Tier 2+ action executes |
| **Post-execution report** | Each admin action MUST be accompanied by a brief rationale published within 24 hours |

---

## References

- [OpenZeppelin Access Control](https://docs.openzeppelin.com/contracts/5.x/access-control)
- [OpenZeppelin TimelockController](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController)
- [Gnosis Safe Documentation](https://docs.safe.global/)
- [Compound Governance](https://docs.compound.finance/v2/governance/)
- [MakerDAO Governance Framework](https://makerdao.com/en/governance)
