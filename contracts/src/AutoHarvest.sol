// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {AutomationCompatibleInterface} from "./interfaces/IAutomationCompatible.sol";
import {IYaultVault} from "./interfaces/IYaultVault.sol";

/**
 * @title AutoHarvest
 * @author Yault
 * @notice Chainlink Automation (Keepers) compatible contract for auto-harvesting
 *         YaultVault yield when it exceeds a configurable USD threshold.
 *
 * @dev Integrates with Chainlink Automation to:
 *      1. Periodically check if any registered user has harvestable yield
 *      2. Batch-harvest for multiple users in a single transaction
 *      3. Track harvest history for transparency
 *
 *      The contract is registered as a Chainlink Upkeep. Automation nodes call
 *      checkUpkeep() off-chain; if harvestable yield exceeds the threshold,
 *      they call performUpkeep() on-chain to execute harvests.
 *
 *      Only the vault owner (admin) should deploy this, as harvestFor() is
 *      an onlyOwner function on YaultVault.
 */
contract AutoHarvest is Ownable, AutomationCompatibleInterface {
    // -----------------------------------------------------------------------
    //  Types
    // -----------------------------------------------------------------------

    struct HarvestTarget {
        address vault;
        address user;
        bool active;
    }

    struct HarvestRecord {
        address vault;
        address user;
        uint256 timestamp;
        bool success;
    }

    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    /// @notice All registered harvest targets.
    HarvestTarget[] public targets;

    /// @notice Minimum yield (in asset units) required to trigger a harvest.
    uint256 public minYieldThreshold = 1e6; // Default: 1 USDC (6 decimals)

    /// @notice Maximum number of users to harvest per upkeep call (gas limit protection).
    uint256 public maxBatchSize = 10;

    /// @notice Minimum interval between harvests for the same target (in seconds).
    uint256 public minHarvestInterval = 1 days;

    /// @notice Last harvest timestamp per target index.
    mapping(uint256 => uint256) public lastHarvested;

    /// @notice Harvest history (latest N records).
    HarvestRecord[] public harvestHistory;

    /// @notice Maximum history entries to keep.
    uint256 public constant MAX_HISTORY = 1000;

    /// @notice Chainlink Automation forwarder address (access control).
    address public automationForwarder;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event TargetAdded(uint256 indexed targetIndex, address indexed vault, address indexed user);
    event TargetRemoved(uint256 indexed targetIndex);
    event HarvestExecuted(
        address indexed vault,
        address indexed user,
        uint256 timestamp,
        bool success
    );
    event BatchHarvestCompleted(uint256 attempted, uint256 succeeded);
    event MinYieldThresholdUpdated(uint256 oldValue, uint256 newValue);
    event MaxBatchSizeUpdated(uint256 oldValue, uint256 newValue);
    event AutomationForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error OnlyAutomationForwarder();
    error TargetIndexOutOfBounds();
    error BatchSizeTooLarge();
    error ThresholdTooLow();

    /// @notice Ring buffer index for harvest history.
    uint256 public historyIndex;

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor(address initialOwner) Ownable(initialOwner) {}

    // -----------------------------------------------------------------------
    //  Admin: Target Management
    // -----------------------------------------------------------------------

    /// @notice Register a (vault, user) pair for auto-harvesting.
    /// @param vault The YaultVault address.
    /// @param user The user whose yield should be harvested.
    function addTarget(address vault, address user) external onlyOwner {
        if (vault == address(0) || user == address(0)) revert ZeroAddress();

        targets.push(HarvestTarget({
            vault: vault,
            user: user,
            active: true
        }));

        emit TargetAdded(targets.length - 1, vault, user);
    }

    /// @notice Deactivate a harvest target.
    function removeTarget(uint256 targetIndex) external onlyOwner {
        if (targetIndex >= targets.length) revert TargetIndexOutOfBounds();
        targets[targetIndex].active = false;
        emit TargetRemoved(targetIndex);
    }

    /// @notice Update the minimum yield threshold (minimum 100 to prevent dust harvests).
    function setMinYieldThreshold(uint256 newThreshold) external onlyOwner {
        // SC-L-01 FIX: Enforce minimum threshold to prevent dust harvests
        if (newThreshold < 100) revert ThresholdTooLow();
        uint256 old = minYieldThreshold;
        minYieldThreshold = newThreshold;
        emit MinYieldThresholdUpdated(old, newThreshold);
    }

    /// @notice Update the max batch size.
    function setMaxBatchSize(uint256 newSize) external onlyOwner {
        if (newSize > 50) revert BatchSizeTooLarge();
        uint256 old = maxBatchSize;
        maxBatchSize = newSize;
        emit MaxBatchSizeUpdated(old, newSize);
    }

    /// @notice Set the Chainlink Automation forwarder address.
    function setAutomationForwarder(address forwarder) external onlyOwner {
        address old = automationForwarder;
        automationForwarder = forwarder;
        emit AutomationForwarderUpdated(old, forwarder);
    }

    // -----------------------------------------------------------------------
    //  Chainlink Automation Interface
    // -----------------------------------------------------------------------

    /// @notice Called off-chain by Chainlink Automation nodes.
    /// @dev Scans all active targets for harvestable yield above threshold.
    ///      Returns up to maxBatchSize target indices as performData.
    function checkUpkeep(bytes calldata /* checkData */)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256[] memory harvestable = new uint256[](maxBatchSize);
        uint256 count = 0;

        for (uint256 i; i < targets.length && count < maxBatchSize;) {
            if (_isHarvestable(i)) {
                harvestable[count] = i;
                count++;
            }
            unchecked { ++i; }
        }

        if (count > 0) {
            // Trim array to actual size
            uint256[] memory trimmed = new uint256[](count);
            for (uint256 j; j < count;) {
                trimmed[j] = harvestable[j];
                unchecked { ++j; }
            }
            upkeepNeeded = true;
            performData = abi.encode(trimmed);
        }
    }

    /// @notice Called on-chain by Chainlink Automation when checkUpkeep returns true.
    /// @dev Executes harvests for the target indices encoded in performData.
    function performUpkeep(bytes calldata performData) external override {
        // Access control: only automation forwarder or owner
        if (msg.sender != owner()) {
            if (automationForwarder == address(0) || msg.sender != automationForwarder) {
                revert OnlyAutomationForwarder();
            }
        }

        uint256[] memory indices = abi.decode(performData, (uint256[]));
        uint256 succeeded = 0;

        for (uint256 i; i < indices.length;) {
            uint256 idx = indices[i];
            // Skip duplicates: only harvest if not already harvested in this tx
            bool isDuplicate = false;
            for (uint256 j; j < i;) {
                if (indices[j] == idx) { isDuplicate = true; break; }
                unchecked { ++j; }
            }
            if (!isDuplicate && idx < targets.length && targets[idx].active) {
                bool success = _executeHarvest(idx);
                if (success) succeeded++;
            }
            unchecked { ++i; }
        }

        emit BatchHarvestCompleted(indices.length, succeeded);
    }

    // -----------------------------------------------------------------------
    //  Manual Harvest (Owner)
    // -----------------------------------------------------------------------

    /// @notice Manually trigger a harvest for a specific target.
    function harvestTarget(uint256 targetIndex) external onlyOwner {
        if (targetIndex >= targets.length) revert TargetIndexOutOfBounds();
        _executeHarvest(targetIndex);
    }

    // -----------------------------------------------------------------------
    //  View
    // -----------------------------------------------------------------------

    /// @notice Get the total number of targets.
    function getTargetCount() external view returns (uint256) {
        return targets.length;
    }

    /// @notice Get the number of harvest history records.
    function getHistoryCount() external view returns (uint256) {
        return harvestHistory.length;
    }

    /// @notice Check if a specific target is currently harvestable.
    function isTargetHarvestable(uint256 targetIndex) external view returns (bool) {
        return _isHarvestable(targetIndex);
    }

    /// @notice Get the estimated yield for a target (in underlying asset units).
    function getEstimatedYield(uint256 targetIndex) external view returns (uint256 yield_) {
        if (targetIndex >= targets.length) return 0;
        HarvestTarget storage t = targets[targetIndex];
        if (!t.active) return 0;

        IYaultVault vault = IYaultVault(t.vault);
        uint256 shares = vault.balanceOf(t.user);
        if (shares == 0) return 0;

        uint256 currentValue = vault.convertToAssets(shares);
        uint256 principal = vault.userPrincipal(t.user);

        yield_ = currentValue > principal ? currentValue - principal : 0;
    }

    // -----------------------------------------------------------------------
    //  Internal
    // -----------------------------------------------------------------------

    /// @dev Check if a target index is harvestable.
    function _isHarvestable(uint256 idx) internal view returns (bool) {
        if (idx >= targets.length) return false;
        HarvestTarget storage t = targets[idx];
        if (!t.active) return false;

        // Check interval
        if (block.timestamp < lastHarvested[idx] + minHarvestInterval) return false;

        // Check yield
        IYaultVault vault = IYaultVault(t.vault);
        uint256 shares = vault.balanceOf(t.user);
        if (shares == 0) return false;

        uint256 currentValue = vault.convertToAssets(shares);
        uint256 principal = vault.userPrincipal(t.user);

        if (currentValue <= principal) return false;
        uint256 yield_ = currentValue - principal;

        return yield_ >= minYieldThreshold;
    }

    /// @dev Execute a harvest for a target, recording the result.
    /// @dev SC-H-05 FIX: Only update lastHarvested on success.
    /// @dev SC-H-02 FIX: Proper ring buffer for harvest history.
    function _executeHarvest(uint256 idx) internal returns (bool success) {
        HarvestTarget storage t = targets[idx];

        try IYaultVault(t.vault).harvestFor(t.user) {
            success = true;
            // SC-H-05 FIX: Only update timestamp on successful harvest
            lastHarvested[idx] = block.timestamp;
        } catch {
            success = false;
        }

        // SC-H-02 FIX: Ring buffer pattern for bounded storage growth
        HarvestRecord memory record = HarvestRecord({
            vault: t.vault,
            user: t.user,
            timestamp: block.timestamp,
            success: success
        });

        if (harvestHistory.length < MAX_HISTORY) {
            harvestHistory.push(record);
        } else {
            harvestHistory[historyIndex % MAX_HISTORY] = record;
        }
        historyIndex++;

        emit HarvestExecuted(t.vault, t.user, block.timestamp, success);
    }
}
