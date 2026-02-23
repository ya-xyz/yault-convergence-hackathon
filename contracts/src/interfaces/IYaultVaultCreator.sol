// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IYaultVaultCreator
 * @notice Interface for the YaultVaultCreator contract used by YaultVaultFactory.
 */
interface IYaultVaultCreator {
    function createVault(
        IERC20 asset,
        string calldata name,
        string calldata symbol,
        address vaultOwner,
        address platformFeeRecipient
    ) external returns (address vault);
}
