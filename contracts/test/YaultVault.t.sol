// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {YaultVault} from "../src/YaultVault.sol";
import {YaultVaultCreator} from "../src/YaultVaultCreator.sol";
import {YaultVaultFactory} from "../src/YaultVaultFactory.sol";
import {IYaultVault} from "../src/interfaces/IYaultVault.sol";

// ---------------------------------------------------------------------------
//  Mock ERC-20 — mintable token for testing
// ---------------------------------------------------------------------------

/**
 * @title MockERC20
 * @notice Minimal ERC-20 with a public `mint` function for test purposes.
 */
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

// ---------------------------------------------------------------------------
//  Mock Aave V3 Pool — simulates supply/withdraw with interest accrual
// ---------------------------------------------------------------------------

/**
 * @title MockAavePool
 * @notice Simplified Aave V3 Pool mock for testing the vault strategy layer.
 *         On supply: holds the underlying token and mints 1:1 aTokens.
 *         On withdraw: burns aTokens and returns the underlying.
 *         Interest can be simulated by minting extra aTokens.
 */
contract MockAavePool {
    MockERC20 public underlying;
    MockERC20 public aTokenContract;

    constructor(MockERC20 _underlying, MockERC20 _aToken) {
        underlying = _underlying;
        aTokenContract = _aToken;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 /* referralCode */) external {
        require(asset == address(underlying), "wrong asset");
        // Pull underlying from caller
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        // Mint aTokens 1:1 to onBehalfOf
        aTokenContract.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(underlying), "wrong asset");
        // Burn aTokens from caller
        // In a real scenario, aTokens would be burned. Here we transfer them back
        // and "burn" by transferring to address(this).
        aTokenContract.transferFrom(msg.sender, address(this), amount);
        // Return underlying to `to`
        underlying.transfer(to, amount);
        return amount;
    }

    /// @dev Simulate interest accrual: mint extra aTokens to a user
    ///      AND mint extra underlying to this pool so withdraw doesn't fail.
    function simulateInterest(address user, uint256 amount) external {
        aTokenContract.mint(user, amount);
        underlying.mint(address(this), amount);
    }
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

/**
 * @title YaultVaultTest
 * @notice Foundry test suite for `YaultVault` and `YaultVaultFactory`.
 */
