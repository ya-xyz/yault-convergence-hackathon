# Multi-Protocol Yield Combination Strategy

> Version: 0.1 | Date: 2026-03-06 | Status: Proposal

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Where Yield Actually Comes From](#3-where-yield-actually-comes-from)
4. [Target Protocol Matrix](#4-target-protocol-matrix)
5. [Allocation Models](#5-allocation-models)
6. [Yield Projections](#6-yield-projections)
7. [Technical Architecture](#7-technical-architecture)
8. [Integration with Existing Contracts](#8-integration-with-existing-contracts)
9. [Chainlink Service Extensions](#9-chainlink-service-extensions)
10. [Risk Management Framework](#10-risk-management-framework)
---

## 1. Executive Summary

Yault Guardian Vault currently generates yield exclusively through Aave V3 lending, delivering 2–4% APY on stablecoins. This document proposes a **multi-protocol yield combination strategy** that diversifies across 5+ blue-chip DeFi protocols and real-world asset (RWA) platforms to:

- **Increase user-facing yield** from ~2.5% to ~4–5.5% (net of platform fees)
- **Reduce single-protocol dependency** — no one protocol holds more than 40% of TVL
- **Exploit Yault's unique advantage** — long-term capital lockup (5–10+ years) allows access to term-premium strategies unavailable to on-demand liquidity protocols
- **Decorrelate from crypto-native cycles** — RWA-backed yield sources are anchored to real-world interest rates, not DeFi speculation

The strategy preserves Yault's existing 75/25 revenue split (user/platform) and requires no changes to user-facing interfaces — only backend strategy routing.

---

## 2. Current State Analysis

### 2.1 Existing Architecture

Yault's yield pipeline today is a single-hop path from vault to Aave:

```
User USDC ─→ YaultVault (ERC-4626) ─→ Aave V3 Pool ─→ aToken accrual
                                                            │
                                                    harvest()
                                                            │
                                              ┌─────────────┴─────────────┐
                                              │ 75% user (compounds)      │
                                              │ 25% platform              │
                                              │   └─ 20% platform + 5%   │
                                              │      authority (if bound) │
                                              └───────────────────────────┘
```

**Key contract references:**

| Contract | Role | LOC |
|----------|------|-----|
| `YaultVault.sol` | ERC-4626 vault with revenue split, Aave V3 strategy | 737 |
| `AutoHarvest.sol` | Chainlink Automation batch harvesting | 311 |
| `PortfolioAnalytics.sol` | Chainlink Functions off-chain APY/risk | — |
| `ChainlinkPriceFeedTracker.sol` | Multi-vault NAV via Data Feeds | — |

**Current strategy mechanics in `YaultVault.sol`:**

```solidity
// Strategy state (hardcoded Aave V3)
address public aavePool;
address public aToken;

function setStrategy(address _aavePool, address _aToken) external onlyOwner { ... }
function investToStrategy(uint256 amount) external onlyOwner { ... }
function withdrawFromStrategy(uint256 amount) external onlyOwner { ... }
```

The Aave integration is tightly coupled — pool address and aToken are stored directly in the vault, and `investToStrategy` calls `IAavePool.supply()` inline.

### 2.2 Limitations of Single-Protocol Design

| Limitation | Impact | Severity |
|------------|--------|----------|
| **Single yield source** | Revenue caps at Aave's utilization-driven rate (~2–4% for USDC) | High |
| **Protocol concentration risk** | 100% exposure to Aave smart contract risk, governance risk, and market risk | High |
| **Wasted time premium** | Yault users lock funds for 5–10+ years, but earn the same rate as on-demand depositors | Medium |
| **Crypto-cycle correlation** | Aave lending rates collapse during bear markets (borrowing demand drops) | Medium |
| **No RWA exposure** | Misses the fastest-growing DeFi segment (tokenized treasuries, trade finance) | Medium |

### 2.3 Why Yault Is Uniquely Positioned

Most DeFi vaults optimize for instant liquidity — users can withdraw at any time, so the vault must keep assets in liquid, on-demand positions. Yault's inheritance/estate planning use case fundamentally changes this constraint:

1. **Long lockup periods** — Users voluntarily lock assets for years. This means we can deploy capital into strategies with maturity dates, redemption queues, or lock-up periods that would be unacceptable for typical DeFi vaults.

2. **Predictable capital** — Unlike lending protocols where TVL can flee overnight, Yault's locked deposits provide predictable, stable capital that can be deployed to higher-yield, lower-liquidity strategies.

3. **Term premium capture** — In fixed-income markets (both TradFi and DeFi), longer commitment periods earn higher yields. Pendle PT markets explicitly price this: a 6-month PT can yield 2–3 percentage points more than a 1-month PT for the same underlying.

4. **Risk tolerance alignment** — Estate planning inherently involves multi-decade time horizons. Short-term volatility matters less when the beneficiary may not access funds for 10+ years.

---

## 3. Where Yield Actually Comes From

There is no magic in DeFi yield. Every basis point of return traces back to someone paying for the use of capital. Understanding this is critical to evaluating whether a yield source is sustainable or a house of cards.

### 3.1 Taxonomy of Real Yield Sources

```
Real Yield Sources in DeFi
│
├── 1. LENDING SPREAD (Aave, Morpho, Compound)
│   │
│   │   Mechanism:
│   │   Borrowers take capital from the pool → use it for leveraged trades,
│   │   shorting, or arbitrage → earn a larger return → keep most of the
│   │   profit → return principal + interest to the pool → depositors
│   │   receive interest minus protocol fee.
│   │
│   │   Who pays: Leveraged traders, short sellers, arbitrageurs
│   │   Sustainability: Moderate — depends on speculative demand (cyclical)
│   │   Current range: 2–8% APY (stablecoins)
│   │
│   └── Morpho optimization: P2P matching eliminates spread loss,
│       achieving 1–3% higher rates than pooled lending
│
├── 2. STAKING REWARDS (Lido, Rocket Pool)
│   │
│   │   Mechanism:
│   │   Ethereum protocol issues new ETH to validators (inflation) +
│   │   validators earn transaction tips + MEV (maximal extractable value).
│   │   Liquid staking tokens (stETH, rETH) pass through these rewards
│   │   minus a 10% operator fee.
│   │
│   │   Who pays: Ethereum network (issuance) + users (transaction fees)
│   │   Sustainability: High — core to Ethereum consensus, but issuance
│   │   rate decreases as total stake grows
│   │   Current range: 3.0–3.5% APY (ETH)
│   │
│   └── EigenLayer restaking: AVS (Actively Validated Services) purchase
│       security by paying restakers. Additional 0.5–3% on top of base
│       staking yield.
│
├── 3. REAL-WORLD ASSET YIELD (Ondo, Centrifuge, Maple)
│   │
│   │   Mechanism:
│   │   Off-chain assets — U.S. Treasury bills, corporate loans, trade
│   │   finance receivables, equipment leases — are tokenized and made
│   │   accessible on-chain. The yield originates from the underlying
│   │   real-world borrowers (the U.S. government, corporations, SMEs).
│   │
│   │   Who pays: U.S. Treasury (government debt), corporate borrowers,
│   │   trade finance obligors
│   │   Sustainability: Very high — backed by real economic activity,
│   │   independent of crypto market cycles
│   │   Current range: 3.75–12% APY (depending on asset class and risk)
│   │
│   └── Key advantage for Yault: RWA yields are largely decorrelated
│       from crypto market cycles, providing stable returns even in
│       bear markets when DeFi lending rates collapse.
│
├── 4. TERM PREMIUM (Pendle PT)
│   │
│   │   Mechanism:
│   │   Pendle splits yield-bearing tokens into Principal Tokens (PT) and
│   │   Yield Tokens (YT). PT buyers lock capital until maturity in
│   │   exchange for a fixed, guaranteed return. YT buyers speculate on
│   │   variable yield. The "premium" PT buyers earn comes from YT buyers
│   │   who are willing to pay for yield speculation optionality.
│   │
│   │   Who pays: YT speculators (they overpay for variable yield
│   │   optionality, subsidizing PT fixed returns)
│   │   Sustainability: Moderate-high — as long as speculation exists
│   │   Current range: 3–12% APY (depends on maturity and underlying)
│   │
│   └── Key advantage for Yault: Longer-dated PTs carry higher yields,
│       and Yault's long lockup periods can match PT maturities naturally.
│
└── 5. AFFILIATE LENDING (proposed — see companion document)
    │
    │   Mechanism:
    │   Affiliate agents deposit collateral, borrow from Yault's main
    │   pool at an agreed rate, and lend to real businesses at higher
    │   rates. The spread is their profit; the agreed interest flows
    │   back to the pool as yield. The agent's collateral absorbs
    │   first-loss risk.
    │
    │   Who pays: Real-world business borrowers
    │   Sustainability: High — tied to real economic lending demand
    │   Current range: 8–15% APY (target, agent-dependent)
    │
    └── See: docs/affiliate-sub-vault-model.md

```

### 3.2 The Core Insight

**Yault's yield is ultimately the fee that borrowers pay for using our depositors' capital.** To increase yield, we need to:

1. **Find more borrowers** — diversify across lending protocols (Aave, Morpho, Compound)
2. **Find higher-paying borrowers** — RWA borrowers (governments, corporations) pay stable, real-economy rates
3. **Capture term premium** — lock capital for longer periods to earn the yield curve spread
4. **Create new borrower channels** — the Affiliate model creates a curated network of borrowers who lend to real businesses

The combination of these four vectors is what drives the projected yield improvement from ~2.5% to ~5.5%.

---

## 4. Target Protocol Matrix

### 4.1 Protocol Selection Criteria

Each protocol was evaluated on five dimensions:

| Criterion | Weight | Description |
|-----------|--------|-------------|
| **Security** | 30% | Audit history, TVL track record, bug bounty size, time in production |
| **Yield sustainability** | 25% | Is the yield from real economic activity or subsidized by token emissions? |
| **Liquidity profile** | 20% | Can we withdraw without significant slippage? What's the redemption queue? |
| **Integration complexity** | 15% | Solidity interface availability, documentation quality, composability |
| **Regulatory clarity** | 10% | Legal structure, jurisdictional risks, compliance requirements |

### 4.2 Selected Protocols

#### Tier 1: Core Allocation (Stability + Liquidity)

| Protocol | Asset Class | Current APY | Yield Source | Risk Rating | Lockup | TVL |
|----------|-------------|-------------|-------------|-------------|--------|-----|
| **Aave V3** | Lending | 2–4% | Borrower interest spread | Low | None (instant) | $15B+ |
| **Ondo OUSG** | Tokenized U.S. Treasuries | 3.75–4.8% | U.S. government debt interest | Very Low | T+1 redemption | $3.35B |

**Aave V3** remains the liquidity backbone — always-available capital that can be withdrawn instantly for user claims or emergency rebalancing. Its rate is variable and crypto-cycle-dependent, but the protocol's $15B+ TVL and multi-year track record make it the safest DeFi lending venue.

**Ondo OUSG** provides the risk-free rate floor. OUSG is backed by BlackRock's BUIDL fund (institutional tokenized money market fund) and other major asset managers (Franklin Templeton, WisdomTree, Fidelity). The 0.15% management fee is minimal. Yield is ~4.5% — essentially the U.S. Treasury short-term rate minus fees. This is the most secure yield source available on-chain: it would require a U.S. government default to impair returns.

#### Tier 2: Enhanced Yield

| Protocol | Asset Class | Current APY | Yield Source | Risk Rating | Lockup | TVL |
|----------|-------------|-------------|-------------|-------------|--------|-----|
| **Morpho** | Optimized lending | 3.8–8% | P2P borrower matching | Low–Medium | None | $3B+ |
| **Pendle PT** | Fixed-income tokenization | 3–12% | Term premium + YT speculation | Medium | Until maturity |$5B+ |

**Morpho** is a lending optimizer that sits on top of Aave/Compound and matches lenders with borrowers peer-to-peer when possible, eliminating the pool spread. When P2P matching isn't available, it falls back to the underlying pool. This consistently delivers 1–3% higher APY than direct Aave deposits with similar risk.

**Pendle Principal Tokens (PT)** offer fixed-rate yield by separating yield-bearing tokens into PT (fixed) and YT (variable) components. The PT buyer gets a guaranteed return at maturity. For Yault, the key advantage is that longer-dated PTs carry significantly higher yields (6-month PT: ~8% vs 1-month PT: ~5%), and our users' multi-year lockups can naturally match these maturities. Pendle is the most capital-efficient way to capture term premium in DeFi.

#### Tier 3: Growth Allocation

| Protocol | Asset Class | Current APY | Yield Source | Risk Rating | Lockup | TVL |
|----------|-------------|-------------|-------------|-------------|--------|-----|
| **Centrifuge** | RWA trade finance | 5–12% | Corporate/SME loan interest | Medium–High | Loan cycle | $250M+ |
| **EigenLayer** | Restaking | 3.8–6% | AVS security service fees | Medium | Unstaking queue | $10B+ |
| **Affiliate Sub-Vault** | Agent-mediated lending | 8–15% (target) | Real business loan interest | Medium (collateralized) | Loan cycle | New |

**Centrifuge** tokenizes real-world trade finance assets — invoices, equipment leases, receivables. These are typically short-duration (30–180 day) loans to SMEs, yielding 5–12% based on the borrower's creditworthiness. The risk is real-world credit risk, not smart contract risk.

**EigenLayer** extends ETH staking yield by "restaking" stETH to secure additional services (AVS). These services pay for the security, generating 0.5–3% on top of the base staking rate. Risk comes from slashing conditions defined by each AVS.

**Affiliate Sub-Vault** is Yault's proposed novel mechanism where vetted agents borrow from the main pool, lend to real businesses, and share the yield back. See the companion document (`docs/affiliate-sub-vault-model.md`) for full details.

### 4.3 Protocols Considered and Rejected

| Protocol | Reason for Rejection |
|----------|---------------------|
| Compound V3 | Redundant with Aave V3; lower TVL, similar rates, adds complexity without differentiation |
| Maker DSR | Rate has been volatile (0% → 8% → 4.5%); governance-driven rate changes create unpredictability |
| Yearn V3 | Meta-vault adds another smart contract layer without meaningfully different underlying strategies |
| Convex/Curve | CRV/CVX token incentives are unsustainable yield; not "real yield" |
| GMX/GLP | Delta exposure to BTC/ETH is unsuitable for an estate vault that must preserve capital |
| Ethena sUSDe | Basis trade yield is highly cyclical; funding rates can go negative for extended periods |

---

## 5. Allocation Models

Three allocation profiles are proposed, corresponding to different stages of platform maturity and risk tolerance.

### 5.1 Conservative Profile (Recommended for Launch)

Suitable for initial deployment with minimal new protocol integrations.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    CONSERVATIVE ALLOCATION                            │
│                                                                      │
│  ┌────────────────────────────────────────────────┐                  │
│  │  40%   Aave V3 (USDC)          3.5% APY       │  Liquidity       │
│  │        Instant withdrawal, battle-tested       │  Buffer          │
│  ├────────────────────────────────────────────────┤                  │
│  │  40%   Ondo OUSG (Treasuries)   4.5% APY      │  Risk-Free       │
│  │        BlackRock-backed, T+1 redemption        │  Floor           │
│  ├────────────────────────────────────────────────┤                  │
│  │  20%   Morpho (Optimized USDC)  6.0% APY      │  Yield           │
│  │        P2P matching, Aave fallback             │  Enhancement     │
│  └────────────────────────────────────────────────┘                  │
│                                                                      │
│  Weighted APY = 0.40 × 3.5% + 0.40 × 4.5% + 0.20 × 6.0% = 4.40%  │
│  User Net APY = 4.40% × 75% = 3.30%                                 │
│  Platform Revenue = 4.40% × 25% = 1.10% (of TVL)                    │
│                                                                      │
│  Max single-protocol exposure: 40%                                   │
│  Instant liquidity available: 40% (Aave)                             │
│  T+1 liquidity available: 80% (Aave + OUSG)                         │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Balanced Profile (Mature Stage)

Adds Pendle PT for term premium capture and a small Affiliate allocation.

```
┌──────────────────────────────────────────────────────────────────────┐
│                      BALANCED ALLOCATION                              │
│                                                                      │
│  ┌────────────────────────────────────────────────┐                  │
│  │  25%   Aave V3                  3.5% APY       │  Liquidity       │
│  ├────────────────────────────────────────────────┤                  │
│  │  25%   Ondo OUSG                4.5% APY       │  Risk-Free       │
│  ├────────────────────────────────────────────────┤                  │
│  │  25%   Morpho                   6.0% APY       │  Optimized       │
│  ├────────────────────────────────────────────────┤                  │
│  │  15%   Pendle PT (6-12mo)       8.0% APY       │  Term Premium    │
│  ├────────────────────────────────────────────────┤                  │
│  │  10%   Affiliate Sub-Vault     10.0% APY       │  Real Lending    │
│  └────────────────────────────────────────────────┘                  │
│                                                                      │
│  Weighted APY = 0.25×3.5 + 0.25×4.5 + 0.25×6.0 + 0.15×8.0          │
│               + 0.10×10.0 = 5.70%                                    │
│  User Net APY = 5.70% × 75% = 4.28%                                 │
│  Platform Revenue = 5.70% × 25% = 1.43% (of TVL)                    │
│                                                                      │
│  Max single-protocol exposure: 25%                                   │
│  Instant liquidity available: 25% (Aave)                             │
│  T+1 liquidity available: 50% (Aave + OUSG)                         │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.3 Growth Profile (With Affiliate at Scale)

Maximizes yield by increasing Affiliate and term-premium allocations.

```
┌──────────────────────────────────────────────────────────────────────┐
│                       GROWTH ALLOCATION                               │
│                                                                      │
│  ┌────────────────────────────────────────────────┐                  │
│  │  20%   Aave V3                  3.5% APY       │  Liquidity       │
│  ├────────────────────────────────────────────────┤                  │
│  │  20%   Ondo OUSG                4.5% APY       │  Risk-Free       │
│  ├────────────────────────────────────────────────┤                  │
│  │  20%   Morpho                   6.0% APY       │  Optimized       │
│  ├────────────────────────────────────────────────┤                  │
│  │  15%   Pendle PT (6-24mo)       8.0% APY       │  Term Premium    │
│  ├────────────────────────────────────────────────┤                  │
│  │  25%   Affiliate Sub-Vault     12.5% APY       │  Real Lending    │
│  └────────────────────────────────────────────────┘                  │
│                                                                      │
│  Weighted APY = 0.20×3.5 + 0.20×4.5 + 0.20×6.0 + 0.15×8.0          │
│               + 0.25×12.5 = 7.13%                                    │
│  User Net APY = 7.13% × 75% = 5.35%                                 │
│  Platform Revenue = 7.13% × 25% = 1.78% (of TVL)                    │
│                                                                      │
│  Max single-protocol exposure: 25%                                   │
│  Instant liquidity available: 20% (Aave)                             │
│  T+1 liquidity available: 40% (Aave + OUSG)                         │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.4 Allocation Comparison Summary

| Metric | Current (Aave Only) | Conservative | Balanced | Growth |
|--------|:-------------------:|:------------:|:--------:|:------:|
| Gross APY | 2–4% | 4.0–4.5% | 5.0–5.7% | 6.5–7.5% |
| User Net APY (75%) | 1.5–3.0% | 3.0–3.4% | 3.8–4.3% | 4.9–5.6% |
| Platform revenue / $1M TVL | $5–10K/yr | $10–11K/yr | $13–14K/yr | $16–19K/yr |
| Risk level | Low | Low | Low–Medium | Medium |
| Crypto-cycle sensitivity | High | Medium | Medium | Low |
| Number of protocols | 1 | 3 | 5 | 5 |
| Instant liquidity | 100% | 40% | 25% | 20% |

---

## 6. Yield Projections

### 6.1 Methodology

Projections are based on:

- **Aave V3**: 30-day trailing average supply rate for USDC on Ethereum mainnet (source: Aavescan)
- **Ondo OUSG**: Published 30-day average yield net of 0.15% management fee (source: ondo.finance)
- **Morpho**: 30-day trailing P2P matching rate for USDC (source: Morpho analytics)
- **Pendle PT**: Time-weighted implied APY for PT-aUSDC and PT-OUSG across active maturities (source: Pendle app)
- **Affiliate**: Modeled based on comparable RWA lending platforms (Centrifuge, Maple, Goldfinch)

All figures are annualized. Past performance does not guarantee future results.

### 6.2 Scenario Analysis

#### Base Case (Current Market Conditions)

Federal funds rate ~4.25–4.50%, moderate DeFi borrowing demand.

| Allocation | Gross APY | User APY | Platform APY |
|------------|-----------|----------|-------------|
| Conservative | 4.40% | 3.30% | 1.10% |
| Balanced | 5.70% | 4.28% | 1.43% |
| Growth | 7.13% | 5.35% | 1.78% |

#### Bull Case (Rising Rates + High DeFi Activity)

Fed holds rates steady, crypto bull market drives borrowing demand up.

| Allocation | Gross APY | User APY | Platform APY |
|------------|-----------|----------|-------------|
| Conservative | 5.50% | 4.13% | 1.38% |
| Balanced | 7.20% | 5.40% | 1.80% |
| Growth | 9.00% | 6.75% | 2.25% |

#### Bear Case (Rate Cuts + DeFi Winter)

Fed cuts aggressively, DeFi borrowing collapses.

| Allocation | Gross APY | User APY | Platform APY |
|------------|-----------|----------|-------------|
| Conservative | 2.80% | 2.10% | 0.70% |
| Balanced | 3.80% | 2.85% | 0.95% |
| Growth | 5.00% | 3.75% | 1.25% |

**Key observation**: Even in the bear case, the multi-protocol strategy outperforms current single-Aave performance. The RWA allocation (OUSG) and Affiliate lending provide a floor that is decorrelated from crypto market conditions.

### 6.3 Long-Term Compounding Impact

Yault's estate planning use case means capital compounds for years. Small yield differences become massive over long horizons:

| Initial Deposit | Strategy | 5 Years | 10 Years | 20 Years | 30 Years |
|----------------|----------|---------|----------|----------|----------|
| $100,000 | Current Aave (2.5% user) | $113,141 | $128,008 | $163,862 | $209,757 |
| $100,000 | Conservative (3.3% user) | $117,615 | $138,333 | $191,360 | $264,810 |
| $100,000 | Balanced (4.28% user) | $123,331 | $152,106 | $231,362 | $351,894 |
| $100,000 | Growth (5.35% user) | $129,755 | $168,365 | $283,467 | $477,154 |

**The Growth strategy yields 2.3x the final value of pure Aave over a 30-year horizon.** For an estate planning product, this is the difference between preserving wealth and meaningfully growing it across generations.

---

## 7. Technical Architecture

### 7.1 Design Principles

1. **Strategy abstraction** — All yield strategies implement a common interface; the vault is agnostic to strategy internals
2. **Pluggable allocation** — Strategy weights can be adjusted without redeploying the vault
3. **Backward compatibility** — Existing `YaultVault.sol` behavior is preserved for current users
4. **Emergency withdrawal** — Any strategy can be fully unwound by the owner in a single transaction
5. **Minimal trust surface** — Each strategy adapter is a separate contract with limited permissions

### 7.2 Contract Architecture

```
contracts/src/
├── YaultVault.sol                         # MODIFIED — route through StrategyAllocator
├── AutoHarvest.sol                        # MODIFIED — multi-strategy harvest loop
├── interfaces/
│   ├── IYaultVault.sol                    # EXISTING
│   └── IYaultStrategy.sol                 # NEW — unified strategy interface
├── strategies/
│   ├── AaveV3Strategy.sol                 # NEW — extracted from YaultVault
│   ├── MorphoStrategy.sol                 # NEW — Morpho Blue integration
│   ├── OndoOUSGStrategy.sol               # NEW — Ondo OUSG mint/redeem
│   ├── PendlePTStrategy.sol               # NEW — Pendle PT purchase/redemption
│   └── AffiliateStrategy.sol              # NEW — routes to SubVault system
├── affiliate/
│   ├── SubVaultFactory.sol                # NEW — deploys per-agent SubVaults
│   ├── SubVault.sol                       # NEW — agent-managed sub-vault
│   ├── CollateralManager.sol              # NEW — collateral + liquidation
│   ├── AffiliateRegistry.sol              # NEW — agent registration + credit
│   └── RepaymentRouter.sol                # NEW — interest routing to main pool
└── allocator/
    └── StrategyAllocator.sol              # NEW — weight-based fund distribution
```

### 7.3 Unified Strategy Interface

Every yield strategy must implement `IYaultStrategy`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IYaultStrategy
/// @notice Common interface for all yield strategies used by StrategyAllocator.
/// @dev Each strategy is a standalone contract that manages capital deployment
///      to a specific external protocol. The allocator interacts with all
///      strategies exclusively through this interface.
interface IYaultStrategy {
    /// @notice Human-readable strategy name (e.g., "Aave V3 USDC", "Ondo OUSG").
    function name() external view returns (string memory);

    /// @notice The underlying ERC-20 asset this strategy accepts.
    function asset() external view returns (address);

    /// @notice Deposit `amount` of underlying asset into the strategy.
    /// @dev The allocator must have approved this contract to spend `amount`
    ///      of the underlying asset before calling this function.
    /// @param amount The amount of underlying asset to deposit.
    function deposit(uint256 amount) external;

    /// @notice Withdraw up to `amount` of underlying asset from the strategy.
    /// @dev May return less than `amount` if liquidity is insufficient.
    ///      Caller must check the return value.
    /// @param amount The desired withdrawal amount.
    /// @return actualWithdrawn The actual amount withdrawn and transferred.
    function withdraw(uint256 amount) external returns (uint256 actualWithdrawn);

    /// @notice Total value of assets managed by this strategy (principal + yield),
    ///         denominated in the underlying asset.
    function totalAssets() external view returns (uint256);

    /// @notice Amount of underlying asset that can be withdrawn immediately
    ///         without queueing or slippage.
    /// @dev For strategies with lock-up periods (e.g., Pendle PT), this may
    ///      be less than totalAssets().
    function availableLiquidity() external view returns (uint256);

    /// @notice Risk score from 1 (safest) to 10 (riskiest).
    /// @dev Used by the allocator for risk-weighted reporting, not for
    ///      allocation decisions (those use configured weights).
    function riskScore() external view returns (uint8);

    /// @notice Harvest accrued yield, converting it to underlying asset.
    /// @dev Some strategies (e.g., Aave aTokens) auto-compound and may
    ///      return 0 here. Others (e.g., Pendle) may need explicit claiming.
    /// @return yieldAmount The amount of yield harvested (in underlying asset).
    function harvest() external returns (uint256 yieldAmount);

    /// @notice Whether this strategy is currently accepting deposits.
    /// @dev Returns false if the strategy is paused, the underlying protocol
    ///      is at capacity, or the strategy has been deprecated.
    function isActive() external view returns (bool);
}
```

### 7.4 Strategy Allocator

The `StrategyAllocator` is the central routing contract that manages capital distribution across strategies:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IYaultStrategy} from "../interfaces/IYaultStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StrategyAllocator
/// @notice Routes capital from YaultVault to multiple yield strategies
///         based on configurable target weights.
contract StrategyAllocator is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct StrategyConfig {
        IYaultStrategy strategy;     // Strategy contract address
        uint16 targetWeight;         // Target allocation in bps (e.g., 2500 = 25%)
        uint16 maxWeight;            // Hard ceiling — never exceed this
        uint16 minWeight;            // Hard floor — always maintain at least this
        bool active;                 // Whether this strategy accepts new deposits
    }

    /// @notice The underlying asset (e.g., USDC) managed by all strategies.
    IERC20 public immutable asset;

    /// @notice Ordered list of strategy configurations.
    StrategyConfig[] public strategies;

    /// @notice Total weight in bps — must sum to 10000 when fully configured.
    uint16 public totalTargetWeight;

    /// @notice Minimum percentage of total assets that must remain in the
    ///         most liquid strategy (index 0, expected to be Aave).
    uint16 public constant MIN_LIQUIDITY_RESERVE = 1500; // 15%

    /// @notice Maximum drift from target weight before rebalancing is needed (bps).
    uint16 public constant REBALANCE_THRESHOLD = 300; // 3%

    // --- Core Operations ---

    /// @notice Deposit `amount` into strategies according to target weights.
    /// @dev Called by YaultVault when new capital enters the system.
    function deposit(uint256 amount) external onlyVault nonReentrant {
        // Distribute proportionally to target weights
        for (uint i = 0; i < strategies.length; i++) {
            if (!strategies[i].active) continue;
            uint256 share = amount * strategies[i].targetWeight / totalTargetWeight;
            asset.safeApprove(address(strategies[i].strategy), share);
            strategies[i].strategy.deposit(share);
        }
    }

    /// @notice Withdraw `amount` from strategies, prioritizing the most liquid.
    /// @dev Called by YaultVault when users redeem shares. Withdraws from
    ///      the most liquid strategy first, cascading to others if needed.
    function withdraw(uint256 amount) external onlyVault nonReentrant
        returns (uint256 totalWithdrawn)
    {
        uint256 remaining = amount;
        // Strategy 0 (Aave) is most liquid — withdraw from it first
        for (uint i = 0; i < strategies.length && remaining > 0; i++) {
            uint256 available = strategies[i].strategy.availableLiquidity();
            uint256 toWithdraw = remaining > available ? available : remaining;
            if (toWithdraw == 0) continue;
            uint256 actual = strategies[i].strategy.withdraw(toWithdraw);
            remaining -= actual;
            totalWithdrawn += actual;
        }
    }

    /// @notice Rebalance all strategies toward their target weights.
    /// @dev Only callable by owner. Withdraws from overweight strategies
    ///      and deposits into underweight strategies.
    function rebalance() external onlyOwner nonReentrant {
        uint256 total = totalManagedAssets();
        for (uint i = 0; i < strategies.length; i++) {
            if (!strategies[i].active) continue;
            uint256 target = total * strategies[i].targetWeight / 10000;
            uint256 current = strategies[i].strategy.totalAssets();
            if (current > target + (total * REBALANCE_THRESHOLD / 10000)) {
                strategies[i].strategy.withdraw(current - target);
            }
        }
        // Second pass: deposit freed capital into underweight strategies
        uint256 idle = asset.balanceOf(address(this));
        for (uint i = 0; i < strategies.length; i++) {
            if (!strategies[i].active || idle == 0) continue;
            uint256 target = total * strategies[i].targetWeight / 10000;
            uint256 current = strategies[i].strategy.totalAssets();
            if (current < target) {
                uint256 deficit = target - current;
                uint256 toDeposit = deficit > idle ? idle : deficit;
                asset.safeApprove(address(strategies[i].strategy), toDeposit);
                strategies[i].strategy.deposit(toDeposit);
                idle -= toDeposit;
            }
        }
    }

    /// @notice Total value across all strategies + idle balance.
    function totalManagedAssets() public view returns (uint256 total) {
        for (uint i = 0; i < strategies.length; i++) {
            total += strategies[i].strategy.totalAssets();
        }
        total += asset.balanceOf(address(this));
    }

    /// @notice Total immediately available liquidity across all strategies.
    function totalAvailableLiquidity() public view returns (uint256 total) {
        for (uint i = 0; i < strategies.length; i++) {
            total += strategies[i].strategy.availableLiquidity();
        }
        total += asset.balanceOf(address(this));
    }

    /// @notice Emergency: withdraw everything from a single strategy.
    function emergencyWithdraw(uint256 index) external onlyOwner {
        strategies[index].strategy.withdraw(type(uint256).max);
        strategies[index].active = false;
    }

    /// @notice Harvest yield from all active strategies.
    function harvestAll() external onlyOwner returns (uint256 totalYield) {
        for (uint i = 0; i < strategies.length; i++) {
            if (!strategies[i].active) continue;
            totalYield += strategies[i].strategy.harvest();
        }
    }
}
```

### 7.5 Individual Strategy Adapters

Each strategy adapter wraps a specific protocol's interface:

#### AaveV3Strategy (Extracted from Current Vault)

```solidity
contract AaveV3Strategy is IYaultStrategy, Ownable {
    IAavePool public immutable pool;
    IERC20 public immutable aToken;
    IERC20 public immutable underlying;

    function deposit(uint256 amount) external override onlyAllocator {
        underlying.safeApprove(address(pool), amount);
        pool.supply(address(underlying), amount, address(this), 0);
    }

    function withdraw(uint256 amount) external override onlyAllocator
        returns (uint256)
    {
        return pool.withdraw(address(underlying), amount, msg.sender);
    }

    function totalAssets() external view override returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    function availableLiquidity() external view override returns (uint256) {
        return aToken.balanceOf(address(this)); // Aave is always liquid
    }

    function riskScore() external pure override returns (uint8) { return 2; }
    function isActive() external pure override returns (bool) { return true; }
}
```

#### OndoOUSGStrategy

```solidity
contract OndoOUSGStrategy is IYaultStrategy, Ownable {
    IOUSG public immutable ousg;         // Ondo OUSG token
    IOndoRedemption public immutable redemption;  // Ondo redemption contract
    IERC20 public immutable usdc;

    function deposit(uint256 amount) external override onlyAllocator {
        usdc.safeApprove(address(ousg), amount);
        ousg.mint(amount);  // Mint OUSG with USDC
    }

    function withdraw(uint256 amount) external override onlyAllocator
        returns (uint256)
    {
        // OUSG redemption is T+1 — queue the request
        redemption.requestRedemption(amount);
        // Actual transfer happens after settlement
        return amount; // Optimistic — actual settlement is async
    }

    function totalAssets() external view override returns (uint256) {
        // OUSG NAV = balance × price per token
        return ousg.balanceOf(address(this)) * ousg.getOUSGPrice() / 1e18;
    }

    function availableLiquidity() external view override returns (uint256) {
        return 0; // T+1 redemption — no instant liquidity
    }

    function riskScore() external pure override returns (uint8) { return 1; }
}
```

#### PendlePTStrategy

```solidity
contract PendlePTStrategy is IYaultStrategy, Ownable {
    IPendleRouter public immutable router;
    IPendleMarket public immutable market;
    IERC20 public immutable pt;           // Principal Token
    IERC20 public immutable underlying;
    uint256 public maturity;

    function deposit(uint256 amount) external override onlyAllocator {
        underlying.safeApprove(address(router), amount);
        // Swap underlying for PT via Pendle AMM
        router.swapExactTokenForPt(
            address(this), address(market), amount, 0, ""
        );
    }

    function withdraw(uint256 amount) external override onlyAllocator
        returns (uint256)
    {
        if (block.timestamp >= maturity) {
            // PT has matured — redeem 1:1 for underlying
            return router.redeemPyToToken(address(this), address(market), amount);
        } else {
            // Pre-maturity — sell PT on AMM (may incur slippage)
            return router.swapExactPtForToken(
                address(this), address(market), amount, 0, ""
            );
        }
    }

    function totalAssets() external view override returns (uint256) {
        // PT value = balance × implied price (approaches 1.0 at maturity)
        return pt.balanceOf(address(this)) * _getPTPrice() / 1e18;
    }

    function availableLiquidity() external view override returns (uint256) {
        if (block.timestamp >= maturity) return totalAssets();
        return 0; // Pre-maturity withdrawal incurs slippage — report 0
    }

    function riskScore() external pure override returns (uint8) { return 4; }

    /// @notice Roll over into a new PT market when current one matures.
    /// @dev Called by Chainlink Automation when maturity is reached.
    function rollover(address newMarket) external onlyOwner { ... }
}
```

---

## 8. Integration with Existing Contracts

### 8.1 YaultVault.sol Modifications

The vault's strategy interface changes from direct Aave calls to allocator routing:

```
BEFORE (current):
  YaultVault ──→ IAavePool.supply() / withdraw()

AFTER (proposed):
  YaultVault ──→ StrategyAllocator.deposit() / withdraw()
                     ├──→ AaveV3Strategy
                     ├──→ OndoOUSGStrategy
                     ├──→ MorphoStrategy
                     ├──→ PendlePTStrategy
                     └──→ AffiliateStrategy ──→ SubVault #1, #2, ...
```

**Specific changes to `YaultVault.sol`:**

| Current Code | Replacement | Description |
|-------------|------------|-------------|
| `address public aavePool` | `address public allocator` | Strategy router address |
| `address public aToken` | *(removed)* | No longer needed — allocator manages |
| `setStrategy(pool, aToken)` | `setAllocator(address _allocator)` | Single entry point |
| `investToStrategy(amount)` | `IAllocator(allocator).deposit(amount)` | Route through allocator |
| `withdrawFromStrategy(amount)` | `IAllocator(allocator).withdraw(amount)` | Route through allocator |
| `aToken.balanceOf(address(this))` | `IAllocator(allocator).totalManagedAssets()` | Total across all strategies |

**Backward compatibility**: The existing `setStrategy(aavePool, aToken)` function can be retained as a convenience method that configures a single-strategy allocator with 100% Aave weight.

### 8.2 AutoHarvest.sol Modifications

The batch harvester needs to trigger yield collection across all strategies:

```solidity
// Current: calls vault.harvest() per user
// New: calls allocator.harvestAll() first, then vault.harvest() per user

function performUpkeep(bytes calldata performData) external override {
    address[] memory users = abi.decode(performData, (address[]));

    // Step 1: Harvest yield from all strategies into the vault
    IAllocator(vault.allocator()).harvestAll();

    // Step 2: Distribute harvested yield to users
    for (uint i = 0; i < users.length && i < maxBatchSize; i++) {
        vault.harvestFor(users[i]);
    }
}
```

### 8.3 PortfolioAnalytics.sol Extensions

The Chainlink Functions request payload needs to include per-strategy data:

```javascript
// Current: single Aave position
// New: multi-strategy positions array

const request = {
    strategies: [
        { name: "Aave V3", tvl: aaveTvl, apy: aaveApy },
        { name: "Ondo OUSG", tvl: ousgTvl, apy: ousgApy },
        { name: "Morpho", tvl: morphoTvl, apy: morphoApy },
        { name: "Pendle PT", tvl: pendleTvl, apy: pendleApy, maturity: ptMaturity },
        { name: "Affiliate", tvl: affiliateTvl, apy: affiliateApy }
    ],
    // Compute: weighted APY, portfolio risk score, Sharpe ratio, max drawdown
};
```

### 8.4 ChainlinkPriceFeedTracker.sol Extensions

NAV calculation expands from single-token to multi-strategy:

```solidity
function getVaultNAV(address vault) public view returns (uint256 navUsd) {
    IAllocator allocator = IAllocator(IYaultVault(vault).allocator());

    // Sum across all strategies
    for (uint i = 0; i < allocator.strategyCount(); i++) {
        IYaultStrategy strategy = allocator.strategies(i).strategy;
        uint256 strategyAssets = strategy.totalAssets();

        // Convert to USD using Chainlink price feeds
        // (most strategies hold USDC, so 1:1; but stETH needs ETH/USD feed)
        navUsd += _convertToUsd(strategy.asset(), strategyAssets);
    }
}
```

---

## 9. Chainlink Service Extensions

### 9.1 Expanded Chainlink Integration Map

```
┌──────────────────────────────────────────────────────────────────┐
│                    CHAINLINK SERVICE USAGE                         │
│                                                                   │
│  ┌─────────────────────┐                                          │
│  │  CRE Workflow        │ ← EXISTING: attestation pipeline        │
│  │  (oracle/workflow)   │   No changes needed for strategy work   │
│  └─────────────────────┘                                          │
│                                                                   │
│  ┌─────────────────────┐                                          │
│  │  Data Feeds          │ ← EXTENDED: multi-asset NAV             │
│  │  (Price Tracker)     │   Add feeds: OUSG/USD, stETH/USD       │
│  │                      │   Add: per-strategy NAV breakdowns      │
│  └─────────────────────┘                                          │
│                                                                   │
│  ┌─────────────────────┐                                          │
│  │  Automation          │ ← EXTENDED: 4 new automation jobs       │
│  │  (Keepers)           │   1. Multi-strategy batch harvest       │
│  │                      │   2. Periodic rebalancing trigger       │
│  │                      │   3. Pendle PT maturity rollover        │
│  │                      │   4. SubVault health factor monitoring  │
│  └─────────────────────┘                                          │
│                                                                   │
│  ┌─────────────────────┐                                          │
│  │  Functions            │ ← EXTENDED: multi-strategy analytics   │
│  │  (Off-chain compute) │   1. Per-strategy APY calculation       │
│  │                      │   2. Portfolio risk score (multi-proto) │
│  │                      │   3. Affiliate agent credit scoring     │
│  │                      │   4. RWA collateral verification        │
│  └─────────────────────┘                                          │
│                                                                   │
│  ┌─────────────────────┐                                          │
│  │  CCIP                │ ← EXTENDED: cross-chain strategies      │
│  │  (Cross-chain)       │   1. Cross-chain SubVault sync          │
│  │                      │   2. Cross-chain rebalancing            │
│  │                      │   3. Multi-chain collateral pooling     │
│  └─────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────┘
```

### 9.2 Automation Job Details

#### Job 1: Multi-Strategy Harvest

```
Trigger: Time-based (every 24 hours) or yield threshold
Action:  StrategyAllocator.harvestAll()
         → then AutoHarvest.performUpkeep() for per-user distribution
```

#### Job 2: Periodic Rebalancing

```
Trigger: checkUpkeep() detects >3% drift from target weights
Action:  StrategyAllocator.rebalance()
         Withdraws from overweight strategies, deposits into underweight
```

#### Job 3: Pendle PT Maturity Rollover

```
Trigger: block.timestamp >= PendlePTStrategy.maturity - 1 day
Action:  PendlePTStrategy.rollover(newMarketAddress)
         Redeems matured PT, purchases new PT with next available maturity
```

#### Job 4: SubVault Health Monitoring

```
Trigger: Any SubVault.healthFactor() < WARNING_THRESHOLD (1.2)
Action:  If < LIQUIDATION_THRESHOLD (1.0): CollateralManager.liquidate()
         If < WARNING_THRESHOLD (1.2): emit HealthWarning event (off-chain alert)
```

---

## 10. Risk Management Framework

### 10.1 Multi-Protocol Risk Matrix

| Risk Category | Description | Mitigation | Monitoring |
|---------------|-------------|------------|------------|
| **Smart contract risk** | Bug or exploit in an integrated protocol | Max 40% per protocol; only audited blue-chips | Chainlink Functions checks TVL anomalies |
| **Liquidity risk** | Cannot withdraw fast enough for user claims | Min 20% in instant-liquidity strategies (Aave) | Automation monitors liquidity ratio |
| **Oracle risk** | Price feed manipulation affecting NAV | Chainlink multi-source aggregation + staleness checks | Price deviation alerts via Automation |
| **Protocol governance risk** | Adverse governance vote changes parameters | Monitor governance proposals; emergency withdraw ready | Off-chain monitoring + Automation response |
| **Concentration risk** | Too much in one strategy | Weight caps enforced in StrategyAllocator | `maxWeight` checked on every deposit |
| **Maturity mismatch** | Locked assets needed for user withdrawals | Liquidity buffer + staggered PT maturities | Automation tracks maturity calendar |
| **Counterparty risk (RWA)** | Ondo/Centrifuge counterparty failure | Only use regulated, audited RWA providers | Chainlink Functions verifies backing |
| **Regulatory risk** | RWA protocols face regulatory action | Geographic diversification; legal review | Manual monitoring |

### 10.2 Circuit Breakers

Automated safety mechanisms that halt operations when thresholds are breached:

```
CIRCUIT BREAKER RULES
═══════════════════════════════════════════════════════════════

Rule 1: Single Strategy Loss > 5%
  Trigger:   strategy.totalAssets() < depositedAmount × 0.95
  Action:    Pause deposits to that strategy
  Recovery:  Manual review + owner re-enable

Rule 2: Liquidity Ratio < 15%
  Trigger:   totalAvailableLiquidity() < totalManagedAssets() × 0.15
  Action:    Auto-withdraw from lowest-priority strategy until ratio >= 20%
  Recovery:  Automatic (self-healing)

Rule 3: Aggregate Loss > 2%
  Trigger:   totalManagedAssets() < totalDeposited × 0.98
  Action:    Pause ALL deposits; emergency mode
  Recovery:  Owner must manually investigate and re-enable

Rule 4: Pendle PT Discount > 3%
  Trigger:   PT market price < intrinsicValue × 0.97
  Action:    Halt new PT purchases (potential market dislocation)
  Recovery:  Owner review + re-enable when spread normalizes

Rule 5: Affiliate Pool Loss > 3%
  Trigger:   affiliateStrategy.totalAssets() < deposited × 0.97
  Action:    Halt all new Affiliate lending; begin collateral liquidation
  Recovery:  Full audit of all SubVaults required
```

### 10.3 Withdrawal Priority Order

When multiple strategies hold funds and a user withdrawal is requested, the allocator withdraws in this priority order (most liquid first):

```
Priority 1: Idle balance (USDC sitting in allocator contract)
Priority 2: Aave V3 (instant withdrawal, no slippage)
Priority 3: Morpho (instant if P2P unmatched, slight delay if matched)
Priority 4: Ondo OUSG (T+1 settlement)
Priority 5: Pendle PT (pre-maturity: AMM slippage; post-maturity: instant)
Priority 6: Affiliate SubVaults (requires agent repayment — longest delay)
```

This ordering ensures that routine withdrawals (user claims, harvest distributions) never touch illiquid strategies, while emergency full withdrawals can cascade through the entire stack.

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **APY** | Annual Percentage Yield — the effective annual rate of return including compounding |
| **APR** | Annual Percentage Rate — the simple annual rate without compounding |
| **bps** | Basis points — 1 bps = 0.01% |
| **TVL** | Total Value Locked — the total capital deposited in a protocol |
| **NAV** | Net Asset Value — the total value of managed assets |
| **PT** | Principal Token (Pendle) — represents the right to redeem the underlying asset at maturity |
| **YT** | Yield Token (Pendle) — represents the right to receive variable yield until maturity |
| **RWA** | Real-World Assets — off-chain assets tokenized on-chain |
| **OUSG** | Ondo Short-Term U.S. Government Bond Fund — tokenized Treasury exposure |
| **Sub-Vault** | An isolated vault managed by an Affiliate agent |
| **First-Loss Tranche** | Capital that absorbs losses first, protecting senior capital |
| **Health Factor** | Collateral value / outstanding debt — triggers liquidation when < 1.0 |

## Appendix B: Data Sources and References

| Data Point | Source | Access |
|-----------|--------|--------|
| Aave V3 USDC supply rate | Aavescan | https://aavescan.com |
| Ondo OUSG NAV and yield | Ondo Finance | https://ondo.finance/ousg |
| Morpho rates | Morpho Analytics | https://app.morpho.org |
| Pendle PT implied APY | Pendle App | https://app.pendle.finance |
| Centrifuge pool yields | Centrifuge App | https://app.centrifuge.io |
| EigenLayer restaking APY | EigenLayer Dashboard | https://app.eigenlayer.xyz |
| U.S. Treasury rates | U.S. Treasury | https://treasury.gov |

---

*This document is an internal proposal. All yield projections are estimates based on current market conditions and are subject to change. Implementation requires security audits, legal review, and governance approval.*
