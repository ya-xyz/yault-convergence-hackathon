// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ChainlinkPriceFeedTracker} from "../src/ChainlinkPriceFeedTracker.sol";
import {YaultVault} from "../src/YaultVault.sol";
import {AggregatorV3Interface} from "../src/interfaces/IChainlinkPriceFeed.sol";

// ─── Mock Contracts ───

contract MockERC20 is ERC20 {
    uint8 private _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) {
        _dec = dec_;
    }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockPriceFeed is AggregatorV3Interface {
    int256 private _price;
    uint8 private _decimals;
    uint256 private _updatedAt;

    constructor(int256 price_, uint8 decimals_) {
        _price = price_;
        _decimals = decimals_;
        _updatedAt = block.timestamp;
    }

    function setPrice(int256 newPrice) external { _price = newPrice; _updatedAt = block.timestamp; }
    function setUpdatedAt(uint256 ts) external { _updatedAt = ts; }

    function decimals() external view override returns (uint8) { return _decimals; }
    function description() external pure override returns (string memory) { return "USDC/USD"; }
    function version() external pure override returns (uint256) { return 1; }

    function getRoundData(uint80) external view override
        returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _price, block.timestamp, _updatedAt, 1);
    }

    function latestRoundData() external view override
        returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _price, block.timestamp, _updatedAt, 1);
    }
}

// ─── Tests ───

contract ChainlinkPriceFeedTrackerTest is Test {
    ChainlinkPriceFeedTracker public tracker;
    YaultVault public vault;
    MockERC20 public usdc;
    MockPriceFeed public usdcFeed;

    address public owner = address(this);
    address public user1 = makeAddr("user1");
    address public platformFee = makeAddr("platform");

    function setUp() public {
        // Deploy mock USDC
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy vault
        vault = new YaultVault(
            IERC20(address(usdc)), "Yault USDC", "yUSDC", owner, platformFee
        );

        // Deploy mock price feed (USDC = $1.00, 8 decimals)
        usdcFeed = new MockPriceFeed(1e8, 8);

        // Deploy tracker
        tracker = new ChainlinkPriceFeedTracker(owner);
    }

    function test_registerVaultFeed() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        (,,,, bool active) = tracker.vaultFeeds(address(vault));
        assertTrue(active);
        assertEq(tracker.getRegisteredVaultCount(), 1);
    }

    function test_registerVaultFeed_revertsDuplicate() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));
        vm.expectRevert(ChainlinkPriceFeedTracker.VaultAlreadyRegistered.selector);
        tracker.registerVaultFeed(address(vault), address(usdcFeed));
    }

    function test_removeVaultFeed() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));
        tracker.removeVaultFeed(address(vault));

        (,,,, bool active) = tracker.vaultFeeds(address(vault));
        assertFalse(active);
        assertEq(tracker.getRegisteredVaultCount(), 0);
    }

    function test_getPortfolioValue_withDeposit() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        // User deposits 1000 USDC
        usdc.mint(user1, 1000e6);
        vm.startPrank(user1);
        usdc.approve(address(vault), 1000e6);
        vault.deposit(1000e6, user1);
        vm.stopPrank();

        (uint256 totalUSD, ChainlinkPriceFeedTracker.VaultPosition[] memory positions) =
            tracker.getPortfolioValue(user1);

        // 1000 USDC * $1.00 = $1000 (18 decimals)
        assertGt(totalUSD, 0);
        assertEq(positions.length, 1);
        assertEq(positions[0].vault, address(vault));
        assertGt(positions[0].shares, 0);
        assertGt(positions[0].valueUSD, 0);
    }

    function test_getPortfolioValue_zeroBalance() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        (uint256 totalUSD,) = tracker.getPortfolioValue(user1);
        assertEq(totalUSD, 0);
    }

    function test_getAssetPrice() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        (int256 price, uint8 dec) = tracker.getAssetPrice(address(vault));
        assertEq(price, 1e8);
        assertEq(dec, 8);
    }

    function test_getShareValueUSD() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        // Deposit first
        usdc.mint(user1, 500e6);
        vm.startPrank(user1);
        usdc.approve(address(vault), 500e6);
        uint256 shares = vault.deposit(500e6, user1);
        vm.stopPrank();

        uint256 valueUSD = tracker.getShareValueUSD(address(vault), shares);
        assertGt(valueUSD, 0);
    }

    function test_stalePrice_reverts() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));
        tracker.setMaxStaleness(600); // 10 minutes

        // Make price stale
        usdcFeed.setUpdatedAt(block.timestamp - 601);

        vm.expectRevert();
        tracker.getAssetPrice(address(vault));
    }

    function test_negativePrice_reverts() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));
        usdcFeed.setPrice(-1);

        vm.expectRevert();
        tracker.getAssetPrice(address(vault));
    }

    function test_takeSnapshot() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        usdc.mint(user1, 1000e6);
        vm.startPrank(user1);
        usdc.approve(address(vault), 1000e6);
        vault.deposit(1000e6, user1);
        vm.stopPrank();

        tracker.takeSnapshot(user1);

        assertEq(tracker.getSnapshotCount(user1), 1);
        ChainlinkPriceFeedTracker.PortfolioSnapshot memory snap = tracker.getLatestSnapshot(user1);
        assertGt(snap.totalValueUSD, 0);
        assertEq(snap.vaultCount, 1);
    }

    function test_multipleSnapshots() public {
        tracker.registerVaultFeed(address(vault), address(usdcFeed));

        usdc.mint(user1, 1000e6);
        vm.startPrank(user1);
        usdc.approve(address(vault), 1000e6);
        vault.deposit(1000e6, user1);
        vm.stopPrank();

        tracker.takeSnapshot(user1);

        // Price doubles
        usdcFeed.setPrice(2e8);
        skip(1);
        tracker.takeSnapshot(user1);

        assertEq(tracker.getSnapshotCount(user1), 2);
        ChainlinkPriceFeedTracker.PortfolioSnapshot memory snap1 = tracker.getSnapshot(user1, 0);
        ChainlinkPriceFeedTracker.PortfolioSnapshot memory snap2 = tracker.getSnapshot(user1, 1);
        assertGt(snap2.totalValueUSD, snap1.totalValueUSD);
    }

    function test_setMaxStaleness() public {
        tracker.setMaxStaleness(7200);
        assertEq(tracker.maxStaleness(), 7200);
    }

    function test_onlyOwner_registerVaultFeed() public {
        vm.prank(user1);
        vm.expectRevert();
        tracker.registerVaultFeed(address(vault), address(usdcFeed));
    }
}
