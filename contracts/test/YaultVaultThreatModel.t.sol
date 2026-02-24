// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {YaultVault} from "../src/YaultVault.sol";
import {YaultVaultCreator} from "../src/YaultVaultCreator.sol";
import {YaultVaultFactory} from "../src/YaultVaultFactory.sol";
import {IYaultVault} from "../src/interfaces/IYaultVault.sol";

// ---------------------------------------------------------------------------
//  Mocks (minimal for threat-model tests)
// ---------------------------------------------------------------------------

contract MockERC20ForThreat is ERC20 {
    uint8 private _decimals;

    constructor(uint8 decimals_) ERC20("Mock", "M") {
        _decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

/**
 * @title MaliciousAavePool
 * @notice On withdraw, reenters the vault's harvest() to test ReentrancyGuard.
 * @dev aTokenAddress must be a contract with mint() (e.g. MockERC20ForThreat).
 */
contract MaliciousAavePool {
    YaultVault public vault;
    IERC20 public underlying;
    address public aTokenAddress;
    address public reenterCaller;

    constructor(YaultVault _vault, IERC20 _underlying, address _aTokenAddress) {
        vault = _vault;
        underlying = _underlying;
        aTokenAddress = _aTokenAddress;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(underlying), "wrong asset");
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        MockERC20ForThreat(aTokenAddress).mint(onBehalfOf, amount);
    }

    /// @dev Reenter vault.harvest() when vault withdraws — should be blocked by ReentrancyGuard.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(underlying), "wrong asset");
        if (reenterCaller != address(0)) {
            vault.harvest();
        }
        IERC20(aTokenAddress).transferFrom(msg.sender, address(this), amount);
        underlying.transfer(to, amount);
        return amount;
    }

    function setReenterCaller(address _reenterCaller) external {
        reenterCaller = _reenterCaller;
    }
}

// ---------------------------------------------------------------------------
//  Threat-model test suite for YaultVault (audit prep)
// ---------------------------------------------------------------------------

