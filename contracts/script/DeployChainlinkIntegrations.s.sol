// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ChainlinkPriceFeedTracker} from "../src/ChainlinkPriceFeedTracker.sol";
import {AutoHarvest} from "../src/AutoHarvest.sol";
import {CrossChainVaultBridge} from "../src/CrossChainVaultBridge.sol";
import {PortfolioAnalytics} from "../src/PortfolioAnalytics.sol";

/**
 * @title DeployChainlinkIntegrations
 * @author Yault
 * @notice Deploys all Chainlink integration contracts:
 *         1. ChainlinkPriceFeedTracker — Data Feeds for portfolio valuation
 *         2. AutoHarvest — Chainlink Automation for auto-harvesting
 *         3. CrossChainVaultBridge — CCIP for cross-chain operations
 *         4. PortfolioAnalytics — Functions for off-chain analytics
 *
 * @dev Environment variables:
 *        DEPLOYER_PRIVATE_KEY    — Private key used for broadcasting
 *        CCIP_ROUTER             — Chainlink CCIP Router address
 *        LINK_TOKEN              — LINK token address (for CCIP fees)
 *        FUNCTIONS_ROUTER        — Chainlink Functions Router address
 *        FUNCTIONS_SUB_ID        — Functions subscription ID
 *        FUNCTIONS_DON_ID        — Functions DON ID
 *
 *      Optional (for configuring after deployment):
 *        ETH_USD_FEED            — Chainlink ETH/USD price feed
 *        USDC_USD_FEED           — Chainlink USDC/USD price feed
 *        VAULT_ADDRESS           — YaultVault to register with tracker
 *
 *      Usage:
 *        forge script script/DeployChainlinkIntegrations.s.sol \
 *          --rpc-url $RPC_URL --broadcast --verify
 */
contract DeployChainlinkIntegrations is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // CCIP config
        address ccipRouter = vm.envOr("CCIP_ROUTER", address(0));
        address linkToken = vm.envOr("LINK_TOKEN", address(0));

        // Functions config
        address functionsRouter = vm.envOr("FUNCTIONS_ROUTER", address(0));
        uint64 functionsSubId = uint64(vm.envOr("FUNCTIONS_SUB_ID", uint256(0)));
        bytes32 functionsDonId = vm.envOr("FUNCTIONS_DON_ID", bytes32(0));

        console2.log("=== Yault Chainlink Integrations Deployment ===");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy Price Feed Tracker
        ChainlinkPriceFeedTracker tracker = new ChainlinkPriceFeedTracker(deployer);
        console2.log("PriceFeedTracker deployed at:", address(tracker));

        // 2. Deploy AutoHarvest
        AutoHarvest autoHarvest = new AutoHarvest(deployer);
        console2.log("AutoHarvest deployed at:     ", address(autoHarvest));

        // 3. Deploy CrossChain Bridge (if CCIP router is configured)
        if (ccipRouter != address(0)) {
            CrossChainVaultBridge bridge = new CrossChainVaultBridge(
                deployer,
                ccipRouter,
                linkToken
            );
            console2.log("CrossChainBridge deployed at:", address(bridge));
        } else {
            console2.log("CrossChainBridge: SKIPPED (no CCIP_ROUTER)");
        }

        // 4. Deploy Portfolio Analytics (if Functions router is configured)
        if (functionsRouter != address(0)) {
            PortfolioAnalytics analytics = new PortfolioAnalytics(
                deployer,
                functionsRouter,
                functionsSubId,
                functionsDonId
            );
            console2.log("PortfolioAnalytics deployed: ", address(analytics));
        } else {
            console2.log("PortfolioAnalytics: SKIPPED (no FUNCTIONS_ROUTER)");
        }

        // Optional: Configure price feeds if addresses are provided
        address ethUsdFeed = vm.envOr("ETH_USD_FEED", address(0));
        if (ethUsdFeed != address(0)) {
            tracker.setEthUsdFeed(ethUsdFeed);
            console2.log("ETH/USD feed configured:     ", ethUsdFeed);
        }

        address vaultAddress = vm.envOr("VAULT_ADDRESS", address(0));
        address usdcUsdFeed = vm.envOr("USDC_USD_FEED", address(0));
        if (vaultAddress != address(0) && usdcUsdFeed != address(0)) {
            tracker.registerVaultFeed(vaultAddress, usdcUsdFeed);
            console2.log("Vault feed registered:       ", vaultAddress);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Chainlink Integration Deployment Complete ===");
    }
}
