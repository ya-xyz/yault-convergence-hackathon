// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IYaultVault} from "../src/interfaces/IYaultVault.sol";

/**
 * @title SetStrategy
 * @author Yault
 * @notice One-time script for vault owner to set the Aave V3 yield strategy (pool + aToken).
 *
 * @dev Environment variables:
 *
 *        DEPLOYER_PRIVATE_KEY  — Must be the vault owner.
 *        VAULT_ADDRESS         — The YaultVault contract address.
 *        AAVE_POOL             — Aave V3 Pool address (e.g. Ethereum mainnet: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2).
 *        ATOKEN                — aToken for the vault's underlying asset (e.g. aEthWBTC: 0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8).
 *
 *      Usage (e.g. for WBTC vault on Ethereum mainnet):
 *        cast send $VAULT_ADDRESS "setStrategy(address,address)" $AAVE_POOL $ATOKEN --rpc-url $RPC_URL --private-key $OWNER_KEY
 *      Or run this script:
 *        VAULT_ADDRESS=0x... AAVE_POOL=0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 ATOKEN=0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8 forge script script/SetStrategy.s.sol:SetStrategy --rpc-url $RPC_URL --broadcast
 */
contract SetStrategy is Script {
    function run() external {
        uint256 ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address vaultAddress = vm.envAddress("VAULT_ADDRESS");
        address aavePool = vm.envAddress("AAVE_POOL");
        address aToken = vm.envAddress("ATOKEN");

        console2.log("=== Set Vault Strategy ===");
        console2.log("Vault:    ", vaultAddress);
        console2.log("AavePool: ", aavePool);
        console2.log("aToken:   ", aToken);

        vm.startBroadcast(ownerKey);
        IYaultVault(vaultAddress).setStrategy(aavePool, aToken);
        vm.stopBroadcast();

        console2.log("Strategy set successfully.");
    }
}
