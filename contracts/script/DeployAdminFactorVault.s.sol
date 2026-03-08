// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AdminFactorVault} from "../src/AdminFactorVault.sol";

/**
 * @title DeployAdminFactorVault
 * @author Yault
 * @notice Deploys AdminFactorVault and registers it as a fallbackSubmitter on ReleaseAttestation.
 *
 * @dev Environment variables:
 *        DEPLOYER_PRIVATE_KEY           — Private key for broadcast (becomes owner).
 *        RELEASE_ATTESTATION_ADDRESS    — Existing ReleaseAttestation contract.
 *        VAULT_SHARE_ESCROW_ADDRESS     — Existing VaultShareEscrow contract.
 *
 *      Usage:
 *        forge script script/DeployAdminFactorVault.s.sol:DeployAdminFactorVault \
 *          --rpc-url $RPC_URL \
 *          --broadcast \
 *          --verify
 *
 *      Post-deploy: the deployer (who must be ReleaseAttestation owner) registers
 *      the AdminFactorVault as a fallbackSubmitter so destroy() can submit REJECT.
 */
contract DeployAdminFactorVault is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address attestationAddr = vm.envAddress("RELEASE_ATTESTATION_ADDRESS");
        address escrowAddr = vm.envAddress("VAULT_SHARE_ESCROW_ADDRESS");
        address deployer = vm.addr(deployerKey);

        console2.log("=== AdminFactorVault Deployment ===");
        console2.log("Deployer (owner):", deployer);
        console2.log("ReleaseAttestation:", attestationAddr);
        console2.log("VaultShareEscrow:", escrowAddr);

        vm.startBroadcast(deployerKey);

        AdminFactorVault afVault = new AdminFactorVault(deployer, attestationAddr, escrowAddr);
        console2.log("AdminFactorVault deployed at:", address(afVault));

        // Register AdminFactorVault as a fallback submitter on ReleaseAttestation
        // so destroy() can submit REJECT attestations.
        // NOTE: This requires the deployer to be the owner of ReleaseAttestation.
        (bool success,) = attestationAddr.call(
            abi.encodeWithSignature("setFallbackSubmitter(address,bool)", address(afVault), true)
        );
        if (success) {
            console2.log("Registered as fallbackSubmitter on ReleaseAttestation");
        } else {
            console2.log("WARNING: Could not register as fallbackSubmitter.");
            console2.log("         Manually call ReleaseAttestation.setFallbackSubmitter(", address(afVault), ", true)");
        }

        // Register AdminFactorVault on VaultShareEscrow so destroyAndReclaim() can call reclaimFor().
        (bool escrowOk,) = escrowAddr.call(
            abi.encodeWithSignature("setAdminFactorVault(address)", address(afVault))
        );
        if (escrowOk) {
            console2.log("Registered as adminFactorVault on VaultShareEscrow");
        } else {
            console2.log("WARNING: Could not register on VaultShareEscrow.");
            console2.log("         Manually call VaultShareEscrow.setAdminFactorVault(", address(afVault), ")");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("AdminFactorVault:", address(afVault));
        console2.log("Next: plan owners call store(walletIdHash, index, ciphertext, fingerprint) during plan creation.");
    }
}
