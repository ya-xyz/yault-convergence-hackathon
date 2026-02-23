// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {YaultVaultFactory} from "../src/YaultVaultFactory.sol";

/**
 * @title CreateWethVault
 * @notice Creates a WETH vault from an existing YaultVaultFactory (factory owner only).
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY  — Must be the factory owner.
 *   FACTORY_ADDRESS       — Existing YaultVaultFactory.
 *   WETH_ADDRESS          — WETH token on the same chain (e.g. Sepolia).
 *
 * Usage:
 *   forge script script/CreateWethVault.s.sol:CreateWethVault --rpc-url $RPC_URL --broadcast
 */
contract CreateWethVault is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        address wethAddress = vm.envAddress("WETH_ADDRESS");

        vm.startBroadcast(deployerKey);

        address vault = YaultVaultFactory(factoryAddress).createVault(
            IERC20(wethAddress),
            "Yault WETH Shares",
            "yWETH"
        );

        vm.stopBroadcast();

        console2.log("WETH Vault deployed at:", vault);
    }
}
