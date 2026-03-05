// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PortfolioAnalytics} from "../src/PortfolioAnalytics.sol";

/// @dev Mock Functions Router for testing.
contract MockFunctionsRouter {
    bytes32 public lastRequestId;
    uint256 private _nonce;

    function sendRequest(
        uint64,
        bytes calldata,
        uint16,
        uint32,
        bytes32
    ) external returns (bytes32 requestId) {
        _nonce++;
        requestId = keccak256(abi.encodePacked(_nonce, block.timestamp));
        lastRequestId = requestId;
    }
}

contract PortfolioAnalyticsTest is Test {
    PortfolioAnalytics public analytics;
    MockFunctionsRouter public router;

    address public owner = address(this);
    address public user = address(0xBEEF);
    uint64 public constant SUB_ID = 1;
    bytes32 public constant DON_ID = bytes32(uint256(1));

    string public constant SAMPLE_SOURCE = "return Functions.encodeUint256(42);";

    function setUp() public {
        router = new MockFunctionsRouter();
        analytics = new PortfolioAnalytics(owner, address(router), SUB_ID, DON_ID);

        // Set the analytics source
        analytics.setAnalyticsSource(SAMPLE_SOURCE);
    }

    // -----------------------------------------------------------------------
    //  Constructor Tests
    // -----------------------------------------------------------------------

    function test_constructor_revert_zeroRouter() public {
        vm.expectRevert(PortfolioAnalytics.ZeroAddress.selector);
        new PortfolioAnalytics(owner, address(0), SUB_ID, DON_ID);
    }

    function test_constructor_setsState() public view {
        assertEq(address(analytics.functionsRouter()), address(router));
        assertEq(analytics.subscriptionId(), SUB_ID);
        assertEq(analytics.donId(), DON_ID);
    }

    // -----------------------------------------------------------------------
    //  Admin Tests
    // -----------------------------------------------------------------------

    function test_setAnalyticsSource() public {
        string memory newSource = "return 1;";
        analytics.setAnalyticsSource(newSource);
        assertEq(analytics.analyticsSource(), newSource);
    }

    function test_setAnalyticsSource_onlyOwner() public {
        vm.prank(user);
        vm.expectRevert();
        analytics.setAnalyticsSource("bad");
    }

    function test_setSubscriptionId() public {
        analytics.setSubscriptionId(42);
        assertEq(analytics.subscriptionId(), 42);
    }

    function test_setDonId() public {
        bytes32 newDon = bytes32(uint256(99));
        analytics.setDonId(newDon);
        assertEq(analytics.donId(), newDon);
    }

    function test_setCallbackGasLimit() public {
        analytics.setCallbackGasLimit(500_000);
        assertEq(analytics.callbackGasLimit(), 500_000);
    }

    function test_setMinRequestInterval() public {
        analytics.setMinRequestInterval(2 hours);
        assertEq(analytics.minRequestInterval(), 2 hours);
    }

    // -----------------------------------------------------------------------
    //  Request Analytics Tests
    // -----------------------------------------------------------------------

    function test_requestAnalytics() public {
        string[] memory vaults = new string[](2);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        vaults[1] = "0x2222222222222222222222222222222222222222";

        bytes32 requestId = analytics.requestAnalytics(user, vaults);
        assertTrue(requestId != bytes32(0));

        // Check pending request
        (address reqUser, uint64 reqTimestamp, bool pending) = analytics.pendingRequests(requestId);
        assertEq(reqUser, user);
        assertEq(reqTimestamp, uint64(block.timestamp));
        assertTrue(pending);

        // Check tracking state
        assertEq(analytics.userRequestCount(user), 1);
        assertEq(analytics.lastRequestTime(user), block.timestamp);
    }

    function test_requestAnalytics_noSource() public {
        PortfolioAnalytics fresh = new PortfolioAnalytics(owner, address(router), SUB_ID, DON_ID);

        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";

        vm.expectRevert(PortfolioAnalytics.NoAnalyticsSource.selector);
        fresh.requestAnalytics(user, vaults);
    }

    function test_requestAnalytics_rateLimited() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";

        analytics.requestAnalytics(user, vaults);

        // Second request within interval should revert
        vm.expectRevert(abi.encodeWithSelector(
            PortfolioAnalytics.RequestTooFrequent.selector,
            user,
            block.timestamp + analytics.minRequestInterval()
        ));
        analytics.requestAnalytics(user, vaults);
    }

    function test_requestAnalytics_afterInterval() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";

        analytics.requestAnalytics(user, vaults);

        // Advance time
        vm.warp(block.timestamp + analytics.minRequestInterval() + 1);

        bytes32 requestId2 = analytics.requestAnalytics(user, vaults);
        assertTrue(requestId2 != bytes32(0));
        assertEq(analytics.userRequestCount(user), 2);
    }

    function test_requestAnalytics_accessControl() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";

        // Random address can't request for another user
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(PortfolioAnalytics.OnlyUserOrOwner.selector);
        analytics.requestAnalytics(user, vaults);

        // User can request for themselves
        vm.prank(user);
        bytes32 requestId = analytics.requestAnalytics(user, vaults);
        assertTrue(requestId != bytes32(0));
    }

    // -----------------------------------------------------------------------
    //  Fulfillment Tests
    // -----------------------------------------------------------------------

    function test_handleOracleFulfillment_success() public {
        // First, make a request
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        bytes32 requestId = analytics.requestAnalytics(user, vaults);

        // Encode response: (uint256, uint256, uint16, uint16, uint256, uint256)
        bytes memory response = abi.encode(
            uint256(1000e18),  // portfolioValueUSD
            uint256(50e18),    // totalYieldEarned
            uint16(3000),      // riskScore (30%)
            uint16(500),       // apyBps (5%)
            uint256(1500),     // sharpeRatioX1000 (1.5)
            uint256(1500)      // maxDrawdownBps (15%)
        );

        // Fulfill from the router
        vm.prank(address(router));
        analytics.handleOracleFulfillment(requestId, response, "");

        // Check stored result
        PortfolioAnalytics.AnalyticsResult memory result = analytics.getAnalytics(user);
        assertEq(result.portfolioValueUSD, 1000e18);
        assertEq(result.totalYieldEarned, 50e18);
        assertEq(result.riskScore, 3000);
        assertEq(result.apyBps, 500);
        assertEq(result.sharpeRatioX1000, 1500);
        assertEq(result.maxDrawdownBps, 1500);
        assertTrue(result.valid);
        assertEq(result.timestamp, block.timestamp);

        // Request should no longer be pending
        (, , bool pending) = analytics.pendingRequests(requestId);
        assertFalse(pending);
    }

    function test_handleOracleFulfillment_withError() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        bytes32 requestId = analytics.requestAnalytics(user, vaults);

        vm.prank(address(router));
        analytics.handleOracleFulfillment(requestId, "", "some error");

        // Result should NOT be set
        PortfolioAnalytics.AnalyticsResult memory result = analytics.getAnalytics(user);
        assertFalse(result.valid);
    }

    function test_handleOracleFulfillment_responseTooShort() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        bytes32 requestId = analytics.requestAnalytics(user, vaults);

        // Send a short response (32 bytes, less than the required 192)
        bytes memory shortResponse = abi.encode(uint256(42));

        vm.prank(address(router));
        analytics.handleOracleFulfillment(requestId, shortResponse, "");

        // Result should NOT be set (emits AnalyticsFailed)
        PortfolioAnalytics.AnalyticsResult memory result = analytics.getAnalytics(user);
        assertFalse(result.valid);
    }

    function test_handleOracleFulfillment_onlyRouter() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        bytes32 requestId = analytics.requestAnalytics(user, vaults);

        vm.prank(user);
        vm.expectRevert(PortfolioAnalytics.OnlyFunctionsRouter.selector);
        analytics.handleOracleFulfillment(requestId, "", "");
    }

    function test_handleOracleFulfillment_notPending() public {
        bytes32 fakeRequestId = keccak256("fake");

        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(
            PortfolioAnalytics.RequestNotPending.selector, fakeRequestId
        ));
        analytics.handleOracleFulfillment(fakeRequestId, "", "");
    }

    // -----------------------------------------------------------------------
    //  View Tests
    // -----------------------------------------------------------------------

    function test_hasValidAnalytics_noData() public view {
        assertFalse(analytics.hasValidAnalytics(user, 1 hours));
    }

    function test_hasValidAnalytics_fresh() public {
        // Submit and fulfill
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        bytes32 requestId = analytics.requestAnalytics(user, vaults);

        bytes memory response = abi.encode(
            uint256(1000e18), uint256(50e18), uint16(3000), uint16(500), uint256(1500), uint256(1500)
        );
        vm.prank(address(router));
        analytics.handleOracleFulfillment(requestId, response, "");

        assertTrue(analytics.hasValidAnalytics(user, 1 hours));
    }

    function test_hasValidAnalytics_stale() public {
        string[] memory vaults = new string[](1);
        vaults[0] = "0x1111111111111111111111111111111111111111";
        bytes32 requestId = analytics.requestAnalytics(user, vaults);

        bytes memory response = abi.encode(
            uint256(1000e18), uint256(50e18), uint16(3000), uint16(500), uint256(1500), uint256(1500)
        );
        vm.prank(address(router));
        analytics.handleOracleFulfillment(requestId, response, "");

        // Advance time past maxAge
        vm.warp(block.timestamp + 2 hours);
        assertFalse(analytics.hasValidAnalytics(user, 1 hours));
    }
}
