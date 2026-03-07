// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/IChainlinkPriceFeed.sol";

/**
 * @title ChainlinkPriceFeedTracker
 * @author Yault
 * @notice Real-time portfolio valuation using Chainlink Data Feeds.
 *
 * @dev Tracks multiple YaultVault positions and calculates their USD value
 *      using Chainlink price oracles. Supports:
 *      - Multiple vaults with different underlying assets
 *      - Per-user portfolio valuation across all vaults
 *      - Historical NAV snapshots for performance tracking
 *      - Stale price detection with configurable heartbeat
 *
 *      Each vault is registered with its Chainlink price feed (asset/USD).
 *      Portfolio value = sum(vault_shares * share_price * asset_usd_price)
 *      for all registered vaults.
 */
contract ChainlinkPriceFeedTracker is Ownable {
    // -----------------------------------------------------------------------
    //  Types
    // -----------------------------------------------------------------------

    struct VaultFeed {
        IERC4626 vault;
        AggregatorV3Interface priceFeed;
        uint8 feedDecimals;
        uint8 assetDecimals;
        bool active;
    }

    struct PortfolioSnapshot {
        uint256 totalValueUSD;     // 18 decimals
        uint256 timestamp;
        uint256 vaultCount;
    }

    struct VaultPosition {
        address vault;
        uint256 shares;
        uint256 assetsUnderlying;  // shares converted to underlying
        uint256 valueUSD;          // 18 decimals
        int256 assetPriceUSD;      // raw price from Chainlink
        uint8 feedDecimals;
    }

    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    /// @notice Registered vault feeds (vault address => VaultFeed).
    mapping(address => VaultFeed) public vaultFeeds;

    /// @notice List of all registered vault addresses (for iteration).
    address[] public registeredVaults;

    /// @notice Per-user NAV snapshots for performance tracking.
    mapping(address => PortfolioSnapshot[]) private _snapshots;

    /// @notice Maximum age of price data before considered stale (default: 1 hour).
    uint256 public maxStaleness = 3600;

    /// @notice ETH/USD price feed for gas-cost aware operations.
    AggregatorV3Interface public ethUsdFeed;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event VaultFeedRegistered(address indexed vault, address indexed priceFeed, address indexed asset);
    event VaultFeedRemoved(address indexed vault);
    event SnapshotTaken(address indexed user, uint256 totalValueUSD, uint256 vaultCount);
    event MaxStalenessUpdated(uint256 oldValue, uint256 newValue);
    event EthUsdFeedUpdated(address indexed oldFeed, address indexed newFeed);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error VaultAlreadyRegistered();
    error VaultNotRegistered();
    error StalePrice(address feed, uint256 updatedAt, uint256 maxAge);
    error NegativePrice(address feed, int256 price);
    error NoVaultsRegistered();
    error OnlyOwnerOrSelf();
    error MaxSnapshotsReached();

    /// @notice Maximum snapshots per user.
    uint256 public constant MAX_SNAPSHOTS = 500;

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor(address initialOwner) Ownable(initialOwner) {}

    // -----------------------------------------------------------------------
    //  Admin: Vault Feed Management
    // -----------------------------------------------------------------------

    /// @notice Register a vault with its Chainlink price feed.
    /// @param vault The ERC-4626 vault address.
    /// @param priceFeed The Chainlink AggregatorV3 price feed (asset/USD).
    function registerVaultFeed(address vault, address priceFeed) external onlyOwner {
        if (vault == address(0) || priceFeed == address(0)) revert ZeroAddress();
        if (vaultFeeds[vault].active) revert VaultAlreadyRegistered();

        AggregatorV3Interface feed = AggregatorV3Interface(priceFeed);
        uint8 feedDecimals = feed.decimals();

        // Get underlying asset decimals
        address asset = IERC4626(vault).asset();
        uint8 assetDecimals = IERC20Metadata(asset).decimals();

        vaultFeeds[vault] = VaultFeed({
            vault: IERC4626(vault),
            priceFeed: feed,
            feedDecimals: feedDecimals,
            assetDecimals: assetDecimals,
            active: true
        });

        registeredVaults.push(vault);
        emit VaultFeedRegistered(vault, priceFeed, asset);
    }

    /// @notice Remove a vault feed registration.
    function removeVaultFeed(address vault) external onlyOwner {
        if (!vaultFeeds[vault].active) revert VaultNotRegistered();
        vaultFeeds[vault].active = false;

        // Remove from array (swap and pop)
        for (uint256 i; i < registeredVaults.length;) {
            if (registeredVaults[i] == vault) {
                registeredVaults[i] = registeredVaults[registeredVaults.length - 1];
                registeredVaults.pop();
                break;
            }
            unchecked { ++i; }
        }

        emit VaultFeedRemoved(vault);
    }

    /// @notice Update the max staleness threshold for price feeds.
    function setMaxStaleness(uint256 newMaxStaleness) external onlyOwner {
        uint256 old = maxStaleness;
        maxStaleness = newMaxStaleness;
        emit MaxStalenessUpdated(old, newMaxStaleness);
    }

    /// @notice Set the ETH/USD price feed for gas cost calculations.
    function setEthUsdFeed(address feed) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        address old = address(ethUsdFeed);
        ethUsdFeed = AggregatorV3Interface(feed);
        emit EthUsdFeedUpdated(old, feed);
    }

    // -----------------------------------------------------------------------
    //  Portfolio Valuation (View)
    // -----------------------------------------------------------------------

    /// @notice Get the total portfolio value in USD (18 decimals) for a user across all vaults.
    /// @param user The user address.
    /// @return totalUSD Total portfolio value in USD with 18 decimals.
    /// @return positions Array of per-vault position details.
    function getPortfolioValue(address user)
        external
        view
        returns (uint256 totalUSD, VaultPosition[] memory positions)
    {
        uint256 count = registeredVaults.length;
        if (count == 0) revert NoVaultsRegistered();

        positions = new VaultPosition[](count);
        totalUSD = 0;

        for (uint256 i; i < count;) {
            address vaultAddr = registeredVaults[i];
            VaultFeed storage vf = vaultFeeds[vaultAddr];

            if (!vf.active) {
                unchecked { ++i; }
                continue;
            }

            uint256 shares = vf.vault.balanceOf(user);
            uint256 assets = shares > 0 ? vf.vault.convertToAssets(shares) : 0;

            (int256 price, uint8 feedDec) = _getValidPrice(vf);
            uint256 valueUSD = _calculateUSDValue(assets, price, feedDec, vf.assetDecimals);

            positions[i] = VaultPosition({
                vault: vaultAddr,
                shares: shares,
                assetsUnderlying: assets,
                valueUSD: valueUSD,
                assetPriceUSD: price,
                feedDecimals: feedDec
            });

            totalUSD += valueUSD;
            unchecked { ++i; }
        }
    }

    /// @notice Get the USD price of a single vault's underlying asset.
    /// @param vault The vault address.
    /// @return priceUSD The asset price in USD (feed decimals).
    /// @return decimals The number of decimals in the price.
    function getAssetPrice(address vault)
        external
        view
        returns (int256 priceUSD, uint8 decimals)
    {
        VaultFeed storage vf = vaultFeeds[vault];
        if (!vf.active) revert VaultNotRegistered();
        (priceUSD, decimals) = _getValidPrice(vf);
    }

    /// @notice Get the value of specific vault shares in USD.
    /// @param vault The vault address.
    /// @param shares Number of vault shares.
    /// @return valueUSD Value in USD with 18 decimals.
    function getShareValueUSD(address vault, uint256 shares)
        external
        view
        returns (uint256 valueUSD)
    {
        VaultFeed storage vf = vaultFeeds[vault];
        if (!vf.active) revert VaultNotRegistered();

        uint256 assets = vf.vault.convertToAssets(shares);
        (int256 price, uint8 feedDec) = _getValidPrice(vf);
        valueUSD = _calculateUSDValue(assets, price, feedDec, vf.assetDecimals);
    }

    // -----------------------------------------------------------------------
    //  NAV Snapshots
    // -----------------------------------------------------------------------

    /// @notice Take a NAV snapshot for a user.
    /// @dev SC-M-06 FIX: Restricted to owner or the user themselves. Bounded storage.
    /// @param user The user address to snapshot.
    function takeSnapshot(address user) external {
        if (msg.sender != owner() && msg.sender != user) revert OnlyOwnerOrSelf();
        if (_snapshots[user].length >= MAX_SNAPSHOTS) revert MaxSnapshotsReached();
        uint256 count = registeredVaults.length;
        if (count == 0) revert NoVaultsRegistered();

        uint256 totalUSD = 0;
        uint256 activeVaults = 0;

        for (uint256 i; i < count;) {
            address vaultAddr = registeredVaults[i];
            VaultFeed storage vf = vaultFeeds[vaultAddr];

            if (vf.active) {
                uint256 shares = vf.vault.balanceOf(user);
                if (shares > 0) {
                    uint256 assets = vf.vault.convertToAssets(shares);
                    (int256 price, uint8 feedDec) = _getValidPrice(vf);
                    totalUSD += _calculateUSDValue(assets, price, feedDec, vf.assetDecimals);
                    activeVaults++;
                }
            }
            unchecked { ++i; }
        }

        _snapshots[user].push(PortfolioSnapshot({
            totalValueUSD: totalUSD,
            timestamp: block.timestamp,
            vaultCount: activeVaults
        }));

        emit SnapshotTaken(user, totalUSD, activeVaults);
    }

    /// @notice Get the number of snapshots for a user.
    function getSnapshotCount(address user) external view returns (uint256) {
        return _snapshots[user].length;
    }

    /// @notice Get a specific snapshot for a user.
    function getSnapshot(address user, uint256 index)
        external
        view
        returns (PortfolioSnapshot memory)
    {
        return _snapshots[user][index];
    }

    /// @notice Get the latest snapshot for a user.
    function getLatestSnapshot(address user)
        external
        view
        returns (PortfolioSnapshot memory)
    {
        uint256 len = _snapshots[user].length;
        if (len == 0) return PortfolioSnapshot(0, 0, 0);
        return _snapshots[user][len - 1];
    }

    // -----------------------------------------------------------------------
    //  View Helpers
    // -----------------------------------------------------------------------

    /// @notice Return all registered vault addresses.
    function getRegisteredVaults() external view returns (address[] memory) {
        return registeredVaults;
    }

    /// @notice Return the number of registered vaults.
    function getRegisteredVaultCount() external view returns (uint256) {
        return registeredVaults.length;
    }

    // -----------------------------------------------------------------------
    //  Internal
    // -----------------------------------------------------------------------

    /// @dev Fetch and validate the latest price from a Chainlink feed.
    function _getValidPrice(VaultFeed storage vf)
        internal
        view
        returns (int256 price, uint8 feedDec)
    {
        (, int256 answer,, uint256 updatedAt,) = vf.priceFeed.latestRoundData();

        if (answer <= 0) revert NegativePrice(address(vf.priceFeed), answer);
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
            revert StalePrice(address(vf.priceFeed), updatedAt, maxStaleness);
        }

        return (answer, vf.feedDecimals);
    }

    /// @dev Calculate USD value with 18 decimals from asset amount and price.
    /// @param assets Amount of underlying asset.
    /// @param price Price from Chainlink (feedDecimals).
    /// @param feedDecimals Chainlink feed decimals.
    /// @param assetDecimals Underlying asset decimals.
    /// @dev SC-H-04 FIX: Use Math.mulDiv to prevent intermediate overflow.
    function _calculateUSDValue(
        uint256 assets,
        int256 price,
        uint8 feedDecimals,
        uint8 assetDecimals
    ) internal pure returns (uint256) {
        if (assets == 0 || price <= 0) return 0;

        // Normalize to 18 decimals using mulDiv to avoid overflow.
        // Put the large multiplication inside mulDiv to prevent intermediate overflow.
        return Math.mulDiv(
            assets,
            uint256(price) * 1e18,
            10 ** assetDecimals * 10 ** feedDecimals
        );
    }
}
