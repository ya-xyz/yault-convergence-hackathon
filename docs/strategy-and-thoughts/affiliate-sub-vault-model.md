# Affiliate Sub-Vault Model

> Version: 0.1 | Date: 2026-03-06 | Status: Proposal

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Core Problem: Where Does Yield Actually Come From?](#2-the-core-problem-where-does-yield-actually-come-from)
3. [The Affiliate Model](#3-the-affiliate-model)
4. [Industry Precedents](#4-industry-precedents)
5. [How It Works: End-to-End Flow](#5-how-it-works-end-to-end-flow)
6. [Collateral and Risk Waterfall](#6-collateral-and-risk-waterfall)
7. [Agent Onboarding and Incentive Design](#7-agent-onboarding-and-incentive-design)
8. [Game Theory: Why Incentives Align](#8-game-theory-why-incentives-align)
9. [Comparison with Traditional DeFi Lending](#9-comparison-with-traditional-defi-lending)
10. [Technical Architecture](#10-technical-architecture)
11. [Chainlink Integration](#11-chainlink-integration)
12. [Yield Projections](#12-yield-projections)
13. [Risk Management](#13-risk-management)
14. [Regulatory Considerations](#14-regulatory-considerations)
---

## 1. Executive Summary

The Affiliate Sub-Vault Model introduces a new participant role into Yault's ecosystem: the **Affiliate Agent**. Agents are vetted operators who deposit collateral (first-loss capital), borrow from Yault's main pool at a fixed rate, and lend those funds to real-world businesses at higher rates. The spread is their profit; the agreed interest flows back to the pool as yield for Yault depositors.

This model:

- **Creates a new, higher-yield channel** (target 8–15% APY to the pool) that is largely decorrelated from crypto market cycles
- **Shifts credit risk to agents** via a collateral-first-loss structure — agents lose their own money before pool depositors are affected
- **Bridges DeFi capital to real-economy lending** — trade finance, equipment leases, working capital loans — where demand for capital is persistent and rates are structurally higher
- **Naturally selects for competent agents** — only agents who can consistently generate returns above their borrowing cost will remain profitable; bad agents lose their collateral and exit

The model draws from established precedents in both DeFi (Goldfinch Backers, Maple Pool Delegates) and traditional finance (bank wholesale lending, CLO equity tranches, loan facilitation platforms).

---

## 2. The Core Problem: Where Does Yield Actually Come From?

Every basis point of DeFi yield traces back to someone paying for the use of capital:

```
The Yield Supply Chain
══════════════════════════════════════════════════════════════════

  Someone with capital          Someone who needs capital
  (Yault depositors)            (borrowers)
         │                              │
         │  "I want passive yield"      │  "I need funds for my business"
         │                              │
         ▼                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │                                                          │
  │  Traditional DeFi (Aave):                                │
  │  Depositor → Pool → Anonymous Borrower → ???             │
  │                                                          │
  │  Problem: Borrowers are anonymous, mostly leveraged      │
  │  speculators. Yield caps at 2-4% because speculative     │
  │  demand is cyclical and limited.                         │
  │                                                          │
  │  Affiliate Model:                                        │
  │  Depositor → Pool → Vetted Agent → Real Business → $$$  │
  │                           ↑                              │
  │                    Deposits collateral                   │
  │                    (skin in the game)                    │
  │                                                          │
  │  Advantage: Real businesses pay 10-20% for working       │
  │  capital globally. This demand is persistent, not        │
  │  cyclical. Agent's collateral protects the pool.         │
  │                                                          │
  └─────────────────────────────────────────────────────────┘
```

**The fundamental insight**: Yault currently earns yield from anonymous crypto speculators (via Aave). The Affiliate model opens a second, structurally higher-yielding channel: real-world business borrowers who pay 10–20% APR for trade finance, working capital, and equipment leasing — markets worth trillions of dollars globally.

---

## 3. The Affiliate Model

### 3.1 Key Roles

| Role | Description | Incentive |
|------|-------------|-----------|
| **Yault Depositor** | End user who deposits USDC into YaultVault for long-term holding (estate planning) | Earns 75% of yield, auto-compounded |
| **Affiliate Agent** | Vetted operator who manages a Sub-Vault — deposits collateral, borrows from the pool, lends to businesses | Keeps the spread between lending rate and borrowing rate |
| **Business Borrower** | Real-world enterprise that borrows from an Agent for trade finance, working capital, etc. | Obtains capital at competitive rates (vs. local banks or shadow lenders) |
| **Yault Platform** | Protocol operator that earns 25% of pool yield | Earns fees without bearing credit risk |

### 3.2 One-Sentence Description

> Affiliate Agents are collateralized middlemen who bridge DeFi liquidity to real-world lending demand, earning a spread while protecting pool depositors with their own capital.

---

## 4. Industry Precedents

### 4.1 DeFi Precedents

The Affiliate model is not without precedent. Several DeFi protocols have implemented variations of agent-mediated, real-world lending:

#### Goldfinch (Most Similar)

- **Model**: "Backers" provide first-loss capital and perform due diligence on borrowers. A "Senior Pool" provides leveraged capital (4–5x the Backer stake). Loans go to real-world businesses in emerging markets.
- **Similarity to Yault Affiliate**: Backer ≈ Affiliate Agent; Senior Pool ≈ Yault main pool; first-loss structure is nearly identical.
- **Key difference**: Goldfinch Backers don't actively manage an ongoing lending book — they evaluate and stake on individual loan pools. Yault Agents manage a continuous Sub-Vault with revolving credit.
- **Yield delivered**: 8–12% to Senior Pool; 15–25% to Backers.
- **TVL**: ~$100M peak.

#### Maple Finance

- **Model**: "Pool Delegates" are institutional credit experts who manage lending pools. They perform credit assessments, set terms, and monitor borrowers. Lenders deposit into delegate-managed pools.
- **Similarity**: Delegate ≈ Agent. Curated lending to known counterparties.
- **Key difference**: Maple delegates don't always post first-loss capital (though newer versions require it). Borrowers are crypto-native institutions (market makers, hedge funds), not real-world SMEs.
- **Yield delivered**: 5–10% to lenders.
- **TVL**: ~$200M+.

#### Centrifuge / Tinlake

- **Model**: "Asset Originators" tokenize real-world assets (invoices, mortgages, trade finance). Investors buy Junior (first-loss) or Senior tranches.
- **Similarity**: Junior tranche ≈ Agent collateral; Senior tranche ≈ Yault depositors. Waterfall risk structure.
- **Key difference**: No active "agent" role — the originator creates the asset pool, then investors choose their tranche. Less dynamic than Sub-Vault management.
- **Yield delivered**: 5–12% depending on asset class.
- **TVL**: ~$250M.

#### TrueFi

- **Model**: Portfolio Managers manage independent lending pools with different strategies and risk profiles.
- **Similarity**: PM role ≈ Agent role. Curated credit decisions.
- **Key difference**: More institutional, less SME-focused.
- **Yield delivered**: 7–12%.

#### Clearpool

- **Model**: Institutional borrowers create their own borrowing pools. Lenders choose which borrower pools to deposit into based on creditworthiness.
- **Similarity**: Borrower self-selection ≈ transparency principle.
- **Key difference**: No intermediary agent; direct borrower-lender matching. No first-loss protection.
- **Yield delivered**: 5–15%.

### 4.2 Traditional Finance Precedents

The Affiliate model maps closely to several well-established TradFi structures:

| TradFi Structure | How It Maps to Affiliate Model |
|-----------------|-------------------------------|
| **Wholesale bank lending** | Central bank → commercial banks → end borrowers. Yault main pool → Agent → businesses. The Agent is like a commercial bank that borrows wholesale and lends retail. |
| **Loan facilitation (助贷)** | Loan facilitators in China/SE Asia use their own capital as a risk cushion (劣后), leverage platform capital (优先), and originate consumer/SME loans. Agent = loan facilitator. |
| **CLO equity tranche** | In Collateralized Loan Obligations, the equity tranche (first-loss) earns the highest return but absorbs losses first. Agent collateral = equity tranche; depositor capital = senior tranche. |
| **Factoring / trade finance** | Factors advance cash against receivables. Agent could specialize in on-chain factoring — advance USDC against tokenized invoices, earn the discount. |
| **Microfinance intermediation** | MFIs borrow from development banks at low rates, lend to micro-entrepreneurs at higher rates, keep the spread. Agent = MFI equivalent. |

### 4.3 What Yault Adds to Existing Models

| Feature | Goldfinch | Maple | Yault Affiliate |
|---------|:---------:|:-----:|:---------------:|
| Agent posts first-loss collateral | Yes (Backers) | Partial | **Yes (mandatory)** |
| On-chain collateral management | Limited | Limited | **Full (smart contract enforced)** |
| Automated liquidation | No | No | **Yes (Chainlink Automation)** |
| Revolving credit (not one-off pools) | No | Partial | **Yes (Sub-Vault is continuous)** |
| Integrated with estate vault | No | No | **Yes (native to Yault)** |
| Health factor monitoring | No | No | **Yes (Chainlink Automation)** |
| Agent credit scoring on-chain | No | No | **Yes (Chainlink Functions)** |
| Cross-chain agent operations | No | No | **Planned (Chainlink CCIP)** |

---

## 5. How It Works: End-to-End Flow

### 5.1 Agent Lifecycle

```
Phase 1: ONBOARDING
═══════════════════
Agent applies → KYC/KYB verification → Business plan review
→ Approved by governance/platform → Registered in AffiliateRegistry

Phase 2: COLLATERAL DEPOSIT
════════════════════════════
Agent deposits 50,000 USDC as collateral → CollateralManager locks it
→ Sub-Vault created via SubVaultFactory → Agent receives borrowing capacity

Phase 3: BORROWING
══════════════════
Agent requests 200,000 USDC from main pool (4x leverage)
→ AffiliateStrategy routes funds from StrategyAllocator → Sub-Vault
→ Interest clock starts (10% APR to the pool)

Phase 4: REAL-WORLD LENDING
═══════════════════════════
Agent lends to Business A (50K at 15%), Business B (80K at 12%),
Business C (70K at 18%) → Total deployed: 200,000 USDC
→ Weighted average lending rate: ~14.5% APR

Phase 5: REPAYMENT CYCLE
═════════════════════════
Businesses repay principal + interest → Agent receives 229,000 USDC
→ Agent repays pool: 200,000 principal + 20,000 interest (10% APR)
→ Agent profit: 229,000 - 220,000 = 9,000 USDC (minus operating costs)

Phase 6: YIELD DISTRIBUTION
═══════════════════════════
20,000 USDC interest enters main pool →
→ 15,000 (75%) compounds for depositors
→ 5,000 (25%) to platform
```

### 5.2 Visual Flow Diagram

```
                      ┌─────────────────────┐
                      │   Yault Main Pool    │
                      │  (YaultVault.sol)    │
                      │                     │
                      │  Total TVL: $2M     │
                      │  Affiliate alloc:   │
                      │  25% = $500K        │
                      └────────┬────────────┘
                               │
                    Lend at 10% APR (via AffiliateStrategy)
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
   ┌──────────────────┐ ┌──────────────┐ ┌──────────────┐
   │  Sub-Vault #1    │ │ Sub-Vault #2 │ │ Sub-Vault #3 │
   │  Agent: Alice    │ │ Agent: Bob   │ │ Agent: Carol  │
   │                  │ │              │ │               │
   │  Collateral:     │ │ Collateral:  │ │ Collateral:   │
   │  $40K            │ │ $30K         │ │ $30K          │
   │  Borrowed:       │ │ Borrowed:    │ │ Borrowed:     │
   │  $200K (5x)      │ │ $150K (5x)  │ │ $150K (5x)   │
   │  Health: 1.8     │ │ Health: 1.5  │ │ Health: 2.1   │
   └───────┬──────────┘ └──────┬───────┘ └───────┬───────┘
           │                   │                  │
     ┌─────┼─────┐       ┌────┼────┐        ┌────┼────┐
     ▼     ▼     ▼       ▼    ▼    ▼        ▼    ▼    ▼
   BizA  BizB  BizC    BizD  BizE  BizF   BizG  BizH  BizI
   15%   12%   18%     14%   16%   11%    13%   15%   17%
   (Trade (Equip (Recv) (WC)  (Inv) (Trade)(Recv)(WC) (Equip)
   Fin)  Lease)                     Fin)
```

### 5.3 Interest Flow Math

```
Example: Agent Alice's Sub-Vault (Annual)
═══════════════════════════════════════════

INFLOWS:
  Business loan interest:  $200,000 × 14.5% = $29,000
  Business principal repaid:                   $200,000
  ─────────────────────────────────────────────────────
  Total inflow:                                $229,000

OUTFLOWS:
  Repay pool principal:                        $200,000
  Repay pool interest:     $200,000 × 10%   =  $20,000
  Operating costs (KYC, legal, collection):      $2,500
  ─────────────────────────────────────────────────────
  Total outflow:                               $222,500

AGENT PROFIT:
  $229,000 - $222,500 = $6,500
  Agent ROE = $6,500 / $40,000 (collateral) = 16.25%

POOL YIELD (from Alice's Sub-Vault):
  $20,000 interest received
  → $15,000 (75%) to depositors
  → $5,000 (25%) to platform

EFFECTIVE APY ON AFFILIATE ALLOCATION:
  Pool APY from this Sub-Vault = $20,000 / $200,000 = 10%
```

---

## 6. Collateral and Risk Waterfall

### 6.1 Loss Absorption Structure

The Affiliate model uses a **tranched waterfall** structure, a well-established risk management pattern from structured finance. Losses are absorbed in strict order:

```
LOSS WATERFALL — Who Gets Hurt First
════════════════════════════════════════════════════════════════

When a business borrower defaults and the agent cannot recover
the full amount, losses are absorbed in this order:

┌────────────────────────────────────────────────────────────┐
│                                                             │
│  LAYER 1: Agent's Collateral (First-Loss / Equity Tranche) │
│  ─────────────────────────────────────────────────────────  │
│  Amount: Agent's deposited collateral (e.g., $40,000)       │
│  Absorbs: First dollar of loss up to collateral amount      │
│  Example: If $30K is lost, agent's collateral drops to $10K │
│           Pool depositors lose NOTHING                      │
│                                                             │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  LAYER 2: Agent's Accrued but Unpaid Profit                 │
│  ─────────────────────────────────────────────────────────  │
│  Amount: Interest earned but not yet withdrawn by agent      │
│  Absorbs: Losses after collateral is exhausted               │
│  Example: If agent has $5K unrealized profit, this is        │
│           clawed back before touching pool funds             │
│                                                             │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  LAYER 3: Platform Insurance Reserve                        │
│  ─────────────────────────────────────────────────────────  │
│  Amount: Accumulated from platform's 25% fee cut             │
│  Absorbs: Extreme losses that exceed agent's total stake     │
│  Example: Platform sets aside 10% of its revenue as reserve  │
│                                                             │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  LAYER 4: Depositor Capital (Senior Tranche) — LAST RESORT │
│  ─────────────────────────────────────────────────────────  │
│  Amount: Main pool depositor funds                           │
│  Absorbs: Only if ALL above layers are exhausted             │
│  Protection: With 20% collateral coverage + profit buffer,   │
│  underlying loans must lose >25% before this layer is hit    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

### 6.2 Collateral Coverage Math

```
Leverage and Coverage Calculation
═════════════════════════════════

Agent collateral:          C = $40,000
Maximum leverage:          L = 5x
Maximum borrowable:        B = C × L = $200,000
Collateral coverage ratio: R = C / B = 20%

This means:
  → The underlying business loans can lose up to 20% of value
    before ANY pool depositor capital is at risk
  → For trade finance (30-90 day loans with invoices as
    collateral), historical loss rates are 1-5%
  → 20% coverage provides 4-20x safety margin over expected losses

Effective protection for depositors:
  If 5 agents each have $40K collateral and borrow $200K:
  Total agent collateral:  $200,000
  Total pool exposure:     $1,000,000
  Aggregate coverage:      20%
  Expected annual loss:    $1,000,000 × 3% = $30,000
  Coverage surplus:        $200,000 - $30,000 = $170,000
```

### 6.3 Leverage Tiers

Different leverage limits based on agent track record:

| Agent Tier | Required Collateral | Max Leverage | Effective Coverage | Qualification |
|-----------|--------------------:|:------------:|:------------------:|---------------|
| **New Agent** | $10,000 minimum | 3x | 33% | KYC + business plan |
| **Established** | $20,000 minimum | 5x | 20% | 6+ months, <2% loss rate |
| **Senior** | $50,000 minimum | 7x | 14% | 12+ months, <1% loss rate |
| **Elite** | $100,000 minimum | 10x | 10% | 24+ months, <0.5% loss rate, governance vote |

Higher leverage = higher capital efficiency for agents, but requires proven track record. This creates a natural incentive for agents to maintain quality over time.

---

## 7. Agent Onboarding and Incentive Design

### 7.1 Onboarding Requirements

| Requirement | Details | Rationale |
|-------------|---------|-----------|
| **KYC/KYB** | Government ID + business registration; verified by approved provider | Legal accountability; enables recourse in case of fraud |
| **Minimum Collateral** | 10,000 USDC (New Agent tier) | Ensures skin-in-the-game; filters out unserious applicants |
| **Business Plan** | Written proposal: target market, borrower type, expected rates, risk assessment | Validates agent's lending strategy and domain expertise |
| **Collateral Lock-Up** | Minimum 6 months; early exit forfeits accrued profit | Prevents hit-and-run: agents can't extract short-term profit and disappear |
| **Legal Agreement** | Off-chain legal contract defining responsibilities, indemnification, jurisdiction | Provides legal recourse beyond on-chain enforcement |
| **Insurance** (optional) | Professional indemnity insurance for the lending operation | Additional risk buffer for larger Sub-Vaults |

### 7.2 Agent Economics

```
AGENT PROFIT MODEL
══════════════════════════════════════════════════════════════

Revenue:
  Lend $200,000 to businesses at weighted avg 14.5% APR
  Annual interest income = $200,000 × 14.5% = $29,000

Costs:
  Pool borrowing cost:     $200,000 × 10% APR =  $20,000
  Operating expenses:      KYC, legal, collection =  $2,500
  Loan losses (expected):  $200,000 × 2%       =   $4,000
  ───────────────────────────────────────────────────────────
  Total costs:                                    $26,500

Net Profit:
  $29,000 - $26,500 = $2,500

Return on Equity (Collateral):
  $2,500 / $40,000 = 6.25% (conservative, with 2% loss provision)

  If losses are below expected (1%):
  Profit = $29,000 - $20,000 - $2,500 - $2,000 = $4,500
  ROE = $4,500 / $40,000 = 11.25%

  If losses are zero (best case):
  Profit = $29,000 - $20,000 - $2,500 = $6,500
  ROE = $6,500 / $40,000 = 16.25%

Comparison to alternatives:
  Passive Aave deposit:   ~3% APY on $40,000 = $1,200/yr
  Agent ROE (expected):   6-16% on $40,000    = $2,500-$6,500/yr
  Agent earns 2-5x more than passive deposit → strong incentive
```

### 7.3 Agent Performance Monitoring

| Metric | Green | Yellow | Red |
|--------|:-----:|:------:|:---:|
| Health Factor | > 1.5 | 1.2 – 1.5 | < 1.2 |
| Loan Loss Rate (trailing 12mo) | < 2% | 2% – 5% | > 5% |
| Repayment Timeliness | > 95% on-time | 80–95% on-time | < 80% on-time |
| Collateral Utilization | < 70% of max leverage | 70–90% | > 90% |
| Diversification | No single loan > 20% | A loan > 20% | A loan > 40% |

Red metrics trigger restrictions:
- Health Factor < 1.2 → No new borrowing allowed
- Health Factor < 1.0 → Liquidation triggered
- Loss Rate > 5% → Leverage reduced to 3x; review required
- Loss Rate > 10% → Sub-Vault frozen; full audit required

---

## 8. Game Theory: Why Incentives Align

### 8.1 Stakeholder Alignment Analysis

```
┌─────────────────────────────────────────────────────────────────────┐
│                  INCENTIVE ALIGNMENT MAP                             │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐      │
│  │  Yault       │    │  Affiliate   │    │  Business        │      │
│  │  Depositor   │    │  Agent       │    │  Borrower        │      │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘      │
│         │                   │                     │                 │
│    Deposits $100K      Deposits $40K         Needs $80K loan       │
│    Wants ~5% yield     collateral            Willing to pay 15%    │
│    Wants safety        Borrows $200K                               │
│                        at 10% from pool                            │
│         │                   │                     │                 │
│         ▼                   ▼                     ▼                 │
│                                                                     │
│  WHY EACH PARTY PARTICIPATES:                                       │
│                                                                     │
│  Depositor:                                                         │
│    ✓ Earns 7.5% (75% of 10%) on affiliate-allocated capital       │
│    ✓ 2-3x better than pure Aave (2.5%)                             │
│    ✓ Risk covered by agent's collateral (20% first-loss buffer)    │
│    ✓ No additional effort required                                  │
│                                                                     │
│  Agent:                                                             │
│    ✓ ROE of 6-16% on collateral (vs. 3% passive)                  │
│    ✓ Access to cheap DeFi capital (10%) vs. TradFi (often 15-20%) │
│    ✓ Scalable: good performance → higher leverage → more profit    │
│    ✓ On-chain reputation builds long-term business moat            │
│                                                                     │
│  Business Borrower:                                                 │
│    ✓ New funding channel (DeFi-native, 24/7, cross-border)        │
│    ✓ May be cheaper than local shadow lending (20-40% in some      │
│      emerging markets)                                              │
│    ✓ Faster than traditional bank loans (weeks vs. months)         │
│                                                                     │
│  Yault Platform:                                                    │
│    ✓ Earns 25% fee on higher yield (more revenue per TVL)          │
│    ✓ No credit risk (agent's collateral absorbs first-loss)        │
│    ✓ Ecosystem growth: more agents → more TVL → more revenue       │
│    ✓ Differentiator vs. generic yield vaults                       │
│                                                                     │
│  KEY ALIGNMENT MECHANISM:                                           │
│    The agent's collateral is the "trust anchor" of the ecosystem.  │
│    Because agents have their OWN money at risk:                     │
│    → They are incentivized to do thorough due diligence            │
│    → They are incentivized to diversify loans                      │
│    → They are incentivized to collect repayments aggressively      │
│    → Bad agents self-select out (lose collateral → leave)          │
│    → Good agents self-select in (earn high ROE → deposit more)     │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.2 Potential Misalignment and Mitigations

| Risk Scenario | What Could Go Wrong | Mitigation |
|---------------|---------------------|------------|
| **Moral hazard** | Agent takes excessive risk because they're lending other people's money | Collateral first-loss: agent loses their own money first; leverage caps |
| **Adverse selection** | Only risky agents (who can't get TradFi funding) apply | KYC/KYB + business plan review + minimum collateral filters quality |
| **Agent collusion** | Agent lends to related parties (self-dealing) | Diversification requirements; Chainlink Functions cross-checks borrower data |
| **Run on the pool** | Many depositors try to withdraw, but capital is locked in agent loans | Liquidity reserve (20% min in Aave); Affiliate allocation capped at 25-30% of TVL |
| **Race to the bottom** | Agents compete by lowering borrower rates, squeezing margins to nothing | Minimum pool borrowing rate floor; agent tier system rewards quality over volume |

---

## 9. Comparison with Traditional DeFi Lending

| Dimension | Traditional DeFi Lending (Aave) | Affiliate Sub-Vault Model |
|-----------|:-------------------------------:|:-------------------------:|
| **Borrower identity** | Anonymous, pseudonymous | KYC/KYB-verified agents |
| **Collateral type** | Crypto assets (over-collateralized, 150%+) | Agent's USDC deposit (first-loss, ~20%) |
| **Capital usage** | Opaque (mostly leverage/speculation) | Transparent (real business loans) |
| **Risk management** | Algorithmic liquidation | Agent's collateral first-loss + human due diligence |
| **Interest rate** | Algorithmic (utilization curve) | Negotiated/fixed between pool and agent |
| **Yield ceiling** | Limited by crypto speculative demand | Linked to real-economy lending rates (higher) |
| **Crypto cycle correlation** | High (rates collapse in bear markets) | Low (real business loan demand is persistent) |
| **Scalability** | Limited by borrowing demand | Limited by number of quality agents |
| **Default recovery** | On-chain liquidation (automatic) | Off-chain collection + legal recourse (slower) |
| **Time to market** | Mature (already integrated) | New (requires development) |

---

## 10. Technical Architecture

### 10.1 Smart Contract Overview

```
contracts/src/affiliate/
├── SubVaultFactory.sol        # Deploys new Sub-Vaults for approved agents
├── SubVault.sol               # Per-agent vault: borrow, repay, track loans
├── CollateralManager.sol      # Collateral deposits, health checks, liquidation
├── AffiliateRegistry.sol      # Agent registration, tier management, reputation
└── RepaymentRouter.sol        # Routes interest payments back to main pool

contracts/src/strategies/
└── AffiliateStrategy.sol      # IYaultStrategy adapter for the StrategyAllocator
```

### 10.2 AffiliateRegistry

Manages agent lifecycle — registration, tier progression, suspension:

```solidity
contract AffiliateRegistry is Ownable {
    enum AgentTier { NONE, NEW, ESTABLISHED, SENIOR, ELITE }

    struct AgentInfo {
        AgentTier tier;
        address subVault;
        uint256 registeredAt;
        uint256 totalLent;          // Lifetime lending volume
        uint256 totalRepaid;        // Lifetime repayment volume
        uint256 totalLosses;        // Lifetime realized losses
        bool active;
        bool suspended;
    }

    mapping(address => AgentInfo) public agents;

    // Tier-based leverage limits (in bps: 300 = 3x, 500 = 5x, etc.)
    mapping(AgentTier => uint16) public maxLeverage;

    /// @notice Register a new agent. Callable by governance/owner.
    function registerAgent(address agent) external onlyOwner {
        // Agent must have completed KYC off-chain before this call
        agents[agent] = AgentInfo({
            tier: AgentTier.NEW,
            subVault: SubVaultFactory.deploy(agent),
            registeredAt: block.timestamp,
            totalLent: 0,
            totalRepaid: 0,
            totalLosses: 0,
            active: true,
            suspended: false
        });
    }

    /// @notice Upgrade agent tier based on track record.
    function upgradeTier(address agent) external onlyOwner {
        AgentInfo storage info = agents[agent];
        require(info.active && !info.suspended);

        if (info.tier == AgentTier.NEW
            && block.timestamp >= info.registeredAt + 180 days
            && _lossRate(agent) < 200) // < 2% loss rate
        {
            info.tier = AgentTier.ESTABLISHED;
        }
        // ... similar for SENIOR, ELITE
    }

    /// @notice Suspend an agent (e.g., due to high loss rate).
    function suspendAgent(address agent) external onlyOwner {
        agents[agent].suspended = true;
        // Sub-Vault continues operating (existing loans) but no new borrows
    }

    function _lossRate(address agent) internal view returns (uint256) {
        if (agents[agent].totalLent == 0) return 0;
        return agents[agent].totalLosses * 10000 / agents[agent].totalLent;
    }
}
```

### 10.3 SubVault

Each agent operates an isolated Sub-Vault:

```solidity
contract SubVault is ReentrancyGuard {
    address public immutable agent;
    IERC20 public immutable asset;          // USDC
    CollateralManager public immutable collateralMgr;
    RepaymentRouter public immutable router;

    uint256 public collateral;              // Agent's deposited collateral
    uint256 public borrowedFromPool;        // Total borrowed from main pool
    uint256 public outstandingPrincipal;    // Currently lent out to businesses
    uint256 public accruedPoolInterest;     // Interest owed to main pool
    uint256 public lastInterestAccrual;     // Timestamp of last accrual

    uint256 public poolBorrowRate;          // APR in bps (e.g., 1000 = 10%)

    uint16 public constant MAX_LEVERAGE_BPS = 500; // 5x (configurable per tier)

    // ────────────────────────────────────────────────────────
    // Agent Operations
    // ────────────────────────────────────────────────────────

    /// @notice Agent deposits collateral.
    function depositCollateral(uint256 amount) external onlyAgent {
        asset.safeTransferFrom(agent, address(this), amount);
        collateral += amount;
        collateralMgr.recordCollateralIncrease(address(this), amount);
    }

    /// @notice Agent borrows from main pool.
    function borrow(uint256 amount) external onlyAgent nonReentrant {
        _accrueInterest();
        require(
            borrowedFromPool + amount
                <= collateral * MAX_LEVERAGE_BPS / 100,
            "Exceeds leverage limit"
        );
        // Pull funds from main pool via AffiliateStrategy
        AffiliateStrategy(affiliateStrategy).pullFromPool(amount);
        borrowedFromPool += amount;
    }

    /// @notice Agent repays principal + interest to the pool.
    function repay(uint256 principalAmount, uint256 interestAmount)
        external onlyAgent nonReentrant
    {
        _accrueInterest();
        asset.safeTransferFrom(agent, address(this), principalAmount + interestAmount);

        // Route interest to main pool (triggers Yault revenue split)
        asset.safeApprove(address(router), interestAmount);
        router.routeInterest(interestAmount);
        accruedPoolInterest -= interestAmount;

        // Return principal to pool
        asset.safeApprove(address(affiliateStrategy), principalAmount);
        AffiliateStrategy(affiliateStrategy).returnToPool(principalAmount);
        borrowedFromPool -= principalAmount;
    }

    /// @notice Record a loan loss (business default).
    function recordLoss(uint256 lossAmount) external onlyAgent {
        // Loss is absorbed by collateral first
        if (lossAmount <= collateral) {
            collateral -= lossAmount;
        } else {
            // Loss exceeds collateral — this triggers alerts
            uint256 excess = lossAmount - collateral;
            collateral = 0;
            // excess is a shortfall to the pool — triggers liquidation
        }
        outstandingPrincipal -= lossAmount;
        collateralMgr.recordLoss(address(this), lossAmount);
    }

    // ────────────────────────────────────────────────────────
    // Health Monitoring
    // ────────────────────────────────────────────────────────

    /// @notice Health factor: collateral / (outstanding obligations).
    /// @dev A health factor < 1.0 means the agent is underwater.
    function healthFactor() public view returns (uint256) {
        uint256 totalObligation = borrowedFromPool + _pendingInterest();
        if (totalObligation == 0) return type(uint256).max;
        return collateral * 1e18 / totalObligation;
    }

    /// @notice Accrue interest based on time elapsed.
    function _accrueInterest() internal {
        uint256 elapsed = block.timestamp - lastInterestAccrual;
        uint256 newInterest = borrowedFromPool * poolBorrowRate * elapsed
            / (10000 * 365 days);
        accruedPoolInterest += newInterest;
        lastInterestAccrual = block.timestamp;
    }
}
```

### 10.4 CollateralManager

Handles liquidation when an agent's health factor drops below threshold:

```solidity
contract CollateralManager is Ownable {
    uint256 public constant LIQUIDATION_THRESHOLD = 1e18;  // HF < 1.0
    uint256 public constant WARNING_THRESHOLD = 12e17;     // HF < 1.2

    /// @notice Check if a Sub-Vault needs liquidation.
    /// @dev Called by Chainlink Automation.
    function needsLiquidation(address subVault)
        public view returns (bool)
    {
        return SubVault(subVault).healthFactor() < LIQUIDATION_THRESHOLD;
    }

    /// @notice Liquidate an underwater Sub-Vault.
    /// @dev Seizes remaining collateral, applies it to pool debt.
    function liquidate(address subVault) external {
        require(needsLiquidation(subVault), "Not eligible");

        SubVault sv = SubVault(subVault);
        uint256 remainingCollateral = sv.collateral();
        uint256 poolDebt = sv.borrowedFromPool() + sv.accruedPoolInterest();

        // Seize all remaining collateral
        uint256 recovered = sv.seizeCollateral();

        // Send recovered funds to main pool
        if (recovered > 0) {
            asset.safeApprove(address(affiliateStrategy), recovered);
            AffiliateStrategy(affiliateStrategy).returnToPool(recovered);
        }

        // If shortfall remains, record as pool loss
        if (recovered < poolDebt) {
            uint256 shortfall = poolDebt - recovered;
            // Attempt to cover from platform insurance reserve
            _coverFromReserve(shortfall);
        }

        // Suspend the agent
        AffiliateRegistry(registry).suspendAgent(sv.agent());

        emit SubVaultLiquidated(subVault, recovered, poolDebt);
    }
}
```

### 10.5 AffiliateStrategy (IYaultStrategy Adapter)

Bridges the Sub-Vault system to the StrategyAllocator:

```solidity
contract AffiliateStrategy is IYaultStrategy, Ownable {
    IERC20 public immutable asset;
    AffiliateRegistry public immutable registry;

    uint256 public totalDeployed;    // Total lent to all Sub-Vaults
    uint256 public totalReturned;    // Total returned from Sub-Vaults

    // --- IYaultStrategy Implementation ---

    function name() external pure returns (string memory) {
        return "Affiliate Sub-Vault";
    }

    function deposit(uint256 amount) external onlyAllocator {
        // Funds sit idle until an agent borrows
        totalDeployed += 0; // No immediate deployment
    }

    function withdraw(uint256 amount) external onlyAllocator
        returns (uint256)
    {
        // Can only withdraw idle (unborrowed) funds instantly
        uint256 idle = asset.balanceOf(address(this));
        uint256 toWithdraw = amount > idle ? idle : amount;
        if (toWithdraw > 0) {
            asset.safeTransfer(msg.sender, toWithdraw);
        }
        return toWithdraw;
    }

    function totalAssets() external view returns (uint256) {
        // Idle balance + total lent to agents (principal + accrued interest)
        return asset.balanceOf(address(this)) + _totalAgentObligations();
    }

    function availableLiquidity() external view returns (uint256) {
        return asset.balanceOf(address(this)); // Only idle funds
    }

    function riskScore() external pure returns (uint8) { return 5; }

    function harvest() external returns (uint256) {
        return 0; // Interest is routed via RepaymentRouter, not harvested
    }

    // --- Agent Interface ---

    function pullFromPool(uint256 amount) external onlyRegisteredSubVault {
        require(asset.balanceOf(address(this)) >= amount, "Insufficient idle");
        asset.safeTransfer(msg.sender, amount);
        totalDeployed += amount;
    }

    function returnToPool(uint256 amount) external onlyRegisteredSubVault {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        totalReturned += amount;
    }
}
```

---

## 11. Chainlink Integration

The Affiliate model leverages four Chainlink services:

### 11.1 Chainlink Automation (Keepers)

**Job: Sub-Vault Health Monitoring**

```
Trigger:  checkUpkeep() iterates through all active Sub-Vaults
          Returns true if any healthFactor() < WARNING_THRESHOLD

Action:
  If HF < 1.2 (WARNING):  Emit HealthWarning event; block new borrows
  If HF < 1.0 (CRITICAL): Call CollateralManager.liquidate()

Frequency: Every block (or every ~12 seconds on mainnet)
Gas budget: Configurable; max 10 Sub-Vaults checked per upkeep
```

**Job: Interest Accrual**

```
Trigger:  Time-based, every 24 hours
Action:   Call _accrueInterest() on all active Sub-Vaults
          Update accruedPoolInterest values
```

### 11.2 Chainlink Functions (Off-Chain Compute)

**Function 1: Agent Credit Scoring**

```javascript
// Called periodically for each agent
// Sources: on-chain repayment history + off-chain credit data

const source = `
  // On-chain data (passed as args)
  const agentAddress = args[0];
  const totalLent = parseInt(args[1]);
  const totalRepaid = parseInt(args[2]);
  const totalLosses = parseInt(args[3]);
  const accountAge = parseInt(args[4]); // seconds

  // Off-chain credit check (hypothetical API)
  const creditResponse = await Functions.makeHttpRequest({
    url: 'https://api.creditcheck.example/score',
    params: { address: agentAddress }
  });

  // Compute composite score (0-1000)
  const onChainScore = calculateOnChainScore(totalLent, totalRepaid, totalLosses, accountAge);
  const offChainScore = creditResponse.data.score;
  const compositeScore = Math.round(onChainScore * 0.6 + offChainScore * 0.4);

  return Functions.encodeUint256(compositeScore);
`;
```

**Function 2: Borrower Verification (Optional)**

```javascript
// Cross-check that businesses receiving loans are real entities
// Called when agent reports a new loan disbursement

const source = `
  const businessId = args[0];
  const country = args[1];
  const loanAmount = parseInt(args[2]);

  // Check business registration database
  const bizCheck = await Functions.makeHttpRequest({
    url: 'https://api.businessregistry.example/verify',
    params: { id: businessId, country: country }
  });

  // Return 1 if verified, 0 if not
  const verified = bizCheck.data.status === 'active' ? 1 : 0;
  return Functions.encodeUint256(verified);
`;
```

### 11.3 Chainlink Data Feeds

- Track USDC/USD peg (detect de-peg events that could affect collateral value)
- If agents accept non-USDC collateral in the future, price feeds value the collateral

### 11.4 Chainlink CCIP (Future)

- Cross-chain Sub-Vaults: agents on L2s (Arbitrum, Optimism) borrow from mainnet pool
- Cross-chain collateral: agent posts collateral on one chain, borrows on another
- Attestation relay for cross-chain agent verification

---

## 12. Yield Projections

### 12.1 Affiliate-Only Yield

| Metric | Conservative | Base Case | Optimistic |
|--------|:-----------:|:---------:|:----------:|
| Number of agents | 3 | 5 | 10 |
| Average collateral per agent | $20,000 | $40,000 | $50,000 |
| Total agent collateral | $60,000 | $200,000 | $500,000 |
| Average leverage | 3x | 5x | 7x |
| Total pool capital deployed | $180,000 | $1,000,000 | $3,500,000 |
| Pool borrowing rate | 8% | 10% | 10% |
| Average business lending rate | 12% | 15% | 15% |
| Agent spread | 4% | 5% | 5% |
| **Pool yield (gross)** | **8%** | **10%** | **10%** |
| **Pool yield (user net, 75%)** | **6%** | **7.5%** | **7.5%** |
| Expected loss rate | 3% | 2% | 1.5% |
| **Pool yield (after expected losses)** | **5%** | **8%** | **8.5%** |

### 12.2 Blended Portfolio Yield (Affiliate + Other Strategies)

Using the Growth Allocation from the companion document (20% Aave, 20% OUSG, 20% Morpho, 15% Pendle, 25% Affiliate):

| Scenario | Gross APY | User Net APY | vs. Current Aave |
|----------|:---------:|:------------:|:----------------:|
| Bear market | 5.0% | 3.75% | +50% to +150% |
| Base case | 7.1% | 5.35% | +115% to +250% |
| Bull market | 9.0% | 6.75% | +170% to +350% |

### 12.3 Sensitivity Analysis

What if key assumptions change?

| Variable | Change | Impact on Blended User APY |
|----------|--------|---------------------------|
| Affiliate pool borrowing rate | 10% → 8% | 5.35% → 4.97% (−0.38%) |
| Affiliate pool borrowing rate | 10% → 12% | 5.35% → 5.73% (+0.38%) |
| Affiliate allocation weight | 25% → 15% | 5.35% → 4.73% (−0.62%) |
| Affiliate allocation weight | 25% → 35% | 5.35% → 5.97% (+0.62%) |
| Affiliate default rate | 2% → 5% | 5.35% → 4.98% (−0.37%) |
| Affiliate default rate | 2% → 10% | 5.35% → 4.35% (−1.00%) — triggers circuit breaker |
| Fed funds rate (affects OUSG, Aave) | −200bps | 5.35% → 4.15% (−1.20%) |
| Fed funds rate (affects OUSG, Aave) | +100bps | 5.35% → 5.95% (+0.60%) |

**Key takeaway**: The Affiliate model is the most impactful single lever for yield. Increasing its weight from 15% to 35% adds +1.24% to user APY. However, it is also the most sensitive to default risk — a 10% default rate in the Affiliate pool triggers circuit breakers.

---

## 13. Risk Management

### 13.1 Affiliate-Specific Risks

| Risk | Likelihood | Impact | Mitigation |
|------|:----------:|:------:|-----------|
| **Agent defaults (loses all collateral)** | Medium | Medium | Waterfall structure; max 25-30% TVL in Affiliate pool; per-agent caps |
| **Systemic agent failure (multiple agents)** | Low | High | Correlation limits (agents in different geographies/sectors); 3% pool-wide loss circuit breaker |
| **Agent fraud (fake loans, self-dealing)** | Low | High | KYC/KYB; Chainlink Functions borrower verification; diversification requirements |
| **Business borrower concentration** | Medium | Medium | No single borrower > 25% of an agent's book; no single sector > 50% |
| **Liquidity mismatch** | Medium | Medium | Affiliate pool capped at 30% of TVL; 20% always in Aave; staggered loan maturities |
| **Regulatory action** | Low–Medium | High | Legal structure review; agent as independent entity; geographic compliance |
| **Smart contract vulnerability** | Low | Very High | Multi-contract audit; bug bounty; admin emergency withdraw |
| **Interest rate risk** | Low | Low | Fixed pool borrowing rate per loan cycle; agents hedge their own exposure |

### 13.2 Circuit Breakers

```
AFFILIATE CIRCUIT BREAKER RULES
═══════════════════════════════════════════════════════════════

CB-1: Single Agent Health Factor < 1.2
  → Block new borrowing for that agent
  → Emit HealthWarning event
  → Chainlink Automation monitors every block

CB-2: Single Agent Health Factor < 1.0
  → Trigger liquidation (seize collateral)
  → Suspend agent in AffiliateRegistry
  → Return recovered funds to pool

CB-3: Affiliate Pool Aggregate Loss > 3% (trailing 12 months)
  → Halt ALL new Affiliate lending
  → Existing loans continue to maturity
  → Full audit of all Sub-Vaults required
  → Owner must manually re-enable

CB-4: Single Agent Loss Rate > 5% (trailing 6 months)
  → Downgrade agent tier (reduce leverage)
  → Mandatory review period (30 days, no new loans)

CB-5: Pool Liquidity Ratio < 15%
  → Halt new Affiliate borrowing (preserve pool liquidity)
  → Auto-withdraw from lowest-priority strategies

CB-6: Agent Concentration > 40% of Affiliate Pool
  → Block further borrowing for that agent
  → Prevents single-agent systemic risk
```

### 13.3 Insurance Reserve

A portion of platform fees is set aside as an insurance reserve:

```
Platform earns 25% of yield
  └─ 15% retained by platform
  └─ 10% allocated to Insurance Reserve

Insurance Reserve is used ONLY when:
  1. Agent collateral is fully exhausted
  2. Agent's accrued profit buffer is exhausted
  3. Loss would otherwise impact depositor capital

Reserve target: 5% of total Affiliate pool TVL
Reserve is held in Aave (earns yield while waiting)
```

---

## 14. Regulatory Considerations

### 14.1 Key Legal Questions

| Question | Analysis | Recommended Approach |
|----------|----------|---------------------|
| **Is the Affiliate Sub-Vault a "security"?** | Potentially — if depositors are passive investors expecting profit from agents' efforts, the Howey test may apply | Structure agent lending as independent contractor relationship; depositors invest in the vault (ERC-4626), not directly in agent loans |
| **Does the agent need a lending license?** | Depends on jurisdiction — many countries require lending licenses for consumer/SME credit | Require agents to hold appropriate licenses in their operating jurisdiction; Yault only provides the technology platform |
| **KYC/AML obligations** | If Yault facilitates lending, it may need to comply with AML regulations | KYC/KYB for all agents; agents are responsible for KYC of their borrowers |
| **Cross-border lending** | Lending across borders involves forex regulations, capital controls, withholding taxes | Start with domestic lending (agents and borrowers in same jurisdiction); expand carefully |
| **Stablecoin regulation** | USDC usage may be subject to stablecoin-specific regulation (e.g., MiCA in EU) | Monitor regulatory developments; maintain compliance with Circle's terms |

### 14.2 Recommended Legal Structure

```
Recommended Entity Structure:

┌─────────────────────────────────────────────┐
│  Yault Protocol (Smart Contracts)            │
│  → Decentralized, non-custodial              │
│  → Provides technology infrastructure only   │
└──────────────────┬──────────────────────────┘
                   │ Technology license
                   ▼
┌─────────────────────────────────────────────┐
│  Yault Foundation / DAO                      │
│  → Governs protocol parameters               │
│  → Approves agent registrations              │
│  → Manages insurance reserve                 │
└──────────────────┬──────────────────────────┘
                   │ Agent agreement
                   ▼
┌─────────────────────────────────────────────┐
│  Agent Entity (e.g., Agent LLC / SPV)        │
│  → Independent legal entity                  │
│  → Holds lending license (if required)       │
│  → KYC of its own borrowers                 │
│  → Responsible for loan origination,         │
│    servicing, collection                     │
│  → NOT an employee or subsidiary of Yault    │
└──────────────────┬──────────────────────────┘
                   │ Loan agreement
                   ▼
┌─────────────────────────────────────────────┐
│  Business Borrower                           │
│  → Direct contractual relationship with Agent│
│  → No direct relationship with Yault         │
└─────────────────────────────────────────────┘

Key principle: Yault provides infrastructure; agents provide
the lending service. This separation is critical for regulatory
defensibility.
```

### 14.3 Jurisdictional Notes

| Jurisdiction | Key Consideration | Approach |
|-------------|-------------------|----------|
| **United States** | SEC (Howey test for securities); state lending licenses; FinCEN (AML) | Reg D exemption for qualified investors; agents must hold state lending licenses |
| **European Union** | MiCA (stablecoin regulation); CRD (lending); GDPR (data) | Comply with MiCA for USDC usage; agents must be licensed credit institutions |
| **Singapore** | MAS (Payment Services Act, Securities and Futures Act) | Possible MAS licensing for agents; Yault Foundation in Singapore |
| **Cayman Islands** | Common for DeFi foundations; no income tax | Foundation structure for governance entity |
| **Emerging Markets** (target lending markets) | Highly variable local lending regulations | Agents must comply with local law; Yault provides technology only |

---

## Appendix A: Comparison with Goldfinch in Detail

Since Goldfinch is the closest existing model, a detailed comparison is warranted:

| Feature | Goldfinch | Yault Affiliate |
|---------|-----------|-----------------|
| First-loss role | Backers (stake GFI + USDC) | Agents (deposit USDC collateral) |
| Senior capital | Senior Pool (automated) | Main Yault pool (via StrategyAllocator) |
| Leverage ratio | 4–5x (Senior/Junior) | 3–10x (tier-dependent) |
| Loan origination | Backers evaluate one-time pools | Agents manage revolving credit lines |
| Borrower type | Emerging market fintechs | Flexible (trade finance, SME, etc.) |
| On-chain enforcement | Limited (off-chain legal agreements) | Collateral seizure + liquidation on-chain |
| Health monitoring | Manual | Automated (Chainlink Automation) |
| Credit scoring | Off-chain committee | Hybrid (Chainlink Functions + on-chain history) |
| Integration | Standalone protocol | Embedded in Yault vault ecosystem |
| Yield routing | Separate Goldfinch token economics | Flows through Yault's 75/25 revenue split |

**Key advantage of Yault's approach**: Goldfinch requires backers to evaluate individual pools (high cognitive overhead). Yault agents manage continuous lending operations, making the system more scalable and the agent role more like a professional business than a one-off investment decision.

## Appendix B: Agent Use Case Examples

### Example 1: Trade Finance Agent (Southeast Asia)

```
Agent: Licensed trade finance company in Singapore
Collateral: $50,000 USDC
Leverage: 5x → borrows $250,000 from pool at 10% APR

Business:
  → Advances $250K against invoices from Vietnamese garment exporters
  → Invoices are 30-60 day payment terms from US/EU retailers
  → Charges 2% per month (~24% APR annualized) on the advance amount
  → Historical default rate: 1.5% (insured receivables)

Agent P&L (Annual):
  Revenue: $250,000 × 24% = $60,000 (assuming ~3 loan cycles in 90-day avg)
  Pool interest: $250,000 × 10% = $25,000
  Operating costs: $5,000
  Expected losses: $250,000 × 1.5% = $3,750
  ─────────────────────────────────
  Net profit: $26,250
  ROE: $26,250 / $50,000 = 52.5%

Pool yield from this agent: $25,000 / $250,000 = 10%
```

### Example 2: Equipment Leasing Agent (Latin America)

```
Agent: Equipment leasing company in Mexico
Collateral: $30,000 USDC
Leverage: 3x (New Agent tier) → borrows $90,000 at 10% APR

Business:
  → Leases construction equipment to SMEs in Mexico City
  → 12-month lease terms, 18% APR effective rate
  → Equipment serves as additional collateral (recoverable)
  → Historical default rate: 3%

Agent P&L (Annual):
  Revenue: $90,000 × 18% = $16,200
  Pool interest: $90,000 × 10% = $9,000
  Operating costs: $2,000
  Expected losses: $90,000 × 3% = $2,700
  ─────────────────────────────────
  Net profit: $2,500
  ROE: $2,500 / $30,000 = 8.3%

Pool yield from this agent: $9,000 / $90,000 = 10%
```

### Example 3: Working Capital Agent (Africa)

```
Agent: Fintech lending platform operating in Kenya/Nigeria
Collateral: $20,000 USDC
Leverage: 3x (New Agent tier) → borrows $60,000 at 10% APR

Business:
  → Provides 30-90 day working capital loans to SMEs
  → Average loan size: $5,000-$10,000
  → Charges 3% per month (~36% APR) — competitive vs. local rates (50-100%)
  → Historical default rate: 5% (higher risk, but much higher spread)

Agent P&L (Annual):
  Revenue: $60,000 × 36% = $21,600 (assuming continuous deployment)
  Pool interest: $60,000 × 10% = $6,000
  Operating costs: $3,000
  Expected losses: $60,000 × 5% = $3,000
  ─────────────────────────────────
  Net profit: $9,600
  ROE: $9,600 / $20,000 = 48%

Pool yield from this agent: $6,000 / $60,000 = 10%
```

---

*This document is an internal proposal. Implementation requires security audits, legal review, and regulatory compliance assessment in all operating jurisdictions. All yield projections are estimates based on comparable market data and are subject to change.*