contract YaultVaultTest is Test {
    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    MockERC20 internal token;
    YaultVault internal vault;
    YaultVaultFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal authorityA = makeAddr("authorityA");
    address internal authorityB = makeAddr("authorityB");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant INITIAL_BALANCE = 100_000e6; // 100 000 USDC (6 decimals)
    uint256 internal constant DEPOSIT_AMOUNT = 10_000e6;   // 10 000 USDC

    // -----------------------------------------------------------------------
    //  Setup
    // -----------------------------------------------------------------------

    function setUp() public {
        // Deploy mock USDC.
        token = new MockERC20("Mock USDC", "mUSDC", 6);

        // Deploy creator, then factory.
        YaultVaultCreator creator = new YaultVaultCreator();
        factory = new YaultVaultFactory(owner, platform, address(creator));

        // Create vault through factory.
        vm.prank(owner);
        address vaultAddr = factory.createVault(IERC20(address(token)), "Yault USDC Vault", "yUSDC");
        vault = YaultVault(vaultAddr);

        // Mint tokens to test users.
        token.mint(alice, INITIAL_BALANCE);
        token.mint(bob, INITIAL_BALANCE);

        // Approve vault for both users.
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);

        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------

    /// @dev Simulate yield by minting extra tokens directly into the vault.
    function _simulateYield(uint256 amount) internal {
        token.mint(address(vault), amount);
    }

    // -----------------------------------------------------------------------
    //  Deposit tests
    // -----------------------------------------------------------------------

    function testDeposit() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(DEPOSIT_AMOUNT, alice);

        assertGt(shares, 0, "shares should be > 0");
        assertEq(vault.balanceOf(alice), shares, "alice share balance mismatch");
        assertEq(vault.userPrincipal(alice), DEPOSIT_AMOUNT, "principal should equal deposit");
        assertEq(token.balanceOf(address(vault)), DEPOSIT_AMOUNT, "vault should hold deposited tokens");
    }

    function testDeposit_MultipleTimes() public {
        vm.startPrank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.stopPrank();

        assertEq(vault.userPrincipal(alice), DEPOSIT_AMOUNT * 2, "principal should accumulate");
    }

    // -----------------------------------------------------------------------
    //  Withdraw tests
    // -----------------------------------------------------------------------

    function testWithdraw() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 shares = vault.balanceOf(alice);

        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);

        assertEq(assets, DEPOSIT_AMOUNT, "should withdraw full deposit");
        assertEq(vault.balanceOf(alice), 0, "shares should be 0 after full redeem");
        assertEq(vault.userPrincipal(alice), 0, "principal should be 0 after full withdraw");
    }

    function testWithdraw_Partial() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 halfShares = vault.balanceOf(alice) / 2;

        vm.prank(alice);
        vault.redeem(halfShares, alice, alice);

        // Principal should roughly halve.
        assertApproxEqAbs(
            vault.userPrincipal(alice),
            DEPOSIT_AMOUNT / 2,
            1, // 1 wei tolerance for rounding
            "principal should halve after partial withdraw"
        );
    }

    // -----------------------------------------------------------------------
    //  Redeem tests
    // -----------------------------------------------------------------------

    function testRedeem() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);

        assertEq(assets, DEPOSIT_AMOUNT, "redeemed assets should equal deposit");
        assertEq(vault.balanceOf(alice), 0, "no remaining shares");
    }

    // -----------------------------------------------------------------------
    //  setAuthorityAddress tests
    // -----------------------------------------------------------------------

    function testSetAuthorityAddress() public {
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        IYaultVault.RevenueConfig memory cfg = vault.getRevenueConfig(alice);
        assertEq(cfg.authorityAddress, authorityA, "authority should be set");
        assertEq(cfg.user, alice, "user field should be alice");
        assertEq(cfg.platformAddress, platform, "platform should match");
    }

    function testSetAuthorityAddress_Update() public {
        vm.startPrank(alice);
        vault.setAuthorityAddress(authorityA);
        vault.setAuthorityAddress(authorityB); // proposes authorityB (2-step timelock)
        vm.stopPrank();

        vm.warp(block.timestamp + vault.AUTHORITY_CHANGE_DELAY());
        vm.prank(alice);
        vault.confirmAuthorityAddress();

        IYaultVault.RevenueConfig memory cfg = vault.getRevenueConfig(alice);
        assertEq(cfg.authorityAddress, authorityB, "authority should be updated");
    }

    function testSetAuthorityAddress_RevertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(YaultVault.ZeroAddress.selector);
        vault.setAuthorityAddress(address(0));
    }

    // -----------------------------------------------------------------------
    //  Harvest tests
    // -----------------------------------------------------------------------

    function testHarvest_DistributesCorrectly() public {
        // Alice deposits.
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Alice sets authority.
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        // Simulate 1 000 USDC yield.
        uint256 yieldAmount = 1_000e6;
        _simulateYield(yieldAmount);

        // Record balances before harvest.
        uint256 principalBefore = vault.userPrincipal(alice);
        uint256 platformBefore = token.balanceOf(platform);

        // Harvest.
        vm.prank(alice);
        vault.harvest();

        // Expected splits: 75 % user (compounds), 20 % platform, 5 % authority.
        uint256 expectedUser = (yieldAmount * 7500) / 10_000;     // 750 USDC
        uint256 expectedAuthority = (yieldAmount * 500) / 10_000;  // 50 USDC
        uint256 expectedPlatform = yieldAmount - expectedUser - expectedAuthority; // 200 USDC

        // User's 75 % compounds in vault (principal increases, no external transfer).
        assertApproxEqAbs(
            vault.userPrincipal(alice) - principalBefore,
            expectedUser,
            2, // small rounding tolerance from share conversion
            "alice principal should increase by 75% of yield (compounds)"
        );
        assertApproxEqAbs(
            token.balanceOf(platform) - platformBefore,
            expectedPlatform,
            2,
            "platform should receive 20% of yield (authority bound)"
        );
        assertApproxEqAbs(
            vault.getPendingRevenue(authorityA),
            expectedAuthority,
            2,
            "authority pending should be 5% of yield"
        );
    }

    function testHarvest_NoAuthority_PlatformGetsFull25Percent() public {
        // Deposit without setting an authority.
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 yieldAmount = 1_000e6;
        _simulateYield(yieldAmount);

        uint256 platformBefore = token.balanceOf(platform);

        vm.prank(alice);
        vault.harvest();

        uint256 expectedUser = (yieldAmount * 7500) / 10_000;        // 750
        uint256 expectedPlatform = yieldAmount - expectedUser;         // 250 (full 25 %)

        // Platform gets the full 25 % since no authority is bound.
        assertApproxEqAbs(
            token.balanceOf(platform) - platformBefore,
            expectedPlatform,
            2,
            "platform should receive full 25% when no authority set"
        );
        // Authority pending should be zero.
        assertEq(vault.getPendingRevenue(authorityA), 0, "no authority revenue when unbound");
    }

    function testHarvest_RevertsWithNoYield() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(alice);
        vm.expectRevert(YaultVault.NoYieldToHarvest.selector);
        vault.harvest();
    }

    // -----------------------------------------------------------------------
    //  claimAuthorityRevenue tests
    // -----------------------------------------------------------------------

    function testClaimAuthorityRevenue() public {
        // Setup: deposit, bind authority, simulate yield, harvest.
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        _simulateYield(1_000e6);

        vm.prank(alice);
        vault.harvest();

        uint256 pending = vault.getPendingRevenue(authorityA);
        assertGt(pending, 0, "pending should be > 0 before claim");

        uint256 authorityBefore = token.balanceOf(authorityA);

        // Authority claims.
        vm.prank(authorityA);
        vault.claimAuthorityRevenue();

        assertEq(token.balanceOf(authorityA) - authorityBefore, pending, "authority should receive pending");
        assertEq(vault.getPendingRevenue(authorityA), 0, "pending should be 0 after claim");
    }

    function testClaimAuthorityRevenue_RevertsWhenNoPending() public {
        vm.prank(authorityA);
        vm.expectRevert(YaultVault.NoPendingRevenue.selector);
        vault.claimAuthorityRevenue();
    }

    // -----------------------------------------------------------------------
    //  Multiple users tests
    // -----------------------------------------------------------------------

    function testMultipleUsers() public {
        // Alice and Bob both deposit.
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(bob);
        vault.deposit(DEPOSIT_AMOUNT, bob);

        // Different authorities.
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        vm.prank(bob);
        vault.setAuthorityAddress(authorityB);

        // Simulate yield on total deposits.
        _simulateYield(2_000e6);

        // Each user has half the vault, so each gets ~1000 USDC yield.
        // Alice harvests.
        vm.prank(alice);
        vault.harvest();

        // Bob harvests.
        vm.prank(bob);
        vault.harvest();

        // Both authorities should have pending revenue.
        assertGt(vault.getPendingRevenue(authorityA), 0, "authorityA should have pending");
        assertGt(vault.getPendingRevenue(authorityB), 0, "authorityB should have pending");

        // Pending amounts should be approximately equal (allow share-math rounding).
        // Note: sequential harvests skew because the first harvest removes platform+authority
        // tokens from the vault, shifting share ratios for the second harvest.
        assertApproxEqAbs(
            vault.getPendingRevenue(authorityA),
            vault.getPendingRevenue(authorityB),
            25e6, // ~25 USDC tolerance from sequential harvest share-ratio skew
            "both authorities should have approx equal pending"
        );
    }

    function testMultipleUsers_IndependentConfigs() public {
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        vm.prank(bob);
        vault.setAuthorityAddress(authorityB);

        IYaultVault.RevenueConfig memory cfgA = vault.getRevenueConfig(alice);
        IYaultVault.RevenueConfig memory cfgB = vault.getRevenueConfig(bob);

        assertEq(cfgA.authorityAddress, authorityA, "alice authority");
        assertEq(cfgB.authorityAddress, authorityB, "bob authority");
        assertTrue(cfgA.authorityAddress != cfgB.authorityAddress, "configs should be independent");
    }

    // -----------------------------------------------------------------------
    //  Pause tests
    // -----------------------------------------------------------------------

    function testPause_BlocksDeposits() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert(); // EnforcedPause
        vault.deposit(DEPOSIT_AMOUNT, alice);
    }

    function testPause_AllowsWithdrawals() public {
        // Deposit first, then pause.
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(owner);
        vault.pause();

        // Withdrawal should still work.
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);

        assertEq(assets, DEPOSIT_AMOUNT, "should be able to withdraw while paused");
    }

    function testOnlyOwnerCanPause() public {
        vm.prank(attacker);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vault.pause();
    }

    function testOnlyOwnerCanUnpause() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(attacker);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vault.unpause();
    }

    // -----------------------------------------------------------------------
    //  Admin tests
    // -----------------------------------------------------------------------

    function testSetPlatformFeeRecipient() public {
        address newPlatform = makeAddr("newPlatform");

        vm.prank(owner);
        vault.setPlatformFeeRecipient(newPlatform);

        assertEq(vault.platformFeeRecipient(), newPlatform, "platform recipient should update");
    }

    function testSetPlatformFeeRecipient_OnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vault.setPlatformFeeRecipient(attacker);
    }

    function testSetPlatformFeeRecipient_RevertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(YaultVault.ZeroAddress.selector);
        vault.setPlatformFeeRecipient(address(0));
    }

    // -----------------------------------------------------------------------
    //  Factory tests
    // -----------------------------------------------------------------------

    function testFactory_CreateVault() public {
        vm.prank(owner);
        address v = factory.createVault(IERC20(address(token)), "Test Vault", "tVLT");

        assertTrue(v != address(0), "vault address should be non-zero");

        address[] memory vaults = factory.getVaults();
        // The setUp already creates one vault, so total should be 2.
        assertEq(vaults.length, 2, "factory should track 2 vaults");
        assertEq(vaults[1], v, "second vault should match");
    }

    function testFactory_OnlyOwnerCanCreate() public {
        vm.prank(attacker);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        factory.createVault(IERC20(address(token)), "Bad", "BAD");
    }

    function testFactory_SetPlatformFeeRecipient() public {
        address newPlatform = makeAddr("newPlatform");

        vm.prank(owner);
        factory.setPlatformFeeRecipient(newPlatform);

        assertEq(factory.platformFeeRecipient(), newPlatform, "factory recipient should update");
    }

    function testFactory_GetVaultCount() public view {
        assertEq(factory.getVaultCount(), 1, "should start with 1 vault from setUp");
    }

    // -----------------------------------------------------------------------
    //  Edge cases
    // -----------------------------------------------------------------------

    function testZeroBalance_NoRevert() public {
        // User with no deposit tries to harvest — should revert gracefully.
        vm.prank(alice);
        vm.expectRevert(YaultVault.NoYieldToHarvest.selector);
        vault.harvest();
    }

    function testRevenueConstants() public view {
        assertEq(vault.USER_SHARE(), 7500, "user share should be 7500 bp");
        assertEq(vault.PLATFORM_SHARE(), 2500, "platform share should be 2500 bp");
        assertEq(vault.AUTHORITY_SHARE(), 500, "authority share should be 500 bp");
        assertEq(
            vault.USER_SHARE() + vault.PLATFORM_SHARE(),
            10_000,
            "user + platform should be 10000 bp (authority carved from platform)"
        );
    }

    // -----------------------------------------------------------------------
    //  Strategy helpers
    // -----------------------------------------------------------------------

    MockERC20 internal aToken;
    MockAavePool internal mockAave;

    function _setupStrategy() internal {
        aToken = new MockERC20("Aave USDC", "aUSDC", 6);
        mockAave = new MockAavePool(token, aToken);

        // Fund the mock Aave pool so it can return underlying on withdraw
        // (supply will pull from vault, but we need initial liquidity for interest)

        vm.prank(owner);
        vault.setStrategy(address(mockAave), address(aToken));

        // Vault needs to approve aToken transfers for withdraw (Aave pulls aTokens)
        // In real Aave, aTokens auto-approve Pool. Here we do it manually.
        vm.prank(address(vault));
        aToken.approve(address(mockAave), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    //  Strategy tests
    // -----------------------------------------------------------------------

    function testSetStrategy() public {
        MockERC20 aT = new MockERC20("aUSDC", "aUSDC", 6);
        address pool = makeAddr("aavePool");

        vm.prank(owner);
        vault.setStrategy(pool, address(aT));

        assertEq(vault.aavePool(), pool, "aavePool should be set");
        assertEq(vault.aToken(), address(aT), "aToken should be set");
    }

    function testSetStrategy_OnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vault.setStrategy(makeAddr("pool"), makeAddr("aToken"));
    }

    function testSetStrategy_RevertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(YaultVault.ZeroAddress.selector);
        vault.setStrategy(address(0), makeAddr("aToken"));
    }

    function testInvestToStrategy() public {
        _setupStrategy();

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Owner invests half to Aave
        uint256 investAmount = DEPOSIT_AMOUNT / 2;
        vm.prank(owner);
        vault.investToStrategy(investAmount);

        // Vault should have half the tokens, Aave should have the other half
        assertEq(token.balanceOf(address(vault)), DEPOSIT_AMOUNT - investAmount, "vault idle balance");
        assertEq(aToken.balanceOf(address(vault)), investAmount, "vault aToken balance");

        // totalAssets should still reflect the full amount
        assertEq(vault.totalAssets(), DEPOSIT_AMOUNT, "totalAssets should include Aave");
    }

    function testInvestToStrategy_OnlyOwner() public {
        _setupStrategy();

        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(attacker);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vault.investToStrategy(DEPOSIT_AMOUNT);
    }

    function testInvestToStrategy_RevertsWithoutStrategy() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(owner);
        vm.expectRevert(YaultVault.StrategyNotSet.selector);
        vault.investToStrategy(DEPOSIT_AMOUNT);
    }

    function testInvestToStrategy_RevertsOnInsufficientIdle() public {
        _setupStrategy();

        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Try to invest more than deposited
        vm.prank(owner);
        vm.expectRevert(YaultVault.InsufficientIdleBalance.selector);
        vault.investToStrategy(DEPOSIT_AMOUNT + 1);
    }

    function testWithdrawFromStrategy() public {
        _setupStrategy();

        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Invest all
        vm.prank(owner);
        vault.investToStrategy(DEPOSIT_AMOUNT);

        assertEq(token.balanceOf(address(vault)), 0, "vault should have 0 idle");

        // Withdraw half back
        vm.prank(owner);
        vault.withdrawFromStrategy(DEPOSIT_AMOUNT / 2);

        assertEq(token.balanceOf(address(vault)), DEPOSIT_AMOUNT / 2, "vault should have half back");
        assertEq(aToken.balanceOf(address(vault)), DEPOSIT_AMOUNT / 2, "half still in Aave");
    }

    function testTotalAssets_IncludesAave() public {
        _setupStrategy();

        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Before invest
        assertEq(vault.totalAssets(), DEPOSIT_AMOUNT, "totalAssets before invest");

        // Invest all to Aave
        vm.prank(owner);
        vault.investToStrategy(DEPOSIT_AMOUNT);

        // totalAssets should still show full amount (idle=0 + aToken=DEPOSIT)
        assertEq(vault.totalAssets(), DEPOSIT_AMOUNT, "totalAssets after invest");
    }

    function testHarvest_WithAaveYield() public {
        _setupStrategy();

        // Alice deposits and sets authority
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        // Owner invests to Aave
        vm.prank(owner);
        vault.investToStrategy(DEPOSIT_AMOUNT);

        // Simulate Aave yield: 1000 USDC interest accrued on aTokens
        uint256 yieldAmount = 1_000e6;
        mockAave.simulateInterest(address(vault), yieldAmount);

        // totalAssets should now reflect yield
        assertEq(vault.totalAssets(), DEPOSIT_AMOUNT + yieldAmount, "totalAssets with yield");

        // Record balances before harvest
        uint256 principalBefore = vault.userPrincipal(alice);
        uint256 platformBefore = token.balanceOf(platform);

        // Harvest — this will auto-unwind from Aave to distribute
        vm.prank(alice);
        vault.harvest();

        // Expected splits: 75 % user (compounds), 20 % platform, 5 % authority
        uint256 expectedUser = (yieldAmount * 7500) / 10_000;     // 750
        uint256 expectedAuthority = (yieldAmount * 500) / 10_000;  // 50
        uint256 expectedPlatform = yieldAmount - expectedUser - expectedAuthority; // 200

        // User's 75 % compounds in vault (principal increases).
        assertApproxEqAbs(
            vault.userPrincipal(alice) - principalBefore,
            expectedUser,
            2, // small rounding tolerance from share conversion
            "alice principal should increase by 75% of Aave yield"
        );
        assertApproxEqAbs(
            token.balanceOf(platform) - platformBefore,
            expectedPlatform,
            2,
            "platform should receive 20% of Aave yield (authority bound)"
        );
        assertApproxEqAbs(
            vault.getPendingRevenue(authorityA),
            expectedAuthority,
            2,
            "authority should get 5% of Aave yield escrowed"
        );
    }

    function testWithdraw_AutoUnwindsAave() public {
        _setupStrategy();

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Owner invests ALL to Aave (vault has 0 idle)
        vm.prank(owner);
        vault.investToStrategy(DEPOSIT_AMOUNT);

        assertEq(token.balanceOf(address(vault)), 0, "vault idle should be 0");

        // Alice withdraws — should auto-unwind from Aave
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);

        assertEq(assets, DEPOSIT_AMOUNT, "should withdraw full deposit from Aave");
        assertEq(vault.balanceOf(alice), 0, "alice shares should be 0");
    }

    function testWithdraw_PartialAutoUnwind() public {
        _setupStrategy();

        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Invest 80% to Aave, keep 20% idle
        uint256 investAmount = (DEPOSIT_AMOUNT * 80) / 100;
        vm.prank(owner);
        vault.investToStrategy(investAmount);

        uint256 idleBefore = token.balanceOf(address(vault));
        assertEq(idleBefore, DEPOSIT_AMOUNT - investAmount, "20% idle");

        // Alice withdraws 50% — needs partial unwind
        uint256 halfShares = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.redeem(halfShares, alice, alice);

        // Vault should have unwound enough from Aave
        // alice got ~5000 USDC, vault had 2000 idle, needed 3000 from Aave
        assertGt(token.balanceOf(alice), INITIAL_BALANCE - DEPOSIT_AMOUNT, "alice got funds back");
    }

    // -----------------------------------------------------------------------
    //  C-05 transfer exemption tests
    // -----------------------------------------------------------------------

    function testTransfer_BlockedByC05() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Direct share transfer alice → bob should revert
        vm.prank(alice);
        vm.expectRevert(YaultVault.ShareTransfersDisabled.selector);
        vault.transfer(bob, 1e6);
    }

    function testTransferExempt_OnlyOwner() public {
        // Non-owner cannot set exemption
        vm.prank(alice);
        vm.expectRevert();
        vault.setTransferExempt(bob, true);
    }

    function testTransferExempt_RejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(YaultVault.ExemptZeroAddress.selector);
        vault.setTransferExempt(address(0), true);
    }

    function testTransferExempt_AllowsTransferToExemptAddress() public {
        address escrow = makeAddr("escrow");

        // Owner exempts the escrow address
        vm.prank(owner);
        vault.setTransferExempt(escrow, true);
        assertTrue(vault.transferExempt(escrow), "escrow should be exempt");

        // Alice deposits, then transfers shares to escrow
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 sharesToTransfer = vault.balanceOf(alice) / 2;

        vm.prank(alice);
        vault.transfer(escrow, sharesToTransfer);

        assertEq(vault.balanceOf(escrow), sharesToTransfer, "escrow should hold shares");
        assertEq(vault.balanceOf(alice), sharesToTransfer, "alice should have half");
    }

    function testTransferExempt_AllowsTransferFromExemptAddress() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits, transfers to escrow
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(escrow, shares);

        // Escrow transfers back to bob (escrow is exempt, so allowed)
        vm.prank(escrow);
        vault.transfer(bob, shares);

        assertEq(vault.balanceOf(bob), shares, "bob should receive shares from escrow");
        assertEq(vault.balanceOf(escrow), 0, "escrow should be empty");
    }

    function testTransferExempt_NonExemptStillBlocked() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Alice → bob still blocked (neither exempt)
        vm.prank(alice);
        vm.expectRevert(YaultVault.ShareTransfersDisabled.selector);
        vault.transfer(bob, 1e6);
    }

    function testTransferExempt_RevokeBlocks() public {
        address escrow = makeAddr("escrow");

        // Set exempt, then revoke
        vm.startPrank(owner);
        vault.setTransferExempt(escrow, true);
        vault.setTransferExempt(escrow, false);
        vm.stopPrank();

        assertFalse(vault.transferExempt(escrow), "escrow should no longer be exempt");

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Transfer to revoked escrow should revert
        vm.prank(alice);
        vm.expectRevert(YaultVault.ShareTransfersDisabled.selector);
        vault.transfer(escrow, 1e6);
    }

    function testTransferExempt_EscrowCanRedeem() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits, transfers all shares to escrow
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(escrow, shares);

        // Escrow redeems shares to bob (this is a burn, always allowed)
        vm.prank(escrow);
        uint256 assets = vault.redeem(shares, bob, escrow);

        assertEq(assets, DEPOSIT_AMOUNT, "bob should receive full underlying");
        assertEq(token.balanceOf(bob), INITIAL_BALANCE + DEPOSIT_AMOUNT, "bob balance mismatch");
        assertEq(vault.balanceOf(escrow), 0, "escrow should have 0 shares");
    }

    // -----------------------------------------------------------------------
    //  Principal tracking on exempt transfers (Fix #1)
    // -----------------------------------------------------------------------

    function testTransferExempt_PrincipalReducedOnSend() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 principalBefore = vault.userPrincipal(alice);
        assertEq(principalBefore, DEPOSIT_AMOUNT, "principal should equal deposit");

        // Alice transfers half shares to escrow
        uint256 shares = vault.balanceOf(alice);
        uint256 halfShares = shares / 2;

        vm.prank(alice);
        vault.transfer(escrow, halfShares);

        // Principal should be reduced proportionally (roughly halved)
        uint256 principalAfter = vault.userPrincipal(alice);
        assertApproxEqAbs(
            principalAfter,
            DEPOSIT_AMOUNT / 2,
            1, // 1 wei tolerance for rounding
            "principal should be halved after transferring half shares to escrow"
        );
    }

    function testTransferExempt_PrincipalFullyReducedOnFullTransfer() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 shares = vault.balanceOf(alice);

        // Alice transfers ALL shares to escrow
        vm.prank(alice);
        vault.transfer(escrow, shares);

        // Principal should be 0
        assertEq(vault.userPrincipal(alice), 0, "principal should be 0 after full transfer to escrow");
    }

    function testTransferExempt_PrincipalIncreasedOnReceiveFromExempt() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits, transfers to escrow
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(escrow, shares);

        // Escrow sends to bob — vault credits bob's principal so harvest only attributes yield above that
        vm.prank(escrow);
        vault.transfer(bob, shares);

        uint256 expectedPrincipal = vault.convertToAssets(shares);
        assertEq(vault.userPrincipal(bob), expectedPrincipal, "bob principal should equal asset value of shares received from exempt");
        assertEq(vault.balanceOf(bob), shares, "bob should hold the shares");
    }

    function testTransferExempt_HarvestWorksAfterPartialTransfer() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Transfer half to escrow
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(escrow, shares / 2);

        // Simulate yield
        _simulateYield(1_000e6);

        // Alice should be able to harvest on her remaining half
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 aliceAssets = vault.convertToAssets(aliceShares);
        uint256 alicePrincipal = vault.userPrincipal(alice);

        // Alice's assets should exceed her (reduced) principal
        assertGt(aliceAssets, alicePrincipal, "alice should have yield to harvest");

        // Harvest should succeed
        vm.prank(alice);
        vault.harvest();
    }

    function testTransferExempt_TransferFromWithApproval() public {
        address escrow = makeAddr("escrow");

        vm.prank(owner);
        vault.setTransferExempt(escrow, true);

        // Alice deposits
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        uint256 shares = vault.balanceOf(alice);

        // Alice approves escrow to pull shares (as in escrow.deposit safeTransferFrom)
        vm.prank(alice);
        vault.approve(escrow, shares);

        // Escrow pulls shares via transferFrom
        vm.prank(escrow);
        vault.transferFrom(alice, escrow, shares);

        // Verify shares moved and principal adjusted
        assertEq(vault.balanceOf(escrow), shares, "escrow should hold shares");
        assertEq(vault.balanceOf(alice), 0, "alice should have 0 shares");
        assertEq(vault.userPrincipal(alice), 0, "alice principal should be 0 after full transferFrom");
    }

    // -----------------------------------------------------------------------
    //  P0 FIX: totalAssets() excludes escrowed authority revenue
    // -----------------------------------------------------------------------

    function testTotalAssets_ExcludesAuthorityEscrow() public {
        // Alice deposits and sets authority
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        // Simulate yield
        uint256 yieldAmount = 1_000e6;
        _simulateYield(yieldAmount);

        // Harvest triggers authority escrow
        vm.prank(alice);
        vault.harvest();

        uint256 totalAfter = vault.totalAssets();
        uint256 escrowed = vault.totalEscrowedAuthorityRevenue();

        // totalAssets after harvest should be LESS than raw vault balance
        // because authority escrow is excluded
        assertGt(escrowed, 0, "authority escrow should be > 0");

        // The escrowed amount should NOT be reflected in totalAssets
        uint256 rawBalance = token.balanceOf(address(vault));
        assertEq(totalAfter, rawBalance - escrowed, "totalAssets should be raw balance minus escrow");
    }

    function testP0_AuthorityCantBeFrontRun() public {
        // Alice deposits, sets authority
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        // Simulate yield and harvest
        _simulateYield(1_000e6);
        vm.prank(alice);
        vault.harvest();

        uint256 authorityPending = vault.getPendingRevenue(authorityA);
        assertGt(authorityPending, 0, "authority should have pending revenue");

        // Alice redeems ALL her remaining shares
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);

        // After full redeem, authority escrow should still be intact
        uint256 remaining = token.balanceOf(address(vault));
        assertGe(remaining, authorityPending, "vault should still hold authority's escrowed revenue");

        // Authority can still claim
        vm.prank(authorityA);
        vault.claimAuthorityRevenue();
        assertEq(vault.getPendingRevenue(authorityA), 0, "authority should have claimed everything");
    }
}
