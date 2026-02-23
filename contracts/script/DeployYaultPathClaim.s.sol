// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReleaseAttestation} from "../src/ReleaseAttestation.sol";
import {YaultPathClaim} from "../src/YaultPathClaim.sol";

/**
 * @title DeployYaultPathClaim
 * @author Yault
 * @notice Deploys YaultPathClaim (pool + path claim). Requires ReleaseAttestation and ERC20 asset.
 *
 * @dev Environment variables:
 *        DEPLOYER_PRIVATE_KEY       — Private key for broadcast (becomes owner).
 *        RELEASE_ATTESTATION_ADDRESS — Existing ReleaseAttestation contract.
 *        PATH_CLAIM_ASSET_ADDRESS   — ERC20 token address (e.g. USDC).
 *
 *      Usage:
 *        forge script script/DeployYaultPathClaim.s.sol:DeployYaultPathClaim \
 *          --rpc-url $RPC_URL \
 *          --broadcast \
 *          --verify
 */
contract DeployYaultPathClaim is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address attestationAddr = vm.envAddress("RELEASE_ATTESTATION_ADDRESS");
        address assetAddr = vm.envAddress("PATH_CLAIM_ASSET_ADDRESS");
        address deployer = vm.addr(deployerKey);

        console2.log("=== YaultPathClaim Deployment ===");
        console2.log("Deployer (owner):", deployer);
        console2.log("ReleaseAttestation:", attestationAddr);
        console2.log("Asset (ERC20):", assetAddr);

        vm.startBroadcast(deployerKey);

        YaultPathClaim pool = new YaultPathClaim(deployer, IERC20(assetAddr), attestationAddr);
        console2.log("YaultPathClaim deployed at:", address(pool));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("YaultPathClaim:", address(pool));
        console2.log("Next: owner calls registerWallet(), deposit(), registerPath(); set fallback submitter on ReleaseAttestation.");
    }
}
