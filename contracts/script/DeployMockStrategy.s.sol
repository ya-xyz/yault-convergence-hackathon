// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title DeployMockStrategy
 * @notice Deploys a Mock Aave-style pool + aToken on Sepolia so the vault can
 *         "invest" and we can simulate interest for testing harvest.
 *
 *   Env: WETH_ADDRESS (Sepolia WETH).
 *
 *   After deployment, as vault owner:
 *     1. vault.setStrategy(mockPool, aToken)
 *     2. vault.approveStrategyToken()
 *     3. vault.investToStrategy(idleAmount)   // move WETH into mock
 *     4. Transfer some WETH to mockPool (so it can pay out on harvest)
 *     5. mockPool.simulateInterest(address(vault), 1e18)  // 1 WETH "yield"
 *   Then any user with shares can call harvest().
 *
 *   Usage: forge script script/DeployMockStrategy.s.sol:DeployMockStrategy --rpc-url $RPC_URL --broadcast
 */
contract DeployMockStrategy is Script {
    function run() external {
        address weth = vm.envAddress("WETH_ADDRESS");
        console2.log("WETH_ADDRESS: ", weth);

        vm.startBroadcast();

        MockERC20ForScript aToken = new MockERC20ForScript("aWETH", "aWETH", 18);
        MockAavePoolForScript mockPool = new MockAavePoolForScript(IERC20(weth), address(aToken));

        vm.stopBroadcast();

        console2.log("aToken (mock): ", address(aToken));
        console2.log("MockAavePool: ", address(mockPool));
        console2.log("");
        console2.log("As vault owner, run:");
        console2.log("  1. vault.setStrategy(mockPool, aToken)");
        console2.log("  2. vault.approveStrategyToken()");
        console2.log("  3. vault.investToStrategy(<idle WETH amount>)");
        console2.log("  4. Transfer WETH to mockPool, then mockPool.simulateInterest(vaultAddress, 1e18)");
    }
}

// Standalone mocks (same logic as in test)
contract MockERC20ForScript is ERC20 {
    uint8 private _decimals;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) { _decimals = decimals_; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public view override returns (uint8) { return _decimals; }
}

/**
 * aToken that allows a specific pool to pull from the vault without the vault calling approve.
 * Use this when the vault was deployed before approveStrategyToken() existed.
 * Constructor: (vaultAddress) — when transferFrom(vault, ..., amount) is called by the pool, allowance is not required.
 */
contract AllowlistATokenForScript is ERC20 {
    uint8 private _decimals;
    address public immutable vaultAddress;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address vaultAddress_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        vaultAddress = vaultAddress_;
    }

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public view override returns (uint8) { return _decimals; }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (from == vaultAddress) {
            _transfer(from, to, amount);
            return true;
        }
        return super.transferFrom(from, to, amount);
    }
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

contract MockAavePoolForScript {
    IERC20 public underlying;
    address public aTokenAddr;

    constructor(IERC20 _underlying, address _aToken) {
        underlying = _underlying;
        aTokenAddr = _aToken;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(underlying), "wrong asset");
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        IMintable(aTokenAddr).mint(onBehalfOf, amount);
    }
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(underlying), "wrong asset");
        IERC20(aTokenAddr).transferFrom(msg.sender, address(this), amount);
        underlying.transfer(to, amount);
        return amount;
    }
    function simulateInterest(address user, uint256 amount) external {
        IMintable(aTokenAddr).mint(user, amount);
    }
}

// ---------------------------------------------------------------------------
//  DeployMockStrategyV2: use AllowlistAToken so vault does NOT need approveStrategyToken()
//  Env: WETH_ADDRESS, VAULT_ADDRESS. Deploy, then setStrategy(newPool, newAToken), then investToStrategy(amount).
// ---------------------------------------------------------------------------
contract DeployMockStrategyV2 is Script {
    function run() external {
        address weth = vm.envAddress("WETH_ADDRESS");
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        console2.log("WETH_ADDRESS:  ", weth);
        console2.log("VAULT_ADDRESS: ", vaultAddr);

        vm.startBroadcast();

        AllowlistATokenForScript aToken = new AllowlistATokenForScript("aWETH", "aWETH", 18, vaultAddr);
        MockAavePoolForScript mockPool = new MockAavePoolForScript(IERC20(weth), address(aToken));

        vm.stopBroadcast();

        console2.log("aToken (allowlist): ", address(aToken));
        console2.log("MockAavePool:      ", address(mockPool));
        console2.log("");
        console2.log("As vault owner (no approveStrategyToken needed):");
        console2.log("  1. cast send <VAULT> \"setStrategy(address,address)\" <POOL> <ATOKEN> --rpc-url $RPC_URL --private-key $OWNER_KEY");
        console2.log("  2. cast send <VAULT> \"investToStrategy(uint256)\" <AMOUNT_18DECIMALS> --rpc-url $RPC_URL --private-key $OWNER_KEY");
        console2.log("  3. Transfer WETH to mockPool, then cast send <POOL> \"simulateInterest(address,uint256)\" <VAULT> 1000000000000000000 ...");
    }
}
