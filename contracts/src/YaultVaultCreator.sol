// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YaultVault} from "./YaultVault.sol";

/**
 * @title YaultVaultCreator
 * @author Yault
 * @notice Minimal contract that deploys YaultVault instances. Used by YaultVaultFactory
 *         to avoid exceeding the EIP-170 contract size limit (24 KiB).
 * @dev Deploy once; Factory holds this address and calls createVault(...). The vault
 *      is created by this contract (CREATE) but ownership is set to the requested owner.
 */
contract YaultVaultCreator {
    /**
     * @notice Deploy a new YaultVault.
     * @param asset  Underlying ERC-20 asset.
     * @param name   Share token name.
     * @param symbol Share token symbol.
     * @param vaultOwner Vault owner (e.g. factory owner).
     * @param platformFeeRecipient Platform fee recipient for the new vault.
     * @return vault Address of the deployed YaultVault.
     */
    function createVault(
        IERC20 asset,
        string calldata name,
        string calldata symbol,
        address vaultOwner,
        address platformFeeRecipient
    ) external returns (address vault) {
        YaultVault v = new YaultVault(
            asset,
            name,
            symbol,
            vaultOwner,
            platformFeeRecipient
        );
        return address(v);
    }
}
