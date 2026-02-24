// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {YaultVault} from "../src/YaultVault.sol";
import {YaultVaultCreator} from "../src/YaultVaultCreator.sol";
import {YaultVaultFactory} from "../src/YaultVaultFactory.sol";
import {VaultShareEscrow} from "../src/VaultShareEscrow.sol";
import {ReleaseAttestation} from "../src/ReleaseAttestation.sol";

// ---------------------------------------------------------------------------
//  Mock ERC-20 (reuse from YaultVault.t.sol pattern)
// ---------------------------------------------------------------------------

contract MockToken is ERC20 {
    uint8 private _dec;

    constructor() ERC20("Mock USDC", "mUSDC") {
        _dec = 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }
}

// ---------------------------------------------------------------------------
//  VaultShareEscrow Test Suite
// ---------------------------------------------------------------------------

contract VaultShareEscrowTest is Test {
    MockToken internal token;
    YaultVault internal vault;
    VaultShareEscrow internal escrow;
    ReleaseAttestation internal attestation;

    address internal deployer = makeAddr("deployer");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");     // plan owner
    address internal bob = makeAddr("bob");         // recipient
    address internal oracle = makeAddr("oracle");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant WALLET_HASH = keccak256("alice-wallet");
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence");
    bytes32 internal constant REASON_CODE = bytes32(0);

    uint256 internal constant DEPOSIT_AMOUNT = 10_000e6;

    function setUp() public {
        // Deploy token
        token = new MockToken();

        // Deploy vault via factory
        YaultVaultCreator creator = new YaultVaultCreator();
        YaultVaultFactory factory = new YaultVaultFactory(deployer, platform, address(creator));
        vm.prank(deployer);
        address vaultAddr = factory.createVault(IERC20(address(token)), "Yault USDC", "yUSDC");
        vault = YaultVault(vaultAddr);

        // Deploy attestation
        attestation = new ReleaseAttestation(deployer);
        vm.prank(deployer);
        attestation.setOracleSubmitter(oracle);

        // Deploy escrow
        escrow = new VaultShareEscrow(deployer, address(vault), address(attestation));

        // Mark escrow as transfer exempt on vault
        vm.prank(deployer);
        vault.setTransferExempt(address(escrow), true);

        // Fund alice
        token.mint(alice, DEPOSIT_AMOUNT * 10);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);

        // Alice deposits into vault
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Alice registers wallet in escrow
        vm.prank(alice);
        escrow.registerWallet(WALLET_HASH);
    }

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------

    function _approveAndDeposit(uint256 shares, uint256[] memory indices, uint256[] memory amounts) internal {
        vm.prank(alice);
        vault.approve(address(escrow), shares);

        vm.prank(alice);
        escrow.deposit(WALLET_HASH, shares, indices, amounts);
    }

    function _submitRelease(uint256 recipientIndex) internal {
        // Cache constants BEFORE vm.prank to avoid the prank being consumed by external view calls
        uint8 srcOracle = attestation.SOURCE_ORACLE();
        uint8 decRelease = attestation.DECISION_RELEASE();
        vm.prank(oracle);
        attestation.submitAttestation(srcOracle, WALLET_HASH, recipientIndex, decRelease, REASON_CODE, EVIDENCE_HASH);
    }

    function _submitHold(uint256 recipientIndex) internal {
        uint8 srcOracle = attestation.SOURCE_ORACLE();
        uint8 decHold = attestation.DECISION_HOLD();
        vm.prank(oracle);
        attestation.submitAttestation(srcOracle, WALLET_HASH, recipientIndex, decHold, REASON_CODE, EVIDENCE_HASH);
    }

    function _submitReject(uint256 recipientIndex) internal {
        uint8 srcOracle = attestation.SOURCE_ORACLE();
        uint8 decReject = attestation.DECISION_REJECT();
        vm.prank(oracle);
        attestation.submitAttestation(srcOracle, WALLET_HASH, recipientIndex, decReject, REASON_CODE, EVIDENCE_HASH);
    }

    // -----------------------------------------------------------------------
    //  Basic deposit + claim tests
    // -----------------------------------------------------------------------

    function testDeposit() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        indices[0] = 1;
        indices[1] = 2;
        amounts[0] = shares / 2;
        amounts[1] = shares - shares / 2;

        _approveAndDeposit(shares, indices, amounts);

        assertEq(vault.balanceOf(address(escrow)), shares, "escrow should hold shares");
        assertEq(escrow.totalDeposited(WALLET_HASH), shares, "totalDeposited mismatch");
        assertEq(escrow.allocatedShares(WALLET_HASH, 1), amounts[0], "alloc1 mismatch");
        assertEq(escrow.allocatedShares(WALLET_HASH, 2), amounts[1], "alloc2 mismatch");
    }

    function testClaim_Success() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // Submit RELEASE attestation
        _submitRelease(1);

        // Alice (wallet owner) claims to bob
        uint256 bobBalanceBefore = token.balanceOf(bob);

        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);

        // Bob should receive underlying assets
        assertGt(token.balanceOf(bob), bobBalanceBefore, "bob should receive underlying");
        assertEq(escrow.claimedShares(WALLET_HASH, 1), shares, "claimed should match");
    }

    // -----------------------------------------------------------------------
    //  claim() access control (Fix #4)
    // -----------------------------------------------------------------------

    function testClaim_RevertsWhenNotWalletOwner() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);
        _submitRelease(1);

        // Attacker tries to claim (not wallet owner) — should revert
        vm.prank(attacker);
        vm.expectRevert(VaultShareEscrow.NotWalletOwner.selector);
        escrow.claim(WALLET_HASH, 1, attacker, shares, true);
    }

    function testClaim_RevertsWhenBobTriesToClaim() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);
        _submitRelease(1);

        // Bob (not wallet owner) tries to claim — should revert
        vm.prank(bob);
        vm.expectRevert(VaultShareEscrow.NotWalletOwner.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);
    }

    function testClaim_NoAttestationReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // No attestation → revert
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.NoAttestation.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);
    }

    function testClaim_HoldAttestationReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);
        _submitHold(1);

        // HOLD attestation → claim should revert (not RELEASE)
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AttestationNotRelease.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);
    }

    // -----------------------------------------------------------------------
    //  reclaim() with HOLD/REJECT attestation (Fix #3)
    // -----------------------------------------------------------------------

    function testReclaim_SuccessNoAttestation() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // Reclaim with no attestation — should succeed
        vm.prank(alice);
        escrow.reclaim(WALLET_HASH, 1, shares);

        assertEq(vault.balanceOf(alice), shares, "alice should get shares back");
        assertEq(escrow.allocatedShares(WALLET_HASH, 1), 0, "allocation should be 0");
    }

    function testReclaim_AllowedWithHoldAttestation() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // Oracle submits HOLD decision
        _submitHold(1);

        // Owner should still be able to reclaim (HOLD is not RELEASE)
        vm.prank(alice);
        escrow.reclaim(WALLET_HASH, 1, shares);

        assertEq(vault.balanceOf(alice), shares, "alice should get shares back after HOLD");
    }

    function testReclaim_AllowedWithRejectAttestation() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // Oracle submits REJECT decision
        _submitReject(1);

        // Owner should still be able to reclaim (REJECT is not RELEASE)
        vm.prank(alice);
        escrow.reclaim(WALLET_HASH, 1, shares);

        assertEq(vault.balanceOf(alice), shares, "alice should get shares back after REJECT");
    }

    function testReclaim_BlockedWithReleaseAttestation() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // Oracle submits RELEASE
        _submitRelease(1);

        // Reclaim should revert — funds are committed to recipient
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AttestationAlreadyReleased.selector);
        escrow.reclaim(WALLET_HASH, 1, shares);
    }

    function testReclaim_NotWalletOwnerReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // Attacker tries to reclaim
        vm.prank(attacker);
        vm.expectRevert(VaultShareEscrow.NotWalletOwner.selector);
        escrow.reclaim(WALLET_HASH, 1, shares);
    }

    // -----------------------------------------------------------------------
    //  Yield accrual in escrow
    // -----------------------------------------------------------------------

    function testShares_EarnYieldInEscrow() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        uint256 assetsBefore = vault.convertToAssets(shares);

        // Simulate yield
        token.mint(address(vault), 1_000e6);

        uint256 assetsAfter = vault.convertToAssets(shares);

        assertGt(assetsAfter, assetsBefore, "shares should be worth more after yield");
    }

    // -----------------------------------------------------------------------
    //  Multi-recipient deposit + partial claim
    // -----------------------------------------------------------------------

    function testMultiRecipient_DepositAndClaim() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](3);
        uint256[] memory amounts = new uint256[](3);
        indices[0] = 1;
        indices[1] = 2;
        indices[2] = 3;
        amounts[0] = shares / 3;
        amounts[1] = shares / 3;
        amounts[2] = shares - 2 * (shares / 3); // remainder to avoid dust

        _approveAndDeposit(shares, indices, amounts);

        // Release only recipient 2
        _submitRelease(2);

        // Alice claims for recipient 2
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 2, bob, amounts[1], true);

        // Recipient 1 and 3 still locked (no attestation)
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), amounts[0], "recipient 1 still has allocation");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 3), amounts[2], "recipient 3 still has allocation");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 2), 0, "recipient 2 fully claimed");
    }

    // -----------------------------------------------------------------------
    //  Principal tracking through escrow flow (integration)
    // -----------------------------------------------------------------------

    function testPrincipal_ReducedOnEscrowDeposit() public {
        uint256 principalBefore = vault.userPrincipal(alice);
        assertEq(principalBefore, DEPOSIT_AMOUNT, "principal should equal deposit");

        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        // After all shares moved to escrow, alice's principal should be 0
        assertEq(vault.userPrincipal(alice), 0, "principal should be 0 after full escrow deposit");
    }

    // -----------------------------------------------------------------------
    //  Threat-model / edge: allocation mismatch, reclaim overflow
    // -----------------------------------------------------------------------

    function testThreat_Deposit_LengthMismatchReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](2);
        uint256[] memory amounts = new uint256[](1); // length 1 != 2
        indices[0] = 1;
        indices[1] = 2;
        amounts[0] = shares;

        vm.prank(alice);
        vault.approve(address(escrow), shares);
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AllocationSumMismatch.selector);
        escrow.deposit(WALLET_HASH, shares, indices, amounts);
    }

    function testThreat_Deposit_SumNotEqualSharesReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        indices[0] = 1;
        indices[1] = 2;
        amounts[0] = shares;
        amounts[1] = 1; // sum = shares + 1 != shares

        vm.prank(alice);
        vault.approve(address(escrow), shares);
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AllocationSumMismatch.selector);
        escrow.deposit(WALLET_HASH, shares, indices, amounts);
    }

    function testThreat_Claim_AmountExceedsRemainingReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);
        _submitRelease(1);

        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ClaimExceedsRemaining.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares + 1, true);
    }

    function testThreat_Reclaim_AmountExceedsUnclaimedReverts() public {
        uint256 shares = vault.balanceOf(alice);
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;

        _approveAndDeposit(shares, indices, amounts);

        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ReclaimExceedsUnclaimed.selector);
        escrow.reclaim(WALLET_HASH, 1, shares + 1);
    }

    function testThreat_RegisterWallet_TwiceReverts() public {
        // setUp already registered WALLET_HASH for alice
        assertEq(escrow.walletOwner(WALLET_HASH), alice);

        vm.prank(attacker);
        vm.expectRevert(VaultShareEscrow.WalletAlreadyRegistered.selector);
        escrow.registerWallet(WALLET_HASH);
    }
}
