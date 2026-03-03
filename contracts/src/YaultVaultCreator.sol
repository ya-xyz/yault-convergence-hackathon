// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {YaultVault} from "./YaultVault.sol";

/**
 * @title YaultVaultCreator
 * @author Yault
 * @notice Minimal contract that deploys YaultVault instances. Used by YaultVaultFactory
 *         to avoid exceeding the EIP-170 contract size limit (24 KiB).
 * @dev L-03 FIX: Restricted to onlyOwner to prevent unauthorized vault creation.
 *      Deploy once; Factory holds this address and calls createVault(...). The vault
 *      is created by this contract (CREATE) but ownership is set to the requested owner.
 */
contract YaultVaultCreator is Ownable {
    constructor(address initialOwner) Ownable(initialOwner) {}

    /**
     * @notice Deploy a new YaultVault. Only callable by the owner (factory).
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
    ) external onlyOwner returns (address vault) {
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
