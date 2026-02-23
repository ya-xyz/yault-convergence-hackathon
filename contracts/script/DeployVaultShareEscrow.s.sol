// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VaultShareEscrow} from "../src/VaultShareEscrow.sol";

/**
 * @title DeployVaultShareEscrow
 * @author Yault
 * @notice Deploys VaultShareEscrow (hold vault shares, release by attestation).
 *
 * @dev Environment variables:
 *        DEPLOYER_PRIVATE_KEY       — Private key for broadcast (becomes owner).
 *        VAULT_ADDRESS              — YaultVault (ERC4626) contract address.
 *        RELEASE_ATTESTATION_ADDRESS — Existing ReleaseAttestation contract.
 *
 *      Usage:
 *        forge script script/DeployVaultShareEscrow.s.sol:DeployVaultShareEscrow \
 *          --rpc-url $RPC_URL \
 *          --broadcast \
 *          --verify
 */
contract DeployVaultShareEscrow is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address attestationAddr = vm.envAddress("RELEASE_ATTESTATION_ADDRESS");
        address deployer = vm.addr(deployerKey);

        console2.log("=== VaultShareEscrow Deployment ===");
        console2.log("Deployer (owner):", deployer);
        console2.log("Vault (YaultVault):", vaultAddr);
        console2.log("ReleaseAttestation:", attestationAddr);

        vm.startBroadcast(deployerKey);

        VaultShareEscrow escrow = new VaultShareEscrow(deployer, vaultAddr, attestationAddr);
        console2.log("VaultShareEscrow deployed at:", address(escrow));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("VaultShareEscrow:", address(escrow));
        console2.log("Next: owner calls registerWallet(walletIdHash), then deposit(vault shares + allocations).");
    }
}
