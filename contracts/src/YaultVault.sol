// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IYaultVault} from "./interfaces/IYaultVault.sol";

/// @notice Minimal Aave V3 Pool interface for supply/withdraw.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/**
 * @title YaultVault
 * @author Yault
 * @notice ERC-4626 yield vault with three-way revenue split for the Yault
 *         asset management platform.
 *
 * @dev Revenue distribution (basis points, total = 10 000):
 *      - 75 % (7 500 bp) → user (compounds in vault)
 *      - 25 % (2 500 bp) → platform
 *        ↳ if authority bound: 20 % platform + 5 % authority (escrowed)
 *        ↳ if no authority:    25 % platform (full)
 *
 *      Yield is defined per user as the difference between the current value
 *      of their shares (in underlying assets) and their recorded deposit
 *      principal. When `harvest()` is called the delta is split and
 *      distributed. The user portion compounds in the vault; the platform
 *      portion is transferred immediately; the authority portion (if any) is
 *      escrowed until `claimAuthorityRevenue()` is called.
 *
 *      Admin (owner) may set the platform fee recipient and pause/unpause
 *      the vault. When paused, deposits and mints are blocked but
 *      withdrawals and redeems remain available.
 */
contract YaultVault is ERC4626, Ownable, Pausable, ReentrancyGuard, IYaultVault {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // -----------------------------------------------------------------------
    //  Constants — revenue split in basis points (1 bp = 0.01 %)
    // -----------------------------------------------------------------------

    /// @notice User share: 75 % (compounds in vault).
    uint256 public constant USER_SHARE = 7500;

    /// @notice Platform base share: 25 % (full allocation when no authority).
    uint256 public constant PLATFORM_SHARE = 2500;

    /// @notice Authority share: 5 % carved from platform's 25 % when authority is bound.
    /// @dev When authority is set, platform effectively receives 20 % and authority 5 %.
    uint256 public constant AUTHORITY_SHARE = 500;

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    /// @notice Address that receives the platform's cut (25 % without authority, 20 % with).
    address public platformFeeRecipient;

    /// @notice Per-user revenue configuration (user → config).
    mapping(address => RevenueConfig) private _revenueConfigs;

    /// @notice Per-user deposited principal tracked in underlying asset units.
    /// @dev Updated on deposit/mint (increase) and withdraw/redeem (decrease).
    mapping(address => uint256) public userPrincipal;

    /// @notice Accumulated but unclaimed revenue for each authority address.
    mapping(address => uint256) public pendingAuthorityRevenue;

    /// @notice Total escrowed authority revenue (not available for user withdrawals).
    uint256 public totalEscrowedAuthorityRevenue;

    /// @notice C-05 Extension: Addresses exempt from the share-transfer ban.
    /// @dev    Used to whitelist escrow contracts (e.g. VaultShareEscrow) that must
    ///         hold vault shares on behalf of users while funds continue earning yield.
    ///         Transfers where either `from` or `to` is an exempt address are allowed.
    mapping(address => bool) public transferExempt;

    /// @notice #3 FIX: Configurable minimum yield threshold to prevent dust griefing (in asset units).
    /// Default: 1e4 = $0.01 for USDC (6 decimals). Owner can adjust via setMinHarvestYield().
    uint256 public minHarvestYield = 1e4;

    /// @notice Absolute floor for minHarvestYield to prevent disabling the dust guard.
    uint256 public constant MIN_HARVEST_YIELD_FLOOR = 100;

    // -----------------------------------------------------------------------
    //  C-04 FIX: Two-step authority address confirmation
    // -----------------------------------------------------------------------

    /// @notice Pending authority address changes (user => proposed address).
    mapping(address => address) public pendingAuthorityChange;

    /// @notice Timestamp when the pending change was proposed.
    mapping(address => uint256) public pendingAuthorityChangeTime;

    /// @notice Time-lock duration for authority address changes (2 days).
    uint256 public constant AUTHORITY_CHANGE_DELAY = 2 days;

    // -----------------------------------------------------------------------
    //  Strategy state (Aave V3)
    // -----------------------------------------------------------------------

    /// @notice Aave V3 Pool address (address(0) = no strategy configured).
    address public aavePool;

    /// @notice aToken address corresponding to the underlying asset.
    address public aToken;

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    /// @dev Thrown when an address argument must not be zero.
    error ZeroAddress();

    /// @dev Thrown when there is no yield to harvest.
    error NoYieldToHarvest();

    /// @dev Thrown when an authority has nothing to claim.
    error NoPendingRevenue();

    /// @dev Thrown when yield is below the minimum harvest threshold.
    error YieldBelowMinimum();

    /// @dev Thrown when strategy is not configured.
    error StrategyNotSet();

    /// @dev Thrown when trying to invest more than available idle balance.
    error InsufficientIdleBalance();

    /// @dev C-04: Thrown when authority change is still pending (time-lock not elapsed).
    error AuthorityChangePending();

    /// @dev C-04: Thrown when confirming an authority change with no pending change.
    error NoPendingAuthorityChange();

    /// @dev C-04: Thrown when authority time-lock has not elapsed yet.
    error AuthorityChangeTimelockNotElapsed();

    /// @dev C-05: Thrown when share transfers are attempted (disabled).
    error ShareTransfersDisabled();

    /// @dev Thrown when setTransferExempt target is address(0).
    error ExemptZeroAddress();

    /// @dev Thrown when sweep would transfer the vault asset (use sweepUnderlying instead).
    error CannotSweepVaultAsset();
    /// @dev Thrown when sweep amount exceeds vault's underlying balance.
    error InsufficientSweepBalance();
    /// @dev Thrown when balanceOf(asset()) reverts (e.g. some proxies when caller is a contract).
    error SweepBalanceCheckFailed();

    /// @dev Thrown when setMinHarvestYield is below MIN_HARVEST_YIELD_FLOOR.
    error MinYieldBelowFloor();
    /// @dev Thrown when refreshPlatformAddress is called with no revenue config.
    error NoRevenueConfig();
    /// @dev Thrown when setAuthorityAddress is called with self.
    error CannotSetSelfAsAuthority();

    // -----------------------------------------------------------------------
    //  Events (contract-level, not in interface)
    // -----------------------------------------------------------------------

    /// @notice Emitted when the platform fee recipient is updated.
    event PlatformFeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    /// @notice C-04: Emitted when an authority change is proposed.
    event AuthorityChangeProposed(address indexed user, address indexed proposedAuthority);

    /// @notice C-04: Emitted when an authority change is confirmed.
    event AuthorityChangeConfirmed(address indexed user, address indexed newAuthority);

    /// @notice C-04: Emitted when a pending authority change is cancelled.
    event AuthorityChangeCancelled(address indexed user);

    /// @notice Emitted when a transfer exemption is set or revoked.
    event TransferExemptSet(address indexed account, bool exempt);

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    /**
     * @param asset_              The underlying ERC-20 token.
     * @param name_               ERC-20 name for the vault shares.
     * @param symbol_             ERC-20 symbol for the vault shares.
     * @param owner_              Initial owner (admin) of the vault.
     * @param platformFeeRecipient_ Address receiving the platform fee.
     */
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address owner_,
        address platformFeeRecipient_
    )
        ERC4626(asset_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        if (platformFeeRecipient_ == address(0)) revert ZeroAddress();
        platformFeeRecipient = platformFeeRecipient_;
    }

    // -----------------------------------------------------------------------
    //  Admin functions
    // -----------------------------------------------------------------------

    /// @notice Update the platform fee recipient. Only callable by the owner.
    /// @param newRecipient The new platform fee address.
    function setPlatformFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = platformFeeRecipient;
        platformFeeRecipient = newRecipient;
        emit PlatformFeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /// @notice #3 FIX: Update the minimum harvest yield threshold. Only callable by the owner.
    /// @param newMinYield The new minimum yield in asset units (must be >= MIN_HARVEST_YIELD_FLOOR).
    function setMinHarvestYield(uint256 newMinYield) external onlyOwner {
        if (newMinYield < MIN_HARVEST_YIELD_FLOOR) revert MinYieldBelowFloor();
        minHarvestYield = newMinYield;
    }

    /// @notice #14 FIX: Allow user to adopt the latest platformFeeRecipient into their cached config.
    /// Useful after admin updates the global platformFeeRecipient.
    function refreshPlatformAddress() external {
        RevenueConfig storage cfg = _revenueConfigs[msg.sender];
        if (cfg.user == address(0)) revert NoRevenueConfig();
        cfg.platformAddress = platformFeeRecipient;
    }

    /// @notice Pause the vault (blocks deposits/mints). Only callable by the owner.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the vault. Only callable by the owner.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Mark an address as exempt from the C-05 share-transfer ban.
    /// @dev    Intended for escrow contracts (e.g. VaultShareEscrow) that must
    ///         hold vault shares while users' funds keep earning yield.
    ///         Only callable by the vault owner (admin).
    /// @param account The address to exempt (or un-exempt).
    /// @param exempt  `true` to allow share transfers to/from `account`, `false` to revoke.
    function setTransferExempt(address account, bool exempt) external onlyOwner {
        if (account == address(0)) revert ExemptZeroAddress();
        transferExempt[account] = exempt;
        emit TransferExemptSet(account, exempt);
    }

    /**
     * @notice Recover underlying asset mistakenly sent directly to the vault (e.g. direct transfer instead of deposit).
     *         Only callable by the owner. Use for customer support to return mistaken transfers.
     * @dev    Reverts if amount exceeds vault's underlying balance (or if balanceOf reverts, e.g. some proxies).
     * @param amount Amount of underlying to transfer out.
     * @param to     Recipient (e.g. the user who sent by mistake).
     */
    function sweepUnderlying(uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        uint256 bal;
        try IERC20(asset()).balanceOf(address(this)) returns (uint256 b) {
            bal = b;
        } catch {
            revert SweepBalanceCheckFailed();
        }
        if (amount > bal) revert InsufficientSweepBalance();
        IERC20(asset()).safeTransfer(to, amount);
    }

    /**
     * @notice Recover any ERC20 other than the vault asset mistakenly sent to the vault.
     *         Only callable by the owner. For the vault asset, use sweepUnderlying instead.
     * @param token Token to sweep (must not be the vault underlying asset).
     * @param to    Recipient.
     */
    function sweepToken(IERC20 token, address to) external onlyOwner {
        if (address(token) == address(0) || to == address(0)) revert ZeroAddress();
        if (address(token) == asset()) revert CannotSweepVaultAsset();
        token.safeTransfer(to, token.balanceOf(address(this)));
    }

    // -----------------------------------------------------------------------
    //  Strategy functions (admin)
    // -----------------------------------------------------------------------

    /// @inheritdoc IYaultVault
    function setStrategy(address _aavePool, address _aToken) external override onlyOwner {
        if (_aavePool == address(0) || _aToken == address(0)) revert ZeroAddress();
        aavePool = _aavePool;
        aToken = _aToken;
        emit StrategySet(_aavePool, _aToken);
    }

    /// @inheritdoc IYaultVault
    function investToStrategy(uint256 amount) external override onlyOwner nonReentrant {
        if (aavePool == address(0)) revert StrategyNotSet();
        // Only invest idle balance (exclude escrowed authority revenue)
        uint256 idle = IERC20(asset()).balanceOf(address(this)) - totalEscrowedAuthorityRevenue;
        if (amount > idle) revert InsufficientIdleBalance();

        IERC20(asset()).approve(aavePool, amount);
        IAavePool(aavePool).supply(asset(), amount, address(this), 0);
        emit InvestedToStrategy(amount);
    }

    /// @inheritdoc IYaultVault
    function withdrawFromStrategy(uint256 amount) external override onlyOwner nonReentrant {
        if (aavePool == address(0)) revert StrategyNotSet();
        IAavePool(aavePool).withdraw(asset(), amount, address(this));
        emit WithdrawnFromStrategy(amount);
    }

    /// @notice Approve aToken to the strategy pool (needed for Mock/strategies that pull aTokens on withdraw).
    ///         Real Aave often handles this via callback; call once after setStrategy when using a mock.
    function approveStrategyToken() external onlyOwner {
        if (aToken == address(0)) revert StrategyNotSet();
        IERC20(aToken).approve(aavePool, type(uint256).max);
    }

    // -----------------------------------------------------------------------
    //  IYaultVault — user-facing
    // -----------------------------------------------------------------------

    /// @inheritdoc IYaultVault
    /// @dev C-04 FIX: Two-step authority address change.
    ///      Step 1: Call setAuthorityAddress() to propose (starts time-lock).
    ///      Step 2: Call confirmAuthorityAddress() after AUTHORITY_CHANGE_DELAY.
    ///      First-time setting (no existing authority) is immediate.
    function setAuthorityAddress(address authority) external override {
        if (authority == address(0)) revert ZeroAddress();
        if (authority == msg.sender) revert CannotSetSelfAsAuthority();

        RevenueConfig storage cfg = _revenueConfigs[msg.sender];

        // First-time setting: immediate (no existing authority to protect)
        if (cfg.authorityAddress == address(0)) {
            cfg.user = msg.sender;
            cfg.authorityAddress = authority;
            cfg.platformAddress = platformFeeRecipient;
            emit AuthoritySet(msg.sender, authority);
            return;
        }

        // Subsequent changes: start 2-step time-lock
        pendingAuthorityChange[msg.sender] = authority;
        pendingAuthorityChangeTime[msg.sender] = block.timestamp;
        emit AuthorityChangeProposed(msg.sender, authority);
    }

    /// @notice C-04 FIX: Confirm a pending authority address change after time-lock.
    function confirmAuthorityAddress() external {
        address proposed = pendingAuthorityChange[msg.sender];
        if (proposed == address(0)) revert NoPendingAuthorityChange();

        uint256 proposedAt = pendingAuthorityChangeTime[msg.sender];
        if (block.timestamp < proposedAt + AUTHORITY_CHANGE_DELAY) {
            revert AuthorityChangeTimelockNotElapsed();
        }

        // Apply the change
        RevenueConfig storage cfg = _revenueConfigs[msg.sender];
        cfg.authorityAddress = proposed;
        cfg.platformAddress = platformFeeRecipient;

        // Clear pending state
        delete pendingAuthorityChange[msg.sender];
        delete pendingAuthorityChangeTime[msg.sender];

        emit AuthorityChangeConfirmed(msg.sender, proposed);
        emit AuthoritySet(msg.sender, proposed);
    }

    /// @notice C-04 FIX: Cancel a pending authority address change.
    function cancelAuthorityChange() external {
        if (pendingAuthorityChange[msg.sender] == address(0)) revert NoPendingAuthorityChange();
        delete pendingAuthorityChange[msg.sender];
        delete pendingAuthorityChangeTime[msg.sender];
        emit AuthorityChangeCancelled(msg.sender);
    }

    /// @inheritdoc IYaultVault
    function harvest() external override nonReentrant {
        address user = msg.sender;
        uint256 shares = balanceOf(user);
        uint256 currentValue = convertToAssets(shares);
        uint256 principal = userPrincipal[user];

        // Yield is the positive difference; if no yield, revert.
        if (currentValue <= principal) revert NoYieldToHarvest();

        uint256 yieldAmount = currentValue - principal;

        // Prevent dust griefing: enforce minimum yield threshold.
        if (yieldAmount < minHarvestYield) revert YieldBelowMinimum();

        // Calculate each party's share.
        // Base split: 75 % user, 25 % platform. If authority bound, 5 % carved from platform.
        uint256 userAmount = (yieldAmount * USER_SHARE) / BPS_DENOMINATOR;
        address authority = _revenueConfigs[user].authorityAddress;

        uint256 authorityAmount;
        uint256 platformAmount;
        if (authority != address(0)) {
            // Authority exists: platform 20 %, authority 5 %
            authorityAmount = (yieldAmount * AUTHORITY_SHARE) / BPS_DENOMINATOR;
            platformAmount = yieldAmount - userAmount - authorityAmount; // remainder to platform (avoids rounding dust)
        } else {
            // No authority: platform gets full 25 %
            authorityAmount = 0;
            platformAmount = yieldAmount - userAmount; // remainder to platform
        }

        // Burn shares equivalent to the total yield being distributed.
        // Convert yield back to shares for burning.
        uint256 sharesToBurn = convertToShares(yieldAmount);
        _burn(user, sharesToBurn);

        // User 75 % stays in vault (compounds); only platform + authority are paid out.
        uint256 newPrincipal = principal + userAmount;
        userPrincipal[user] = newPrincipal;
        emit YieldCompounded(user, userAmount, newPrincipal);

        IERC20 underlying = IERC20(asset());

        // Ensure sufficient idle balance for platform + authority only (user share remains in vault).
        uint256 totalDistribution = platformAmount + authorityAmount;
        uint256 idle;
        try underlying.balanceOf(address(this)) returns (uint256 b) {
            idle = b;
        } catch {
            // Some tokens (e.g. Sepolia USDC proxy) revert balanceOf when caller is a contract.
            idle = 0;
        }
        if (idle < totalDistribution && aavePool != address(0)) {
            uint256 shortfall = totalDistribution - idle;
            IAavePool(aavePool).withdraw(asset(), shortfall, address(this));
        }

        // User 75 % is not transferred; it stays in the vault and compounds (principal already updated above).

        // #14 FIX: Use cached platformAddress from RevenueConfig for atomicity.
        // Fallback to global platformFeeRecipient if cached value is zero (legacy configs).
        address cachedPlatform = _revenueConfigs[user].platformAddress;
        address platformTarget = cachedPlatform != address(0) ? cachedPlatform : platformFeeRecipient;
        underlying.safeTransfer(platformTarget, platformAmount);

        // Escrow authority share (carved from platform's 25 %; zero when no authority).
        if (authorityAmount > 0) {
            pendingAuthorityRevenue[authority] += authorityAmount;
            totalEscrowedAuthorityRevenue += authorityAmount;
        }

        emit YieldHarvested(msg.sender, user, userAmount, platformAmount, authorityAmount);
    }

    /// @notice Harvest yield on behalf of a user (onlyOwner). Use for periodic settlement so platform
    ///         and authority receive their share even if the user never calls harvest().
    function harvestFor(address user) external override onlyOwner nonReentrant {
        uint256 shares = balanceOf(user);
        uint256 currentValue = convertToAssets(shares);
        uint256 principal = userPrincipal[user];

        if (currentValue <= principal) revert NoYieldToHarvest();

        uint256 yieldAmount = currentValue - principal;
        if (yieldAmount < minHarvestYield) revert YieldBelowMinimum();

        uint256 userAmount = (yieldAmount * USER_SHARE) / BPS_DENOMINATOR;
        address authority = _revenueConfigs[user].authorityAddress;

        uint256 authorityAmount;
        uint256 platformAmount;
        if (authority != address(0)) {
            authorityAmount = (yieldAmount * AUTHORITY_SHARE) / BPS_DENOMINATOR;
            platformAmount = yieldAmount - userAmount - authorityAmount;
        } else {
            authorityAmount = 0;
            platformAmount = yieldAmount - userAmount;
        }

        uint256 sharesToBurn = convertToShares(yieldAmount);
        _burn(user, sharesToBurn);
        uint256 newPrincipal = principal + userAmount;
        userPrincipal[user] = newPrincipal;
        emit YieldCompounded(user, userAmount, newPrincipal);

        IERC20 underlying = IERC20(asset());
        uint256 totalDistribution = platformAmount + authorityAmount;
        uint256 idle;
        try underlying.balanceOf(address(this)) returns (uint256 b) {
            idle = b;
        } catch {
            idle = 0;
        }
        if (idle < totalDistribution && aavePool != address(0)) {
            uint256 shortfall = totalDistribution - idle;
            IAavePool(aavePool).withdraw(asset(), shortfall, address(this));
        }

        // User 75 % stays in vault (compounds)
        address cachedPlatform = _revenueConfigs[user].platformAddress;
        address platformTarget = cachedPlatform != address(0) ? cachedPlatform : platformFeeRecipient;
        underlying.safeTransfer(platformTarget, platformAmount);
        if (authorityAmount > 0) {
            pendingAuthorityRevenue[authority] += authorityAmount;
            totalEscrowedAuthorityRevenue += authorityAmount;
        }

        emit YieldHarvested(msg.sender, user, userAmount, platformAmount, authorityAmount);
    }

    // -----------------------------------------------------------------------
    //  IYaultVault — view
    // -----------------------------------------------------------------------

    /// @inheritdoc IYaultVault
    function getRevenueConfig(address user)
        external
        view
        override
        returns (RevenueConfig memory config)
    {
        config = _revenueConfigs[user];
    }

    /// @inheritdoc IYaultVault
    function getPendingRevenue(address authority)
        external
        view
        override
        returns (uint256 pending)
    {
        pending = pendingAuthorityRevenue[authority];
    }

    // -----------------------------------------------------------------------
    //  IYaultVault — authority claim
    // -----------------------------------------------------------------------

    /// @inheritdoc IYaultVault
    function claimAuthorityRevenue() external override nonReentrant {
        uint256 amount = pendingAuthorityRevenue[msg.sender];
        if (amount == 0) revert NoPendingRevenue();

        pendingAuthorityRevenue[msg.sender] = 0;
        totalEscrowedAuthorityRevenue -= amount;

        IERC20(asset()).safeTransfer(msg.sender, amount);

        emit RevenueClaimedByAuthority(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    //  ERC-4626 overrides — principal tracking & pause guard
    // -----------------------------------------------------------------------

    /**
     * @dev Hook called during deposit/mint. We track the increase in
     *      underlying-asset principal for the receiver and enforce the
     *      pause guard.
     */
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal virtual override whenNotPaused {
        super._deposit(caller, receiver, assets, shares);
        userPrincipal[receiver] += assets;

        // Lazily initialise the revenue config for first-time depositors.
        if (_revenueConfigs[receiver].user == address(0)) {
            _revenueConfigs[receiver].user = receiver;
        }
    }

    /**
     * @dev Hook called during withdraw/redeem. We decrease the tracked
     *      principal proportionally to the share of total assets being
     *      withdrawn.
     */
    function _withdraw(
        address caller,
        address receiver,
        address owner_,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        // Calculate the proportion of principal to remove.
        // proportion = assets / totalAssetsOfOwner (before withdrawal).
        // Note: balanceOf(owner_) still includes `shares` because _burn hasn't
        // been called yet (super._withdraw does the burn after this code runs).
        uint256 totalOwnerAssets = convertToAssets(balanceOf(owner_));
        uint256 principalReduction;
        if (totalOwnerAssets > 0) {
            principalReduction = (userPrincipal[owner_] * assets) / totalOwnerAssets;
        }
        if (principalReduction > userPrincipal[owner_]) {
            principalReduction = userPrincipal[owner_];
        }

        userPrincipal[owner_] -= principalReduction;

        // Auto-unwind from Aave if idle cash is insufficient for withdrawal.
        uint256 idle;
        try IERC20(asset()).balanceOf(address(this)) returns (uint256 b) {
            idle = b;
        } catch {
            idle = 0;
        }
        if (idle < assets && aavePool != address(0)) {
            uint256 shortfall = assets - idle;
            IAavePool(aavePool).withdraw(asset(), shortfall, address(this));
        }

        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    // -----------------------------------------------------------------------
    //  ERC-4626 override — totalAssets includes strategy balance
    // -----------------------------------------------------------------------

    /**
     * @dev C-06 FIX: Total assets managed by the vault: idle balance + Aave aToken balance,
     *      MINUS authority revenue that has been escrowed but not yet claimed.
     *
     *      The escrowed authority revenue sits in the vault's underlying balance but
     *      does NOT belong to share holders. Without subtracting it, share price is
     *      inflated and users can redeem the authority's funds, causing
     *      claimAuthorityRevenue() to revert on insufficient balance.
     */
    function totalAssets() public view virtual override(ERC4626, IERC4626) returns (uint256) {
        uint256 idle;
        try IERC20(asset()).balanceOf(address(this)) returns (uint256 b) {
            idle = b;
        } catch {
            idle = 0;
        }
        uint256 invested = aToken != address(0) ? IERC20(aToken).balanceOf(address(this)) : 0;
        uint256 gross = idle + invested;
        // Subtract authority escrow so share price only reflects shareholder-owned assets.
        // Guard against underflow in edge cases (e.g. rounding during multi-harvest sequences).
        return gross > totalEscrowedAuthorityRevenue ? gross - totalEscrowedAuthorityRevenue : 0;
    }

    // -----------------------------------------------------------------------
    //  ERC-20 transfer override — track principal on share transfers
    // -----------------------------------------------------------------------

    /**
     * @dev C-05 FIX: Block direct share transfers between users.
     *      Share transfers are disabled because the principal-tracking
     *      mechanism allows yield arbitrage when shares are transferred
     *      at cost basis rather than market value. Only mint (deposit)
     *      and burn (withdraw/redeem/harvest) are allowed.
     *
     *      Exception: transfers where either `from` or `to` is a
     *      transferExempt address (e.g. VaultShareEscrow) are permitted
     *      so that escrow contracts can custody shares while yield accrues.
     */
    function _update(address from, address to, uint256 value) internal virtual override {
        // Allow mints (from == address(0)) and burns (to == address(0)).
        // Allow transfers involving a transferExempt address (escrow contracts).
        if (from != address(0) && to != address(0)) {
            if (!transferExempt[from] && !transferExempt[to]) {
                revert ShareTransfersDisabled();
            }

            // When a non-exempt user sends shares to an exempt address (e.g. escrow),
            // reduce the sender's userPrincipal proportionally to the shares transferred.
            if (!transferExempt[from] && userPrincipal[from] > 0) {
                uint256 senderShares = balanceOf(from); // balance before transfer
                if (senderShares > 0 && value > 0) {
                    uint256 reduction = (userPrincipal[from] * value) / senderShares;
                    if (reduction > userPrincipal[from]) reduction = userPrincipal[from];
                    userPrincipal[from] -= reduction;
                }
            }
            // When an exempt address (e.g. escrow) sends shares to a non-exempt user,
            // credit the receiver's principal so harvest() only attributes yield above that.
            if (transferExempt[from] && !transferExempt[to] && value > 0) {
                uint256 assetsCredited = convertToAssets(value);
                userPrincipal[to] += assetsCredited;
            }
        }
        super._update(from, to, value);
    }

    // -----------------------------------------------------------------------
    //  ERC-165 (optional — helps off-chain tooling)
    // -----------------------------------------------------------------------

    /// @notice Check interface support.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IYaultVault).interfaceId;
    }
}
