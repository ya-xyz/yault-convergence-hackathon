// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink Automation (Keepers) compatible interface.
/// @dev Implement checkUpkeep and performUpkeep for automated on-chain tasks.
interface AutomationCompatibleInterface {
    /// @notice Called by Chainlink Automation nodes to check if upkeep is needed.
    /// @param checkData Arbitrary bytes passed from the upkeep registration.
    /// @return upkeepNeeded True if performUpkeep should be called.
    /// @return performData Bytes to pass to performUpkeep (computed off-chain).
    function checkUpkeep(bytes calldata checkData)
        external
        returns (bool upkeepNeeded, bytes memory performData);

    /// @notice Called by Chainlink Automation when checkUpkeep returns true.
    /// @param performData The data returned by checkUpkeep.
    function performUpkeep(bytes calldata performData) external;
}