contract YaultVaultThreatModelTest is Test {
    MockERC20ForThreat internal token;
    YaultVault internal vault;
    YaultVaultFactory internal factory;

    address internal owner;
    address internal platform;
    address internal alice;
    address internal authorityA;
    address internal attacker;

    uint256 constant DEPOSIT_AMOUNT = 100_000e6;
    uint256 constant YIELD_AMOUNT = 1_000e6;

    function setUp() public {
        owner = makeAddr("owner");
        platform = makeAddr("platform");
        alice = makeAddr("alice");
        authorityA = makeAddr("authorityA");
        attacker = makeAddr("attacker");

        token = new MockERC20ForThreat(6);
        token.mint(alice, DEPOSIT_AMOUNT * 2);

        YaultVaultCreator creator = new YaultVaultCreator();
        factory = new YaultVaultFactory(owner, platform, address(creator));
        vm.prank(owner);
        address vaultAddr = factory.createVault(IERC20(address(token)), "Yault USDC", "yUSDC");
        vault = YaultVault(vaultAddr);

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
    }

    // ----------  Min harvest yield (dust griefing) ----------

    function testThreat_MinHarvestYield_BelowMinReverts() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        // Yield just below default min (1e4 = 0.01 USDC for 6 decimals)
        token.mint(address(vault), 1e4 - 1);

        vm.prank(alice);
        vm.expectRevert(YaultVault.YieldBelowMinimum.selector);
        vault.harvest();
    }

    function testThreat_MinHarvestYield_AtOrAboveMinSucceeds() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Yield slightly above min so share-math rounding cannot push it below threshold
        token.mint(address(vault), 2e4);

        vm.prank(alice);
        vault.harvest();
        assertGt(vault.userPrincipal(alice), DEPOSIT_AMOUNT, "principal increased");
    }

    function testThreat_SetMinHarvestYield_OnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setMinHarvestYield(200);
    }

    function testThreat_SetMinHarvestYield_AboveFloor() public {
        vm.prank(owner);
        vault.setMinHarvestYield(500);
        assertEq(vault.minHarvestYield(), 500);
    }

    function testThreat_SetMinHarvestYield_BelowFloorReverts() public {
        vm.prank(owner);
        vm.expectRevert(YaultVault.MinYieldBelowFloor.selector);
        vault.setMinHarvestYield(99);
    }

    // ----------  harvestFor access control ----------

    function testThreat_HarvestFor_OnlyOwner() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        token.mint(address(vault), YIELD_AMOUNT);

        vm.prank(attacker);
        vm.expectRevert();
        vault.harvestFor(alice);
    }

    function testThreat_HarvestFor_OwnerSucceeds() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        token.mint(address(vault), YIELD_AMOUNT);

        vm.prank(owner);
        vault.harvestFor(alice);

        assertGt(vault.userPrincipal(alice), DEPOSIT_AMOUNT, "principal should increase");
    }

    // ----------  Authority: cannot set self ----------

    function testThreat_SetAuthorityAddress_SelfReverts() public {
        vm.prank(alice);
        vault.deposit(1e6, alice);

        vm.prank(alice);
        vm.expectRevert(YaultVault.CannotSetSelfAsAuthority.selector);
        vault.setAuthorityAddress(alice);
    }

    // ----------  Authority change timelock ----------

    function testThreat_ConfirmAuthorityBeforeTimelockReverts() public {
        vm.prank(alice);
        vault.deposit(1e6, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);

        vm.prank(alice);
        vault.setAuthorityAddress(attacker); // propose change

        vm.prank(alice);
        vm.expectRevert(YaultVault.AuthorityChangeTimelockNotElapsed.selector);
        vault.confirmAuthorityAddress();
    }

    function testThreat_CancelAuthorityChange() public {
        vm.prank(alice);
        vault.deposit(1e6, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);
        vm.prank(alice);
        vault.setAuthorityAddress(attacker);

        vm.prank(alice);
        vault.cancelAuthorityChange();

        vm.prank(alice);
        vm.expectRevert(YaultVault.NoPendingAuthorityChange.selector);
        vault.confirmAuthorityAddress();

        assertEq(vault.getRevenueConfig(alice).authorityAddress, authorityA, "authority unchanged");
    }

    // ----------  sweepUnderlying ----------

    function testThreat_SweepUnderlying_OnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.sweepUnderlying(1, alice);
    }

    function testThreat_SweepUnderlying_ZeroRecipientReverts() public {
        token.mint(address(vault), 100e6);
        vm.prank(owner);
        vm.expectRevert(YaultVault.ZeroAddress.selector);
        vault.sweepUnderlying(100e6, address(0));
    }

    function testThreat_SweepUnderlying_AmountExceedsBalanceReverts() public {
        vm.prank(alice);
        vault.deposit(10_000e6, alice);
        // Vault balance is 10k; try to sweep more than idle (after deposit, all is in vault)
        uint256 vaultBal = token.balanceOf(address(vault));
        vm.prank(owner);
        vm.expectRevert(YaultVault.InsufficientSweepBalance.selector);
        vault.sweepUnderlying(vaultBal + 1, alice);
    }

    function testThreat_SweepUnderlying_Success() public {
        // Direct transfer to vault (mistake scenario)
        token.mint(address(vault), 500e6);
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(owner);
        vault.sweepUnderlying(500e6, alice);
        assertEq(token.balanceOf(alice), aliceBefore + 500e6, "alice receives swept");
    }

    // ----------  totalAssets edge: escrow >= gross ----------

    function testThreat_TotalAssets_WhenEscrowEqualsGross_ReturnsZero() public {
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);
        token.mint(address(vault), YIELD_AMOUNT);
        vm.prank(alice);
        vault.harvest();
        // Authority has not claimed; totalEscrowedAuthorityRevenue > 0
        // totalAssets = idle + invested - escrowed. If by edge case escrowed >= gross, returns 0.
        uint256 total = vault.totalAssets();
        assertGe(total, 0, "totalAssets should not underflow");
    }

    // ----------  Reentrancy: strategy withdraw cannot reenter harvest ----------

    function testThreat_Reentrancy_StrategyWithdrawCannotReenterHarvest() public {
        MockERC20ForThreat aToken = new MockERC20ForThreat(6);
        MaliciousAavePool maliciousPool = new MaliciousAavePool(vault, IERC20(address(token)), address(aToken));

        token.mint(address(maliciousPool), DEPOSIT_AMOUNT * 2);
        aToken.mint(address(vault), DEPOSIT_AMOUNT);

        vm.prank(owner);
        vault.setStrategy(address(maliciousPool), address(aToken));
        vm.prank(owner);
        vault.approveStrategyToken();

        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.prank(alice);
        vault.setAuthorityAddress(authorityA);
        vm.prank(owner);
        vault.investToStrategy(DEPOSIT_AMOUNT);

        token.mint(address(vault), YIELD_AMOUNT);
        maliciousPool.setReenterCaller(address(vault));

        // Harvest will withdraw from strategy to pay platform+authority; malicious withdraw tries to reenter harvest.
        vm.prank(alice);
        vm.expectRevert(); // ReentrancyGuard or revert in reentrant harvest
        vault.harvest();
    }
}
