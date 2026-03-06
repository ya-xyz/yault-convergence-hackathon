# Yault 多协议收益组合策略 & Affiliate Sub-Vault 模型

> 版本: v0.1 | 日期: 2026-03-06 | 状态: 提案阶段

---

## 目录

1. [现状分析](#1-现状分析)
2. [收益的根本来源](#2-收益的根本来源)
3. [多协议组合策略](#3-多协议组合策略)
4. [Affiliate Sub-Vault 模型](#4-affiliate-sub-vault-模型)
5. [技术实现方案](#5-技术实现方案)
6. [收益预估](#6-收益预估)
7. [风险控制框架](#7-风险控制框架)
8. [路线图](#8-路线图)

---

## 1. 现状分析

### 当前架构

Yault Guardian Vault 目前使用单一策略 — **Aave V3 借贷协议**：

```
用户 USDC → YaultVault (ERC-4626) → Aave V3 Pool → aToken 增值
                                                       ↓
                                              harvest → 75% 用户 / 25% 平台
```

- **当前稳定币 APY**: 2-4%（取决于 Aave 借贷市场供需）
- **收益分成**: 75% 归用户（自动复利），25% 归平台
- **局限性**: 单一协议依赖，收益受 Aave 市场利率波动影响

### 为什么需要升级

Yault 的核心场景是**遗产规划 / 长期资产锁定**，用户资金往往锁定 5-10+ 年。这意味着：

1. **不需要即时流动性** — 可以配置到锁定期更长但收益更高的协议
2. **时间价值被浪费** — 长期锁定在 DeFi 中是稀缺资源，当前没有被利用
3. **单点风险** — 100% 依赖 Aave，一旦 Aave 出问题影响全局

---

## 2. 收益的根本来源

DeFi 中所有"利息"并非凭空产生，而是有人为了获取更大的收益而付出的成本：

```
真实收益来源
│
├── 借贷利差（Aave, Morpho, Compound）
│   └─ 借款人拿走资金池中的资金 → 杠杆做多/做空/套利
│      → 获得更大的收益 → 利润大部分归自己 → 小部分 + 本金还回资金池
│      → 形成存款人的 yield
│
├── 质押奖励（Lido, EigenLayer）
│   └─ 以太坊网络通胀发行 + 验证者分得的交易手续费 + MEV 收入
│
├── 真实世界资产收益（Ondo, Centrifuge）
│   └─ 底层是美国国债利息、企业贷款利息、贸易融资回报
│   └─ 收益来源在链下，通过代币化桥接到链上
│
└── Affiliate 代理贷款收益（本文提案）
    └─ 代理人抵押保证金 → 获得资金池贷款 → 投入真实商业场景
       → 收益首先归代理人 → 合理利息返还资金池
       → 风险由代理人的保证金覆盖
```

**核心认知：我们赚的是别人愿意为使用资金而支付的费用。提升收益的关键是找到更多、更优质的"资金使用者"。**

---

## 3. 多协议组合策略

### 3.1 协议矩阵

| 协议 | 类型 | 当前 APY | 收益来源 | 风险等级 | 锁定期 |
|------|------|---------|---------|---------|--------|
| Aave V3 | 借贷 | 2-4% | 借款人利差 | 低 | 无 |
| Morpho | 优化借贷 | 3.8-8% | P2P 匹配借款人 | 低-中 | 无 |
| Ondo OUSG | RWA 国债 | 3.75-4.8% | 美国国债利息 | 极低 | T+1 赎回 |
| Pendle PT | 固定收益 | 3-12% | 期限溢价+YT投机者 | 中 | 到期日锁定 |
| Centrifuge | RWA 贸易融资 | 5-12% | 企业贸易贷款 | 中-高 | 贷款周期 |
| EigenLayer | 再质押 | 3.8-6% | AVS 安全服务费 | 中 | 解质押排队 |
| **Affiliate Sub-Vault** | **代理贷款** | **8-15% 目标** | **真实商业贷款** | **中（有保证金）** | **贷款周期** |

### 3.2 推荐资金分配

#### 保守模式（推荐初期上线）

```
总资金分配:
┌─────────────────────────────────────────────────────┐
│  40%  Aave V3 USDC          → 3.5% APY  │ 流动缓冲  │
│  40%  Ondo OUSG（国债）       → 4.5% APY  │ 无风险基底 │
│  20%  Morpho 优化池           → 6.0% APY  │ 增强收益   │
├─────────────────────────────────────────────────────┤
│  加权 APY = 0.4×3.5 + 0.4×4.5 + 0.2×6.0 = 4.4%    │
│  用户到手 = 4.4% × 75% = 3.3%                       │
└─────────────────────────────────────────────────────┘
```

#### 中性模式（成熟阶段）

```
总资金分配:
┌─────────────────────────────────────────────────────┐
│  25%  Aave V3               → 3.5% APY  │ 流动缓冲  │
│  25%  Ondo OUSG             → 4.5% APY  │ 无风险基底 │
│  25%  Morpho                → 6.0% APY  │ 优化借贷   │
│  15%  Pendle PT             → 8.0% APY  │ 期限溢价   │
│  10%  Affiliate Sub-Vault   → 10.0% APY │ 商业贷款   │
├─────────────────────────────────────────────────────┤
│  加权 APY = 0.25×3.5+0.25×4.5+0.25×6+0.15×8+0.1×10 │
│           = 0.875+1.125+1.5+1.2+1.0 = 5.7%          │
│  用户到手 = 5.7% × 75% = 4.28%                       │
└─────────────────────────────────────────────────────┘
```

#### 增长模式（含 Affiliate 规模化）

```
总资金分配:
┌─────────────────────────────────────────────────────┐
│  20%  Aave V3               → 3.5% APY  │ 流动缓冲  │
│  20%  Ondo OUSG             → 4.5% APY  │ 无风险基底 │
│  20%  Morpho                → 6.0% APY  │ 优化借贷   │
│  15%  Pendle PT             → 8.0% APY  │ 期限溢价   │
│  25%  Affiliate Sub-Vault   → 10-15% APY│ 商业贷款   │
├─────────────────────────────────────────────────────┤
│  加权 APY = 0.2×3.5+0.2×4.5+0.2×6+0.15×8+0.25×12.5 │
│           = 0.7+0.9+1.2+1.2+3.125 = 7.13%           │
│  用户到手 = 7.13% × 75% = 5.35%                      │
└─────────────────────────────────────────────────────┘
```

---

## 4. Affiliate Sub-Vault 模型

### 4.1 核心理念

传统 DeFi 借贷中，借款人匿名且动机不透明（多为投机杠杆）。Affiliate 模型引入了一个新角色 — **代理人（Affiliate Agent）**，他们：

1. **存入保证金** — 以自有资金做担保，建立信任
2. **管理 Sub-Vault** — 获得主资金池的贷款额度
3. **投入真实商业** — 将资金贷给经过尽调的真实企业
4. **承担首损风险** — 保证金作为第一道亏损缓冲
5. **收益共享** — 先获得超额收益，再将约定利率返还给资金池

### 4.2 运作流程

```
                    ┌─────────────────────┐
                    │    Yault 主资金池     │
                    │  (YaultVault.sol)    │
                    └────────┬────────────┘
                             │ 贷出资金（有额度上限）
                             ▼
              ┌──────────────────────────────┐
              │   Affiliate Sub-Vault #1      │
              │   代理人: Alice               │
              │   保证金: 50,000 USDC         │
              │   杠杆额度: 5x = 250,000 USDC│
              │   目标利率: 10% APR           │
              └──────────────┬───────────────┘
                             │ 真实商业贷款
                     ┌───────┼───────┐
                     ▼       ▼       ▼
                  企业A    企业B    企业C
                 (贸易融资) (设备租赁) (应收账款)
                  15% APR  12% APR   18% APR
                     │       │       │
                     └───────┼───────┘
                             ▼
                    企业还款 + 利息
                             │
              ┌──────────────┴────────────────────┐
              │         收益分配                    │
              │                                    │
              │  企业付 15% → 代理人留 5% 利润       │
              │             → 返还 10% 给主资金池    │
              │                                    │
              │  主资金池 10% → 75% 归用户 = 7.5%   │
              │              → 25% 归平台 = 2.5%    │
              └────────────────────────────────────┘
```

### 4.3 保证金与风险隔离机制

```
风险瀑布结构（Waterfall）:

损失发生时的吸收顺序:
┌────────────────────────┐
│ 第一层: 代理人保证金     │ ← 首先被消耗（如 50,000 USDC）
│ (First-Loss Tranche)   │
├────────────────────────┤
│ 第二层: 代理人未结算利润  │ ← 其次扣除
│ (Accrued Profit Buffer)│
├────────────────────────┤
│ 第三层: 平台保险基金      │ ← 极端情况下的兜底
│ (Platform Reserve)     │
├────────────────────────┤
│ 第四层: 用户资金          │ ← 最后受影响，理论上不应触及
│ (Senior Tranche)       │
└────────────────────────┘

杠杆倍数限制:
  保证金 50,000 → 最大借款 250,000（5x）
  保证金覆盖率 = 50,000 / 250,000 = 20%
  意味着底层贷款可以亏损 20% 而不影响主资金池
```

### 4.4 代理人准入与激励

#### 准入条件

| 条件 | 要求 | 原因 |
|------|------|------|
| 最低保证金 | 10,000 USDC | 确保 skin-in-the-game |
| KYC/KYB | 必须 | 真实身份绑定，法律追溯 |
| 商业计划 | 提交审核 | 确保贷款投向真实商业 |
| 历史信用 | 链上 + 链下 | 降低违约风险 |
| 保证金锁定期 | 最低 6 个月 | 防止短期套利后跑路 |

#### 激励设计

```
代理人的收益公式:

  代理人利润 = 企业贷款利率 - 资金池借款利率 - 运营成本

  例:
    从资金池借 250,000 USDC，利率 10% APR → 年付 25,000
    贷给企业 250,000 USDC，利率 15% APR → 年收 37,500
    运营成本（KYC、催收等）              → 约 2,500
    ─────────────────────────────────────────────
    代理人年利润 = 37,500 - 25,000 - 2,500 = 10,000 USDC
    代理人 ROE = 10,000 / 50,000（保证金）= 20% 年化

  对代理人来说，保证金投入产出比远超被动存款
  → 强激励认真管理贷款质量
```

### 4.5 与现有 DeFi 借贷的本质区别

| 维度 | 传统 DeFi 借贷 (Aave) | Affiliate Sub-Vault |
|------|----------------------|---------------------|
| 借款人 | 匿名，超额抵押 | 实名代理人，保证金担保 |
| 资金用途 | 不透明（多为投机） | 透明（真实商业贷款） |
| 风险承担 | 清算机制（机械化） | 代理人首损 + 人工尽调 |
| 利率决定 | 算法（供需曲线） | 协议约定 + 市场竞标 |
| 收益上限 | 受限于链上投机需求 | 挂钩真实经济活动，上限更高 |
| 周期相关性 | 高度相关加密市场周期 | 与加密市场部分脱钩 |

---

## 5. 技术实现方案

### 5.1 智能合约架构

#### 新增合约

```
contracts/src/
├── YaultVault.sol                    # 已有 — 需扩展 Strategy 接口
├── strategies/
│   ├── IYaultStrategy.sol            # 新增 — 统一策略接口
│   ├── AaveStrategy.sol              # 重构 — 从 Vault 中剥离
│   ├── MorphoStrategy.sol            # 新增 — Morpho 集成
│   ├── OndoOUSGStrategy.sol          # 新增 — Ondo OUSG 集成
│   ├── PendlePTStrategy.sol          # 新增 — Pendle PT 集成
│   └── AffiliateStrategy.sol         # 新增 — Affiliate Sub-Vault
├── affiliate/
│   ├── SubVaultFactory.sol           # 新增 — 创建 Sub-Vault
│   ├── SubVault.sol                  # 新增 — 代理人管理的子金库
│   ├── CollateralManager.sol         # 新增 — 保证金管理与清算
│   ├── AffiliateRegistry.sol         # 新增 — 代理人注册与信用
│   └── RepaymentRouter.sol           # 新增 — 还款路由与利息分配
└── allocator/
    └── StrategyAllocator.sol         # 新增 — 多策略资金分配器
```

#### 统一策略接口

```solidity
// IYaultStrategy.sol
interface IYaultStrategy {
    /// @notice 策略名称
    function name() external view returns (string memory);

    /// @notice 将资金投入策略
    function deposit(uint256 amount) external;

    /// @notice 从策略中取出资金
    function withdraw(uint256 amount) external returns (uint256 actualWithdrawn);

    /// @notice 策略中的总资产（本金 + 收益）
    function totalAssets() external view returns (uint256);

    /// @notice 当前可立即取出的资金量
    function availableLiquidity() external view returns (uint256);

    /// @notice 策略的风险评级 (1-10, 1 最安全)
    function riskScore() external view returns (uint8);

    /// @notice 收割收益
    function harvest() external returns (uint256 yieldAmount);
}
```

#### 资金分配器

```solidity
// StrategyAllocator.sol — 核心逻辑伪代码
contract StrategyAllocator is Ownable {
    struct StrategyConfig {
        IYaultStrategy strategy;
        uint16 targetWeight;      // bps, e.g. 2500 = 25%
        uint16 maxWeight;         // 硬上限
        uint16 minWeight;         // 硬下限（流动性保障）
        bool active;
    }

    StrategyConfig[] public strategies;

    /// @notice 根据目标权重重新平衡资金
    function rebalance() external onlyOwner {
        uint256 totalValue = _totalManagedAssets();
        for (uint i = 0; i < strategies.length; i++) {
            uint256 targetValue = totalValue * strategies[i].targetWeight / 10000;
            uint256 currentValue = strategies[i].strategy.totalAssets();
            if (currentValue < targetValue) {
                uint256 deficit = targetValue - currentValue;
                strategies[i].strategy.deposit(deficit);
            } else if (currentValue > targetValue) {
                uint256 surplus = currentValue - targetValue;
                strategies[i].strategy.withdraw(surplus);
            }
        }
    }

    /// @notice 紧急情况 — 从单一策略撤出全部资金
    function emergencyWithdraw(uint256 strategyIndex) external onlyOwner {
        strategies[strategyIndex].strategy.withdraw(type(uint256).max);
        strategies[strategyIndex].active = false;
    }
}
```

#### Sub-Vault 合约

```solidity
// SubVault.sol — 核心逻辑伪代码
contract SubVault {
    address public agent;              // 代理人地址
    uint256 public collateral;         // 保证金
    uint256 public borrowedAmount;     // 从主池借入的总额
    uint256 public outstandingLoans;   // 当前在外的贷款总额
    uint256 public accruedInterest;    // 累计应还利息

    uint16 public constant MAX_LEVERAGE = 500; // 5x

    /// @notice 代理人存入保证金
    function depositCollateral(uint256 amount) external onlyAgent { ... }

    /// @notice 从主资金池借款
    function borrow(uint256 amount) external onlyAgent {
        require(borrowedAmount + amount <= collateral * MAX_LEVERAGE / 100);
        // pull from main vault via AffiliateStrategy
    }

    /// @notice 代理人还款（本金 + 利息）
    function repay(uint256 principal, uint256 interest) external onlyAgent {
        // interest → RepaymentRouter → 主资金池
        // principal → 减少 borrowedAmount
    }

    /// @notice 健康度检查
    function healthFactor() public view returns (uint256) {
        // collateral / max(outstandingLoans - repaid, 1)
    }

    /// @notice 清算 — 当健康度低于阈值时触发
    function liquidate() external {
        require(healthFactor() < LIQUIDATION_THRESHOLD);
        // 没收保证金 → 偿还主池
    }
}
```

### 5.2 与现有合约的集成

YaultVault.sol 当前的 `investToStrategy` / `withdrawFromStrategy` 直接调用 Aave Pool。需要改造为通过 StrategyAllocator 路由：

```
当前:
  YaultVault → Aave Pool (直接调用)

改造后:
  YaultVault → StrategyAllocator → [AaveStrategy, MorphoStrategy,
                                     OndoStrategy, PendleStrategy,
                                     AffiliateStrategy]
                                         ↓
                                    SubVault #1, #2, #3 ...
```

**关键改造点**:

1. **YaultVault.sol** — `setStrategy` 改为 `setAllocator(address allocator)`
2. **AutoHarvest.sol** — `harvest` 需要遍历所有策略
3. **PortfolioAnalytics.sol** — Chainlink Functions 请求需要包含多策略数据
4. **ChainlinkPriceFeedTracker.sol** — `totalAssets` 需要加总所有策略

### 5.3 Chainlink 集成扩展

```
Chainlink 服务在 Affiliate 模型中的角色:

1. Chainlink Functions
   → 调用链下 API 获取代理人信用评分
   → 验证企业贷款的真实性（与链下数据源交叉验证）

2. Chainlink Automation
   → 定期检查 Sub-Vault 健康度
   → 自动触发清算（当 healthFactor < 阈值）
   → 批量 harvest 多策略收益

3. Chainlink Price Feeds
   → 多策略 NAV 聚合
   → 非 USDC 资产（如 stETH, OUSG）的价格追踪

4. Chainlink CCIP
   → 跨链 Sub-Vault 同步
   → 跨链保证金转移
```

---

## 6. 收益预估

### 6.1 各模式对比

| 指标 | 纯 Aave (现状) | 保守组合 | 中性组合 | 增长组合 (含 Affiliate) |
|------|---------------|---------|---------|----------------------|
| 平台总 APY | 2-4% | 4.0-4.5% | 5.0-5.7% | 6.5-7.5% |
| 用户到手 APY | 1.5-3.0% | 3.0-3.4% | 3.8-4.3% | 4.9-5.6% |
| 平台年收入 (per $1M TVL) | $5-10K | $10-11K | $13-14K | $16-19K |
| 风险等级 | 低 | 低 | 低-中 | 中 |
| 加密周期敏感度 | 高 | 中 | 中 | 低 |

### 6.2 Affiliate 模型的收益天花板分析

```
假设 Affiliate 池规模 = $500,000

代理人总保证金         = $100,000 (5 个代理人, 每人 $20,000)
杠杆倍数               = 5x
总可贷资金             = $100,000 × 5 = $500,000
平均商业贷款利率       = 15% APR
返还主池利率           = 10% APR
代理人利润             = 5% × $500,000 = $25,000
主池收益               = 10% × $500,000 = $50,000
  → 用户 75%           = $37,500  (7.5% on $500K)
  → 平台 25%           = $12,500  (2.5% on $500K)

代理人 ROE             = $25,000 / $100,000 = 25%
用户有效 APY (该部分)   = 7.5%
```

### 6.3 长期复利效应

由于 Yault 的场景是长期锁定（5-10+ 年），复利效果显著：

| 初始本金 | 模式 | 5 年后 | 10 年后 | 20 年后 |
|---------|------|-------|--------|--------|
| $100,000 | 纯 Aave (2.5%) | $113,141 | $128,008 | $163,862 |
| $100,000 | 中性组合 (4.3%) | $123,462 | $152,429 | $232,391 |
| $100,000 | 增长组合 (5.3%) | $129,394 | $167,427 | $280,318 |

---

## 7. 风险控制框架

### 7.1 多协议组合风险

| 风险类型 | 缓解措施 |
|---------|---------|
| 智能合约风险 | 单一协议最大敞口 40%；仅集成经过审计的蓝筹协议 |
| 流动性风险 | 最低 20% 资金保持在即时可用协议（Aave）|
| 预言机风险 | Chainlink Price Feed 多源聚合 + 偏差检测 |
| 协议治理风险 | 监控治理提案，紧急撤出机制（`emergencyWithdraw`）|

### 7.2 Affiliate 模型特有风险

| 风险类型 | 缓解措施 |
|---------|---------|
| 代理人违约 | 保证金首损机制（20% 覆盖率）|
| 底层企业违约 | 代理人分散贷款（单笔 < 25% 额度）；代理人自担风险 |
| 代理人跑路 | 保证金锁定期 6 个月；链上可追踪；KYC 实名 |
| 系统性风险 | Affiliate 池总量上限（如不超过总 TVL 的 30%）|
| 监管风险 | 法律结构设计（代理人为独立实体，非 Yault 雇员）|

### 7.3 熔断机制

```
自动熔断触发条件:

1. 单一策略亏损 > 5%               → 暂停该策略新存入
2. 单一 Sub-Vault 健康度 < 1.2     → 限制新借款
3. 单一 Sub-Vault 健康度 < 1.0     → 触发清算
4. Affiliate 池总损失率 > 3%        → 暂停全部 Affiliate 新贷款
5. 主池可用流动性 < 15% 总资产     → 从低优先级策略撤出
```

---

## 8. 路线图

### Phase 1: 多策略框架（Month 1-2）

- [ ] 抽象 `IYaultStrategy` 接口
- [ ] 将 Aave 逻辑从 `YaultVault.sol` 剥离到 `AaveStrategy.sol`
- [ ] 实现 `StrategyAllocator.sol`
- [ ] 修改 `YaultVault.sol` 通过 Allocator 路由
- [ ] 集成 Ondo OUSG (`OndoOUSGStrategy.sol`)
- [ ] 集成 Morpho (`MorphoStrategy.sol`)
- [ ] 审计 + 测试

### Phase 2: Pendle 集成 + 期限管理（Month 2-3）

- [ ] 实现 `PendlePTStrategy.sol`
- [ ] PT 到期自动滚续逻辑
- [ ] Chainlink Automation 触发到期处理
- [ ] 更新 `PortfolioAnalytics.sol` 支持多策略
- [ ] 审计 + 测试

### Phase 3: Affiliate Sub-Vault MVP（Month 3-5）

- [ ] 实现 `SubVault.sol` + `SubVaultFactory.sol`
- [ ] 实现 `CollateralManager.sol`（保证金 + 清算）
- [ ] 实现 `AffiliateRegistry.sol`（KYC + 准入）
- [ ] 实现 `RepaymentRouter.sol`（还款 + 利息分配）
- [ ] Chainlink Functions 集成（信用评分查询）
- [ ] Chainlink Automation 集成（健康度监控）
- [ ] 招募 2-3 个种子代理人试运行
- [ ] 审计 + 测试

### Phase 4: 规模化（Month 5+）

- [ ] 代理人竞标系统（利率市场化）
- [ ] 代理人声誉系统（链上信用积分）
- [ ] 跨链 Sub-Vault（via Chainlink CCIP）
- [ ] 代理人治理投票（优秀代理人获得更高杠杆）

---

## 附录: 共赢生态的博弈分析

```
                     Affiliate 生态中各方利益对齐

  ┌────────────┐        ┌────────────┐        ┌────────────┐
  │   Yault    │        │  代理人     │        │  企业借款人  │
  │   用户     │        │ (Affiliate) │        │ (Borrower)  │
  └─────┬──────┘        └─────┬──────┘        └──────┬──────┘
        │                     │                      │
   存 $100K              存 $20K 保证金          需要 $50K 贷款
   期望 5% 收益          借 $100K (5x杠杆)       愿付 15% 利率
        │                     │                      │
        ▼                     ▼                      ▼
   ┌──────────────────────────────────────────────────────┐
   │                  利益对齐分析                          │
   │                                                      │
   │  用户:    赚 5%（比纯 Aave 的 2.5% 翻倍）              │
   │           风险有保证金 cover                           │
   │                                                      │
   │  代理人:  ROE = 25%（自有资金 $20K → 年赚 $5K）        │
   │           激励认真管理贷款（保证金是自己的钱）            │
   │           比自己去融资成本更低（DeFi 池利率 < 传统银行）  │
   │                                                      │
   │  企业:    融资渠道多了一个（DeFi 原生，24/7，跨国）      │
   │           利率可能比传统高利贷低                        │
   │                                                      │
   │  平台:    抽成 25% → 年收入 $12.5K per $500K TVL      │
   │           生态越大 → TVL 越大 → 收入越大               │
   │           不承担贷款风险（代理人首损）                   │
   └──────────────────────────────────────────────────────┘

  关键: 代理人的保证金是整个生态的"信任锚点"
        → 代理人有钱在里面 → 有动力认真做
        → 做好了赚 25% ROE → 做坏了赔保证金
        → 自然筛选出有能力的代理人
```

---

*本文档为内部提案，需进一步的法律审查和技术评审。*
