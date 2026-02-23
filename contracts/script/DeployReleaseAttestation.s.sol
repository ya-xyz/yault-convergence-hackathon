// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {ReleaseAttestation} from "../src/ReleaseAttestation.sol";

/**
 * @title DeployReleaseAttestation
 * @author Yault
 * @notice Foundry deployment script for the ReleaseAttestation contract.
 *        Used by the Oracle authority layer (Chainlink CRE + fallback).
 *
 * @dev Environment variables:
 *        DEPLOYER_PRIVATE_KEY — Private key for broadcast.
 *
 *      Usage:
 *        forge script script/DeployReleaseAttestation.s.sol:DeployReleaseAttestation \
 *          --rpc-url $RPC_URL \
 *          --broadcast \
 *          --verify
 *
 *      Post-deploy:
 *        - setOracleSubmitter(CRE_Forwarder_address)
 *        - setFallbackSubmitter(relayer_address, true)
 */
contract DeployReleaseAttestation is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console2.log("=== ReleaseAttestation Deployment ===");
        console2.log("Deployer (owner):", deployer);

        vm.startBroadcast(deployerKey);

        ReleaseAttestation attestation = new ReleaseAttestation(deployer);
        console2.log("ReleaseAttestation deployed at:", address(attestation));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("ReleaseAttestation:", address(attestation));
        console2.log("Next steps: setOracleSubmitter(), setFallbackSubmitter()");
    }
}
