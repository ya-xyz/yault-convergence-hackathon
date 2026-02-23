// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IYaultVaultCreator} from "./interfaces/IYaultVaultCreator.sol";

/**
 * @title YaultVaultFactory
 * @author Yault
 * @notice Factory for deploying per-strategy `YaultVault` instances.
 *
 * @dev Uses a separate YaultVaultCreator contract to perform the actual deployment,
 *      keeping this contract under the EIP-170 size limit (24 KiB).
 *      The factory owner controls vault creation and the default platform fee recipient.
 */
contract YaultVaultFactory is Ownable {
    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    /// @notice Creator contract used to deploy new vaults (avoids factory size limit).
    IYaultVaultCreator public immutable vaultCreator;

    /// @notice Default platform fee recipient used for newly created vaults.
    address public platformFeeRecipient;

    /// @notice Ordered list of all vaults created through this factory.
    address[] private _vaults;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    /// @notice Emitted when a new vault is deployed.
    /// @param vault   Address of the newly deployed `YaultVault`.
    /// @param asset   The underlying ERC-20 token.
    /// @param name    ERC-20 name of the vault shares.
    /// @param symbol  ERC-20 symbol of the vault shares.
    /// @param creator The address that called `createVault`.
    event VaultCreated(
        address indexed vault,
        address indexed asset,
        string name,
        string symbol,
        address indexed creator
    );

    /// @notice Emitted when the default platform fee recipient is updated.
    /// @param oldRecipient Previous recipient address.
    /// @param newRecipient New recipient address.
    event PlatformFeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    /// @dev Thrown when an address argument must not be zero.
    error ZeroAddress();

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    /**
     * @param owner_              The initial owner of the factory.
     * @param platformFeeRecipient_ Default platform fee recipient for new vaults.
     * @param vaultCreator_       Address of the YaultVaultCreator contract (deploy separately).
     */
    constructor(
        address owner_,
        address platformFeeRecipient_,
        address vaultCreator_
    ) Ownable(owner_) {
        if (platformFeeRecipient_ == address(0)) revert ZeroAddress();
        if (vaultCreator_ == address(0)) revert ZeroAddress();
        platformFeeRecipient = platformFeeRecipient_;
        vaultCreator = IYaultVaultCreator(vaultCreator_);
    }

    // -----------------------------------------------------------------------
    //  Vault deployment
    // -----------------------------------------------------------------------

    /**
     * @notice Deploy a new `YaultVault` for a given underlying asset.
     * @param asset  The ERC-20 token that the vault will accept as deposits.
     * @param name   ERC-20 name for the vault's share token.
     * @param symbol ERC-20 symbol for the vault's share token.
     * @return vault The address of the newly deployed vault.
     */
    function createVault(
        IERC20 asset,
        string calldata name,
        string calldata symbol
    ) external onlyOwner returns (address vault) {
        if (address(asset) == address(0)) revert ZeroAddress();

        vault = vaultCreator.createVault(
            asset,
            name,
            symbol,
            owner(),
            platformFeeRecipient
        );

        _vaults.push(vault);

        emit VaultCreated(vault, address(asset), name, symbol, msg.sender);
    }

    // -----------------------------------------------------------------------
    //  Admin
    // -----------------------------------------------------------------------

    /**
     * @notice Update the default platform fee recipient for future vaults.
     * @dev Does **not** retroactively change already-deployed vaults. Call
     *      `YaultVault.setPlatformFeeRecipient` on each existing vault if
     *      needed.
     * @param newRecipient The new platform fee address.
     */
    function setPlatformFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();

        address old = platformFeeRecipient;
        platformFeeRecipient = newRecipient;

        emit PlatformFeeRecipientUpdated(old, newRecipient);
    }

    // -----------------------------------------------------------------------
    //  View helpers
    // -----------------------------------------------------------------------

    /// @notice Return all vaults deployed through this factory.
    /// @return vaults Array of vault addresses.
    function getVaults() external view returns (address[] memory vaults) {
        vaults = _vaults;
    }

    /// @notice Return the total number of vaults deployed.
    /// @return count Number of vaults.
    function getVaultCount() external view returns (uint256 count) {
        count = _vaults.length;
    }
}
