// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {YaultVaultCreator} from "../src/YaultVaultCreator.sol";
import {YaultVaultFactory} from "../src/YaultVaultFactory.sol";

/**
 * @title Deploy
 * @author Yault
 * @notice Foundry deployment script for the Yault yield-vault system.
 *
 * @dev Deploys:
 *      1. `YaultVaultFactory` — owned by the deployer.
 *      2. One default `YaultVault` using WETH as the underlying asset.
 *      3. Optionally a WBTC vault when WBTC_ADDRESS is set.
 *      4. Optionally a USDC vault when USDC_ADDRESS is set.
 *
 *      Environment variables (set in `.env` or pass via `--env`):
 *
 *        DEPLOYER_PRIVATE_KEY    — Private key used for broadcasting.
 *        PLATFORM_FEE_RECIPIENT  — Address receiving the 25 % platform fee.
 *        WETH_ADDRESS            — Address of the WETH token on the target chain.
 *        WBTC_ADDRESS            — (Optional) Address of WBTC; if set, deploys a vault for WBTC.
 *        USDC_ADDRESS            — (Optional) Address of USDC; if set, deploys a vault for USDC.
 *
 *      Usage:
 *        forge script script/Deploy.s.sol:Deploy \
 *          --rpc-url $RPC_URL \
 *          --broadcast \
 *          --verify
 *
 *      To deploy with WBTC + USDC vaults (e.g. Ethereum mainnet):
 *        WBTC_ADDRESS=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
 */
contract Deploy is Script {
    function run() external {
        // ---------------------------------------------------------------
        //  Load configuration from environment
        // ---------------------------------------------------------------
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address platformFeeRecipient = vm.envAddress("PLATFORM_FEE_RECIPIENT");
        address wethAddress = vm.envAddress("WETH_ADDRESS");
        address wbtcAddress = vm.envOr("WBTC_ADDRESS", address(0));
        address usdcAddress = vm.envOr("USDC_ADDRESS", address(0));

        address deployer = vm.addr(deployerKey);

        console2.log("=== Yault Vault Deployment ===");
        console2.log("Deployer:              ", deployer);
        console2.log("Platform fee recipient:", platformFeeRecipient);
        console2.log("WETH address:          ", wethAddress);
        if (wbtcAddress != address(0)) console2.log("WBTC address:          ", wbtcAddress);
        if (usdcAddress != address(0)) console2.log("USDC address:          ", usdcAddress);

        // ---------------------------------------------------------------
        //  Begin broadcast
        // ---------------------------------------------------------------
        vm.startBroadcast(deployerKey);

        // 1. Deploy the vault creator (holds YaultVault creation bytecode; keeps factory under 24 KiB).
        YaultVaultCreator creator = new YaultVaultCreator();
        console2.log("Creator deployed at:   ", address(creator));

        // 2. Deploy the factory (uses creator for createVault).
        YaultVaultFactory factory = new YaultVaultFactory(
            deployer,
            platformFeeRecipient,
            address(creator)
        );
        console2.log("Factory deployed at:   ", address(factory));

        // 3. Deploy the default WETH vault through the factory.
        address vaultAddress = factory.createVault(
            IERC20(wethAddress),
            "Yault WETH Vault",
            "yWETH"
        );
        console2.log("WETH Vault deployed at:", vaultAddress);

        // 4. Optionally deploy WBTC vault (yield: set Aave strategy later via SetStrategy script).
        if (wbtcAddress != address(0)) {
            address wbtcVaultAddress = factory.createVault(
                IERC20(wbtcAddress),
                "Yault WBTC Vault",
                "yWBTC"
            );
            console2.log("WBTC Vault deployed at:", wbtcVaultAddress);
        }

        // 5. Optionally deploy USDC vault (yield: set Aave strategy later via SetStrategy script).
        if (usdcAddress != address(0)) {
            address usdcVaultAddress = factory.createVault(
                IERC20(usdcAddress),
                "Yault USDC Vault",
                "yUSDC"
            );
            console2.log("USDC Vault deployed at:", usdcVaultAddress);
        }

        vm.stopBroadcast();

        // ---------------------------------------------------------------
        //  Summary
        // ---------------------------------------------------------------
        console2.log("");
        console2.log("=== Deployment Complete ===");
        console2.log("Creator:    ", address(creator));
        console2.log("Factory:    ", address(factory));
        console2.log("WETH Vault: ", vaultAddress);
        if (wbtcAddress != address(0)) console2.log("WBTC Vault: (see above)");
        if (usdcAddress != address(0)) console2.log("USDC Vault: (see above)");
        console2.log("Total vaults:", factory.getVaultCount());
    }
}
