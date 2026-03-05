// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IFunctionsRouter, IFunctionsClient} from "./interfaces/IFunctionsClient.sol";

/**
 * @title PortfolioAnalytics
 * @author Yault
 * @notice Chainlink Functions consumer for off-chain portfolio analytics.
 *
 * @dev Uses Chainlink Functions to compute complex portfolio metrics off-chain:
 *      - Portfolio risk score (Sharpe ratio, max drawdown)
 *      - Multi-asset correlation analysis
 *      - Yield projection and APY calculations
 *      - Historical performance attribution
 *
 *      The JavaScript source runs on the Chainlink DON, fetches vault data
 *      from multiple sources, and returns computed analytics on-chain.
 *      Results are stored per-user and can be queried by the frontend.
 *
 *      Flow:
 *      1. Owner (or user) requests analytics via requestAnalytics()
 *      2. Chainlink DON executes JavaScript source off-chain
 *      3. DON returns result via handleOracleFulfillment()
 *      4. Analytics stored in analyticsResults mapping
 */
contract PortfolioAnalytics is Ownable, IFunctionsClient {
    // -----------------------------------------------------------------------
    //  Types
    // -----------------------------------------------------------------------

    struct AnalyticsResult {
        uint256 portfolioValueUSD;     // 18 decimals
        uint256 totalYieldEarned;      // 18 decimals
        uint16 riskScore;              // 0-10000 (basis points, 100 = 1%)
        uint16 apyBps;                // APY in basis points (e.g. 500 = 5%)
        uint256 sharpeRatioX1000;      // Sharpe ratio * 1000 (e.g. 1500 = 1.5)
        uint256 maxDrawdownBps;        // Max drawdown in basis points
        uint256 timestamp;
        bool valid;
    }

    struct PendingRequest {
        address user;
        uint64 requestTimestamp;
        bool pending;
    }

    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    /// @notice Chainlink Functions Router.
    IFunctionsRouter public immutable functionsRouter;

    /// @notice Chainlink Functions subscription ID.
    uint64 public subscriptionId;

    /// @notice Chainlink Functions DON ID.
    bytes32 public donId;

    /// @notice Callback gas limit for Functions responses.
    uint32 public callbackGasLimit = 300_000;

    /// @notice JavaScript source code for analytics computation.
    string public analyticsSource;

    /// @notice Latest analytics results per user.
    mapping(address => AnalyticsResult) public analyticsResults;

    /// @notice Pending requests (requestId => PendingRequest).
    mapping(bytes32 => PendingRequest) public pendingRequests;

    /// @notice Request count per user (for rate limiting).
    mapping(address => uint256) public userRequestCount;

    /// @notice Minimum interval between requests per user.
    uint256 public minRequestInterval = 1 hours;

    /// @notice Last request time per user.
    mapping(address => uint256) public lastRequestTime;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event AnalyticsRequested(bytes32 indexed requestId, address indexed user);
    event AnalyticsFulfilled(bytes32 indexed requestId, address indexed user, uint16 riskScore, uint16 apyBps);
    event AnalyticsFailed(bytes32 indexed requestId, address indexed user, bytes error);
    event AnalyticsSourceUpdated(uint256 sourceLength);
    event SubscriptionIdUpdated(uint64 oldId, uint64 newId);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error NoAnalyticsSource();
    error RequestTooFrequent(address user, uint256 nextAllowed);
    error OnlyFunctionsRouter();
    error RequestNotPending(bytes32 requestId);
    error InvalidResponse();
    error OnlyUserOrOwner();

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor(
        address initialOwner,
        address _functionsRouter,
        uint64 _subscriptionId,
        bytes32 _donId
    ) Ownable(initialOwner) {
        if (_functionsRouter == address(0)) revert ZeroAddress();
        functionsRouter = IFunctionsRouter(_functionsRouter);
        subscriptionId = _subscriptionId;
        donId = _donId;
    }

    // -----------------------------------------------------------------------
    //  Admin
    // -----------------------------------------------------------------------

    /// @notice Set the JavaScript analytics source code.
    function setAnalyticsSource(string calldata source) external onlyOwner {
        analyticsSource = source;
        emit AnalyticsSourceUpdated(bytes(source).length);
    }

    /// @notice Update the Functions subscription ID.
    function setSubscriptionId(uint64 newId) external onlyOwner {
        uint64 old = subscriptionId;
        subscriptionId = newId;
        emit SubscriptionIdUpdated(old, newId);
    }

    /// @notice Update the DON ID.
    function setDonId(bytes32 newDonId) external onlyOwner {
        donId = newDonId;
    }

    /// @notice Update the callback gas limit.
    function setCallbackGasLimit(uint32 gasLimit) external onlyOwner {
        callbackGasLimit = gasLimit;
    }

    /// @notice Update the minimum request interval.
    function setMinRequestInterval(uint256 interval) external onlyOwner {
        minRequestInterval = interval;
    }

    // -----------------------------------------------------------------------
    //  Request Analytics
    // -----------------------------------------------------------------------

    /// @notice Request portfolio analytics for a user.
    /// @param user The user address to analyze.
    /// @param vaultAddresses ABI-encoded array of vault addresses to analyze.
    /// @return requestId The Chainlink Functions request ID.
    function requestAnalytics(address user, string[] calldata vaultAddresses)
        external
        returns (bytes32 requestId)
    {
        // Access control: only the user themselves or the owner can request analytics
        if (msg.sender != user && msg.sender != owner()) {
            revert OnlyUserOrOwner();
        }

        if (bytes(analyticsSource).length == 0) revert NoAnalyticsSource();

        // Rate limiting
        if (block.timestamp < lastRequestTime[user] + minRequestInterval) {
            revert RequestTooFrequent(user, lastRequestTime[user] + minRequestInterval);
        }

        // Build args: [userAddress, vault1, vault2, ...]
        string[] memory args = new string[](1 + vaultAddresses.length);
        args[0] = _addressToString(user);
        for (uint256 i; i < vaultAddresses.length;) {
            args[i + 1] = vaultAddresses[i];
            unchecked { ++i; }
        }

        // Encode the Functions request
        bytes memory encodedRequest = abi.encode(
            uint8(0), // JavaScript
            analyticsSource,
            bytes(""), // no encrypted secrets
            args,
            new bytes[](0) // no bytes args
        );

        requestId = functionsRouter.sendRequest(
            subscriptionId,
            encodedRequest,
            1, // data version
            callbackGasLimit,
            donId
        );

        pendingRequests[requestId] = PendingRequest({
            user: user,
            requestTimestamp: uint64(block.timestamp),
            pending: true
        });

        lastRequestTime[user] = block.timestamp;
        userRequestCount[user]++;

        emit AnalyticsRequested(requestId, user);
    }

    // -----------------------------------------------------------------------
    //  Chainlink Functions Callback
    // -----------------------------------------------------------------------

    /// @notice Called by the Functions router with the response.
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) external override {
        if (msg.sender != address(functionsRouter)) revert OnlyFunctionsRouter();

        PendingRequest storage req = pendingRequests[requestId];
        if (!req.pending) revert RequestNotPending(requestId);
        req.pending = false;

        address user = req.user;

        if (err.length > 0) {
            emit AnalyticsFailed(requestId, user, err);
            return;
        }

        if (response.length < 192) {
            emit AnalyticsFailed(requestId, user, "response too short");
            return;
        }

        // Decode response: (portfolioValueUSD, totalYieldEarned, riskScore, apyBps, sharpeRatioX1000, maxDrawdownBps)
        (
            uint256 portfolioValue,
            uint256 yieldEarned,
            uint16 risk,
            uint16 apy,
            uint256 sharpe,
            uint256 maxDD
        ) = abi.decode(response, (uint256, uint256, uint16, uint16, uint256, uint256));

        analyticsResults[user] = AnalyticsResult({
            portfolioValueUSD: portfolioValue,
            totalYieldEarned: yieldEarned,
            riskScore: risk,
            apyBps: apy,
            sharpeRatioX1000: sharpe,
            maxDrawdownBps: maxDD,
            timestamp: block.timestamp,
            valid: true
        });

        emit AnalyticsFulfilled(requestId, user, risk, apy);
    }

    // -----------------------------------------------------------------------
    //  View
    // -----------------------------------------------------------------------

    /// @notice Get the latest analytics for a user.
    function getAnalytics(address user)
        external
        view
        returns (AnalyticsResult memory)
    {
        return analyticsResults[user];
    }

    /// @notice Check if analytics exist and are fresh (within maxAge seconds).
    function hasValidAnalytics(address user, uint256 maxAge)
        external
        view
        returns (bool)
    {
        AnalyticsResult storage result = analyticsResults[user];
        return result.valid && (block.timestamp - result.timestamp <= maxAge);
    }

    // -----------------------------------------------------------------------
    //  Internal
    // -----------------------------------------------------------------------

    function _addressToString(address addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory result = new bytes(42);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i; i < 20;) {
            result[2 + i * 2] = alphabet[uint8(uint160(addr) >> (8 * (19 - i)) >> 4)];
            result[3 + i * 2] = alphabet[uint8(uint160(addr) >> (8 * (19 - i))) & 0x0f];
            unchecked { ++i; }
        }
        return string(result);
    }
}
