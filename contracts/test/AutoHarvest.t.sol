// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AutoHarvest} from "../src/AutoHarvest.sol";
import {YaultVault} from "../src/YaultVault.sol";

contract MockToken is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract AutoHarvestTest is Test {
    AutoHarvest public autoHarvest;
    YaultVault public vault;
    MockToken public usdc;

    address public owner = address(this);
    address public user1 = makeAddr("user1");
    address public platformFee = makeAddr("platform");
    address public forwarder = makeAddr("forwarder");

    function setUp() public {
        usdc = new MockToken();
        vault = new YaultVault(IERC20(address(usdc)), "Yault USDC", "yUSDC", owner, platformFee);
        autoHarvest = new AutoHarvest(owner);
    }

    function test_addTarget() public {
        autoHarvest.addTarget(address(vault), user1);
        assertEq(autoHarvest.getTargetCount(), 1);

        (address v, address u, bool active) = autoHarvest.targets(0);
        assertEq(v, address(vault));
        assertEq(u, user1);
        assertTrue(active);
    }

    function test_removeTarget() public {
        autoHarvest.addTarget(address(vault), user1);
        autoHarvest.removeTarget(0);

        (, , bool active) = autoHarvest.targets(0);
        assertFalse(active);
    }

    function test_setMinYieldThreshold() public {
        autoHarvest.setMinYieldThreshold(5e6); // 5 USDC
        assertEq(autoHarvest.minYieldThreshold(), 5e6);
    }

    function test_setMaxBatchSize() public {
        autoHarvest.setMaxBatchSize(20);
        assertEq(autoHarvest.maxBatchSize(), 20);
    }

    function test_setMaxBatchSize_tooLarge() public {
        vm.expectRevert(AutoHarvest.BatchSizeTooLarge.selector);
        autoHarvest.setMaxBatchSize(51);
    }

    function test_setAutomationForwarder() public {
        autoHarvest.setAutomationForwarder(forwarder);
        assertEq(autoHarvest.automationForwarder(), forwarder);
    }

    function test_checkUpkeep_noTargets() public {
        (bool needed,) = autoHarvest.checkUpkeep("");
        assertFalse(needed);
    }

    function test_checkUpkeep_noYield() public {
        autoHarvest.addTarget(address(vault), user1);

        // User deposits but no yield has accrued
        usdc.mint(user1, 1000e6);
        vm.startPrank(user1);
        usdc.approve(address(vault), 1000e6);
        vault.deposit(1000e6, user1);
        vm.stopPrank();

        (bool needed,) = autoHarvest.checkUpkeep("");
        assertFalse(needed);
    }

    function test_getEstimatedYield_noShares() public {
        autoHarvest.addTarget(address(vault), user1);
        uint256 yield_ = autoHarvest.getEstimatedYield(0);
        assertEq(yield_, 0);
    }

    function test_isTargetHarvestable_inactive() public {
        autoHarvest.addTarget(address(vault), user1);
        autoHarvest.removeTarget(0);
        assertFalse(autoHarvest.isTargetHarvestable(0));
    }

    function test_isTargetHarvestable_outOfBounds() public {
        assertFalse(autoHarvest.isTargetHarvestable(999));
    }

    function test_performUpkeep_accessControl() public {
        autoHarvest.setAutomationForwarder(forwarder);

        uint256[] memory indices = new uint256[](0);
        bytes memory performData = abi.encode(indices);

        // Random address cannot perform upkeep
        vm.prank(user1);
        vm.expectRevert(AutoHarvest.OnlyAutomationForwarder.selector);
        autoHarvest.performUpkeep(performData);

        // Forwarder can
        vm.prank(forwarder);
        autoHarvest.performUpkeep(performData);
    }

    function test_performUpkeep_ownerBypass() public {
        autoHarvest.setAutomationForwarder(forwarder);

        uint256[] memory indices = new uint256[](0);
        bytes memory performData = abi.encode(indices);

        // Owner can also perform upkeep
        autoHarvest.performUpkeep(performData);
    }

    function test_getTargetCount() public {
        assertEq(autoHarvest.getTargetCount(), 0);
        autoHarvest.addTarget(address(vault), user1);
        assertEq(autoHarvest.getTargetCount(), 1);
    }

    function test_getHistoryCount_empty() public {
        assertEq(autoHarvest.getHistoryCount(), 0);
    }

    function test_onlyOwner() public {
        vm.startPrank(user1);

        vm.expectRevert();
        autoHarvest.addTarget(address(vault), user1);

        vm.expectRevert();
        autoHarvest.removeTarget(0);

        vm.expectRevert();
        autoHarvest.setMinYieldThreshold(1);

        vm.stopPrank();
    }
}
