# Fee Transparency Policy

> Version: 0.1 | Date: 2026-03-08 | Status: Policy Draft

---

## Purpose

Users entrusting assets to a DeFi protocol must be able to independently verify every fee charged — its rate, its destination, and its calculation. This document defines how Yault ensures full fee transparency, following the precedent set by protocols like Yearn Finance, Aave, and Lido.

---

## 1. Fee Structure

### 1.1 Yield Revenue Split

Yault uses a **hardcoded, immutable** revenue split defined as constants in `YaultVault.sol`. These values cannot be changed without deploying a new contract.

| Recipient | Share | Basis Points | Condition |
|-----------|:-----:|:---:|-----------|
| **User** | 75% | 7500 | Always — compounds in vault |
| **Platform** | 25% | 2500 | When no authority is bound |
| **Platform** | 20% | 2000 | When authority is bound |
| **Authority** | 5% | 500 | When authority is bound (carved from platform's 25%) |

```solidity
// YaultVault.sol — Lines 53–64 (immutable constants)
uint256 public constant USER_SHARE         = 7500;  // 75%
uint256 public constant PLATFORM_SHARE     = 2500;  // 25%
uint256 public constant AUTHORITY_SHARE    =  500;  //  5%
uint256 public constant BPS_DENOMINATOR    = 10_000;
```

### 1.2 Fee Calculation

Fees are calculated at **harvest time** only. There are no deposit fees, withdrawal fees, or management fees.

```
yield = currentShareValue - userPrincipal

userAmount      = yield × 75%    → stays in vault (compounds)
authorityAmount = yield ×  5%    → escrowed on-chain (if authority bound)
platformAmount  = yield - userAmount - authorityAmount  → transferred immediately
```

The `platformAmount` is computed as a remainder (not a direct multiplication) to avoid rounding dust loss.

### 1.3 What Yault Does NOT Charge

| Fee Type | Charged? | Notes |
|----------|:---:|-------|
| Deposit fee | No | Zero cost to deposit |
| Withdrawal fee | No | Zero cost to withdraw |
| Management fee (AUM-based) | No | No annual percentage fee |
| Performance fee (beyond yield split) | No | The 25% yield split is the only fee |
| Entry/exit load | No | No penalty for joining or leaving |
| Gas subsidy fee | No | Users pay their own gas |

---

## 2. Fee Destination Transparency

### 2.1 Platform Fee Recipient

| Property | Value |
|----------|-------|
| Storage | `platformFeeRecipient` (public state variable) |
| Queryable | Yes — anyone can call `platformFeeRecipient()` on-chain |
| Changeable | Yes — via `setPlatformFeeRecipient(address)` (owner-only) |
| Event on change | `PlatformFeeRecipientUpdated(oldRecipient, newRecipient)` |
| Per-vault | Yes — each vault has its own `platformFeeRecipient` |

### 2.2 Authority Fee Recipient

| Property | Value |
|----------|-------|
| Storage | `_revenueConfigs[user].authorityAddress` (per-user) |
| Queryable | Yes — via `getRevenueConfig(user)` |
| Set by | User (first-time immediate, subsequent changes require 2-day timelock) |
| Escrow | Authority revenue is escrowed in `pendingAuthorityRevenue[authority]` |
| Claim | Authority calls `claimAuthorityRevenue()` to withdraw |
| Event on claim | `RevenueClaimedByAuthority(authority, amount)` |

### 2.3 Fee Flow Diagram

```
                    Harvest triggered
                          │
                          ▼
                ┌─────────────────────┐
                │  Calculate yield    │
                │  (current - principal)│
                └─────────┬───────────┘
                          │
              ┌───────────┼───────────────┐
              │           │               │
              ▼           ▼               ▼
         User: 75%    Platform: 20%   Authority: 5%
              │           │               │
              ▼           ▼               ▼
         Compounds    safeTransfer    Escrowed in
         in vault     to recipient    pendingRevenue
              │           │               │
              ▼           ▼               ▼
         Principal    Platform         Authority
         updated      wallet           claims later
```

---

## 3. On-Chain Verifiability

Every fee-related value is independently verifiable by anyone:

| What to Verify | How |
|----------------|-----|
| Fee percentages | Read `USER_SHARE`, `PLATFORM_SHARE`, `AUTHORITY_SHARE` constants |
| Platform recipient | Call `platformFeeRecipient()` |
| Authority binding | Call `getRevenueConfig(userAddress)` |
| Escrowed authority revenue | Call `pendingAuthorityRevenue(authorityAddress)` |
| Total escrowed | Call `totalEscrowedAuthorityRevenue()` |
| Historical harvests | Query `YieldHarvested` events (includes platform and authority amounts) |
| Recipient changes | Query `PlatformFeeRecipientUpdated` events |

### 3.1 Example: Verifying a Harvest

```bash
# Get all YieldHarvested events for a specific user
cast logs --from-block <DEPLOY_BLOCK> --to-block latest \
  --address <VAULT_ADDRESS> \
  "YieldHarvested(address,address,uint256,uint256,uint256)"
```

Each `YieldHarvested` event contains:
- `caller` — who triggered the harvest
- `user` — whose yield was harvested
- `userAmount` — 75% that compounded
- `platformAmount` — amount sent to platform
- `authorityAmount` — amount escrowed for authority

---

## 4. UI Disclosure Requirements

The Yault web application MUST display fee information prominently:

| Location | Required Disclosure |
|----------|-------------------|
| **Vault detail page** | Fee split (75/25 or 75/20/5), platform recipient address |
| **Pre-deposit confirmation** | Clear statement: "75% of yield compounds; 25% is the platform fee" |
| **Harvest history** | Each harvest showing user/platform/authority amounts |
| **Authority binding page** | Explanation that 5% is carved from platform's share, not from user's |
| **Footer / About** | Link to this policy document |

---

## 5. Immutability Guarantee

The fee split is defined as `public constant` values in Solidity. This provides the strongest possible guarantee:

- Constants are **embedded in the bytecode** at compilation time
- They **cannot be changed** by any function call, owner action, or governance vote
- The only way to change them is to deploy an entirely new contract
- Users can verify the constants in the [Etherscan-verified source code](../auditability/code-auditability-policy.md)

This is intentionally more rigid than protocols that use governance-adjustable fee parameters. The trade-off (less flexibility) is accepted in favor of stronger user trust guarantees.

---

## 6. Comparison with Industry Standards

| Feature | Yault | Yearn v3 | Aave v3 | Lido |
|---------|:-----:|:-------:|:-------:|:----:|
| Fee rate on-chain | Constant | Governance-adjustable | Governance-adjustable | Governance-adjustable |
| Fee destination on-chain | Yes | Yes | Yes | Yes |
| Change emits event | Yes | Yes | Yes | Yes |
| Timelock on fee changes | Immutable (N/A) | 3-day timelock | Governance vote | Governance vote |
| No deposit/withdrawal fee | Yes | Varies | Yes | Yes |
| Fee calculation in events | Yes | Yes | Partial | Yes |

---

## References

- [ERC-4626 Tokenized Vault Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [Yearn V3 Fee Structure](https://docs.yearn.fi/)
- [Aave Governance](https://governance.aave.com/)
- [OpenZeppelin ERC-4626 Implementation](https://docs.openzeppelin.com/contracts/5.x/erc4626)
