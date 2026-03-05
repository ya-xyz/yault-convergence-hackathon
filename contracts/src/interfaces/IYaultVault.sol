// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title IYaultVault
 * @author Yault
 * @notice Interface for the Yault asset management yield vault.
 * @dev Extends IERC4626 with revenue split functionality:
 *      75 % user (compounds) / 25 % platform.
 *      If authority bound: 5 % carved from platform → 20 % platform + 5 % authority.
 *
 *      Each depositor may bind an authority address. On `harvest()` the
 *      accumulated yield is split proportionally and the authority share (if any)
 *      is held in escrow until the authority calls `claimAuthorityRevenue()`.
 */
interface IYaultVault is IERC4626 {
    // -----------------------------------------------------------------------
    //  Structs
    // -----------------------------------------------------------------------

    /// @notice Per-user revenue configuration.
    /// @param user         The depositor address.
    /// @param authorityAddress  The authority bound to this user (address(0) if unset).
    /// @param platformAddress The platform fee recipient at the time the config was created.
    struct RevenueConfig {
        address user;
        address authorityAddress;
        address platformAddress;
    }

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    /// @notice Emitted when a user binds or updates their authority address.
    /// @param user      The depositor who changed the setting.
    /// @param authority The new authority address.
    event AuthoritySet(address indexed user, address indexed authority);

    /// @notice Emitted when yield is harvested and distributed.
    /// @param caller          The address that triggered the harvest.
    /// @param user            The depositor whose yield was harvested.
    /// @param userAmount      Amount (75 %) left in vault and compounded for the user.
    /// @param platformAmount  Amount sent to the platform (25 % or 20 % if authority bound).
    /// @param authorityAmount Amount credited to the authority's pending balance (5 % or 0).
    event YieldHarvested(
        address indexed caller,
        address indexed user,
        uint256 userAmount,
        uint256 platformAmount,
        uint256 authorityAmount
    );

    /// @notice Emitted when the user's 75 % share is compounded (principal updated). Enables audit and compliance.
    /// @param user         The depositor whose yield was compounded.
    /// @param amount       The amount compounded (user's 75 % share, in underlying asset units).
    /// @param newPrincipal The user's principal after this harvest (cost basis for future yield).
    event YieldCompounded(address indexed user, uint256 amount, uint256 newPrincipal);

    /// @notice Emitted when an authority claims its accumulated revenue.
    /// @param authority The authority address that claimed.
    /// @param amount    The amount of underlying asset transferred.
    event RevenueClaimedByAuthority(address indexed authority, uint256 amount);

    // -----------------------------------------------------------------------
    //  User-facing functions
    // -----------------------------------------------------------------------

    /// @notice Bind or update the authority address for the caller.
    /// @dev Reverts if `authority` is address(0).
    /// @param authority The authority address to bind.
    function setAuthorityAddress(address authority) external;

    /// @notice Harvest accumulated yield for the caller and distribute it
    ///         according to the 75/25 split (authority carved from platform if bound).
    /// @dev Calculates yield as (current entitled assets - deposited principal),
    ///      then splits and transfers. Authority share is escrowed internally.
    function harvest() external;

    /// @notice Harvest accumulated yield for a given user (onlyOwner).
    ///         Ensures platform and authority receive their share even if the user never calls harvest().
    /// @param user The depositor whose yield to harvest. User 75 %, platform 25 % (or 20 % + 5 % authority).
    function harvestFor(address user) external;

    // -----------------------------------------------------------------------
    //  View functions
    // -----------------------------------------------------------------------

    /// @notice Return the deposited principal for a given user.
    /// @param user The depositor address.
    /// @return principal The user's tracked principal (cost basis).
    function userPrincipal(address user) external view returns (uint256 principal);

    /// @notice Return the revenue configuration for a given user.
    /// @param user The depositor address.
    /// @return config The `RevenueConfig` struct.
    function getRevenueConfig(address user) external view returns (RevenueConfig memory config);

    /// @notice Return the pending (unclaimed) revenue for an authority.
    /// @param authority The authority address.
    /// @return pending The claimable amount of underlying asset.
    function getPendingRevenue(address authority) external view returns (uint256 pending);

    // -----------------------------------------------------------------------
    //  Authority functions
    // -----------------------------------------------------------------------

    /// @notice Allow an authority to claim all of its accumulated revenue.
    /// @dev Transfers the full pending balance to `msg.sender`.
    function claimAuthorityRevenue() external;

    // -----------------------------------------------------------------------
    //  Strategy functions (admin)
    // -----------------------------------------------------------------------

    /// @notice Set the yield strategy (Aave V3 pool and corresponding aToken).
    /// @param aavePool The Aave V3 Pool address.
    /// @param aToken   The aToken address for the underlying asset.
    function setStrategy(address aavePool, address aToken) external;

    /// @notice Invest idle vault assets into the Aave V3 strategy.
    /// @param amount Amount of underlying asset to supply to Aave.
    function investToStrategy(uint256 amount) external;

    /// @notice Withdraw assets from the Aave V3 strategy back to the vault.
    /// @param amount Amount of underlying asset to withdraw from Aave.
    function withdrawFromStrategy(uint256 amount) external;

    // -----------------------------------------------------------------------
    //  Strategy events
    // -----------------------------------------------------------------------

    /// @notice Emitted when the yield strategy is configured.
    event StrategySet(address indexed aavePool, address indexed aToken);

    /// @notice Emitted when assets are invested into the strategy.
    event InvestedToStrategy(uint256 amount);

    /// @notice Emitted when assets are withdrawn from the strategy.
    event WithdrawnFromStrategy(uint256 amount);
}
