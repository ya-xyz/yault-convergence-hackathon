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
//  Mock ERC-20
// ---------------------------------------------------------------------------

contract IntegrationMockToken is ERC20 {
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
//  Integration Test: Vault → Escrow → Attestation → Claim (full E2E)
// ---------------------------------------------------------------------------

contract IntegrationEscrowClaimTest is Test {
    IntegrationMockToken internal token;
    YaultVault internal vault;
    VaultShareEscrow internal escrow;
    ReleaseAttestation internal attestation;

    address internal deployer = makeAddr("deployer");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");        // asset owner
    address internal bob = makeAddr("bob");            // recipient 1
    address internal carol = makeAddr("carol");        // recipient 2
    address internal dave = makeAddr("dave");          // recipient 3
    address internal oracle = makeAddr("oracle");
    address internal fallbackAuth = makeAddr("fallbackAuth");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant WALLET_HASH = keccak256("alice-wallet-001");
    bytes32 internal constant WALLET_HASH_2 = keccak256("alice-wallet-002");
    bytes32 internal constant EVIDENCE = keccak256("death-certificate-hash");
    bytes32 internal constant REASON_CODE = keccak256("verified_death");

    uint256 internal constant DEPOSIT_AMOUNT = 100_000e6; // 100,000 USDC

    function setUp() public {
        // Deploy token
        token = new IntegrationMockToken();

        // Deploy vault via factory
        YaultVaultCreator creator = new YaultVaultCreator(address(this));
        YaultVaultFactory factory = new YaultVaultFactory(deployer, platform, address(creator));
        creator.transferOwnership(address(factory));
        vm.prank(deployer);
        address vaultAddr = factory.createVault(IERC20(address(token)), "Yault USDC", "yUSDC");
        vault = YaultVault(vaultAddr);

        // Deploy attestation
        attestation = new ReleaseAttestation(deployer);
        vm.startPrank(deployer);
        attestation.setOracleSubmitter(oracle);
        attestation.setFallbackSubmitter(fallbackAuth, true);
        vm.stopPrank();

        // Deploy escrow
        escrow = new VaultShareEscrow(deployer, address(vault), address(attestation));

        // Mark escrow as transfer exempt on vault
        vm.prank(deployer);
        vault.setTransferExempt(address(escrow), true);

        // Fund alice
        token.mint(alice, DEPOSIT_AMOUNT * 10);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
    }

    // =======================================================================
    //  Helpers
    // =======================================================================

    function _aliceDepositsToVault(uint256 amount) internal returns (uint256 shares) {
        vm.prank(alice);
        shares = vault.deposit(amount, alice);
    }

    function _aliceEscrowsShares(
        bytes32 walletHash,
        uint256 shares,
        uint256[] memory indices,
        uint256[] memory amounts
    ) internal {
        vm.prank(deployer);
        escrow.registerWallet(walletHash, alice);
        vm.prank(alice);
        vault.approve(address(escrow), shares);
        vm.prank(alice);
        escrow.deposit(walletHash, shares, indices, amounts);
    }

    function _oracleRelease(bytes32 walletHash, uint256 recipientIndex) internal {
        uint8 srcOracle = attestation.SOURCE_ORACLE();
        uint8 decRelease = attestation.DECISION_RELEASE();
        vm.prank(oracle);
        attestation.submitAttestation(srcOracle, walletHash, recipientIndex, decRelease, REASON_CODE, EVIDENCE);
    }

    function _oracleHold(bytes32 walletHash, uint256 recipientIndex) internal {
        uint8 srcOracle = attestation.SOURCE_ORACLE();
        uint8 decHold = attestation.DECISION_HOLD();
        vm.prank(oracle);
        attestation.submitAttestation(srcOracle, walletHash, recipientIndex, decHold, REASON_CODE, EVIDENCE);
    }

    function _fallbackRelease(bytes32 walletHash, uint256 recipientIndex) internal {
        uint8 srcFallback = attestation.SOURCE_FALLBACK();
        uint8 decRelease = attestation.DECISION_RELEASE();
        vm.prank(fallbackAuth);
        attestation.submitAttestation(srcFallback, walletHash, recipientIndex, decRelease, REASON_CODE, EVIDENCE);
    }

    function _simulateYield(uint256 amount) internal {
        token.mint(address(vault), amount);
    }

    // =======================================================================
    //  P0: Full E2E — deposit → escrow → yield → attestation → claim
    // =======================================================================

    function testE2E_FullFlow_SingleRecipient() public {
        // 1. Alice deposits 100k USDC into vault
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);
        assertEq(vault.userPrincipal(alice), DEPOSIT_AMOUNT, "principal after deposit");

        // 2. Alice escrows all shares for 1 recipient (bob = index 1)
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        assertEq(vault.balanceOf(address(escrow)), shares, "escrow holds shares");
        assertEq(vault.balanceOf(alice), 0, "alice has 0 shares");
        assertEq(escrow.allocatedShares(WALLET_HASH, 1), shares, "allocated to recipient 1");

        // 3. Time passes, yield accrues (10,000 USDC = 10% yield)
        uint256 yieldAmount = 10_000e6;
        _simulateYield(yieldAmount);

        // Verify shares are now worth more
        uint256 assetsForShares = vault.convertToAssets(shares);
        assertGt(assetsForShares, DEPOSIT_AMOUNT, "shares worth more after yield");

        // 4. Oracle submits RELEASE attestation
        _oracleRelease(WALLET_HASH, 1);

        // Verify attestation exists
        assertTrue(attestation.hasAttestation(WALLET_HASH, 1), "attestation should exist");

        // 5. Alice (as wallet owner acting on behalf of recipient) claims to bob
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, shares, true); // redeemToAsset = true

        // 6. Verify bob received principal + yield
        uint256 bobReceived = token.balanceOf(bob) - bobBefore;
        assertGt(bobReceived, DEPOSIT_AMOUNT, "bob should receive more than principal (includes yield)");
        assertApproxEqAbs(bobReceived, assetsForShares, 2, "bob should get ~full asset value of shares");

        // 7. Verify escrow state is clean
        assertEq(escrow.claimedShares(WALLET_HASH, 1), shares, "claimed = all shares");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), 0, "remaining = 0");
    }

    function testE2E_FullFlow_MultiRecipient() public {
        // 1. Alice deposits
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        // 2. Escrow to 3 recipients: 50%, 30%, 20%
        uint256[] memory indices = new uint256[](3);
        uint256[] memory amounts = new uint256[](3);
        indices[0] = 1;
        indices[1] = 2;
        indices[2] = 3;
        amounts[0] = (shares * 50) / 100;
        amounts[1] = (shares * 30) / 100;
        amounts[2] = shares - amounts[0] - amounts[1]; // remainder to avoid dust

        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // 3. Yield accrues
        _simulateYield(20_000e6); // 20% yield

        // 4. Release only recipient 1 (bob)
        _oracleRelease(WALLET_HASH, 1);

        // 5. Bob claims
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, amounts[0], true);
        uint256 bobReceived = token.balanceOf(bob) - bobBefore;
        assertGt(bobReceived, (DEPOSIT_AMOUNT * 50) / 100, "bob gets 50% principal + yield");

        // 6. Recipient 2 and 3 still locked — no attestation
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.NoAttestation.selector);
        escrow.claim(WALLET_HASH, 2, carol, amounts[1], true);

        // 7. Release recipient 2, claim
        _oracleRelease(WALLET_HASH, 2);
        uint256 carolBefore = token.balanceOf(carol);
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 2, carol, amounts[1], true);
        assertGt(token.balanceOf(carol) - carolBefore, 0, "carol received assets");

        // 8. Recipient 3 still locked
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 3), amounts[2], "recipient 3 still has allocation");
    }

    // =======================================================================
    //  P0: Partial claims (multiple claims for same recipient)
    // =======================================================================

    function testE2E_PartialClaim_MultipleTimes() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        _oracleRelease(WALLET_HASH, 1);

        // Claim 1/3
        uint256 firstClaim = shares / 3;
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, firstClaim, true);
        assertEq(escrow.claimedShares(WALLET_HASH, 1), firstClaim, "claimed after first");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), shares - firstClaim, "remaining after first");

        // Claim another 1/3
        uint256 secondClaim = shares / 3;
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, secondClaim, true);
        assertEq(escrow.claimedShares(WALLET_HASH, 1), firstClaim + secondClaim, "claimed after second");

        // Claim the rest
        uint256 rest = shares - firstClaim - secondClaim;
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, rest, true);
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), 0, "fully claimed");

        // Attempting one more should fail
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ClaimExceedsRemaining.selector);
        escrow.claim(WALLET_HASH, 1, bob, 1, true);
    }

    // =======================================================================
    //  P0: Yield accrual verified numerically
    // =======================================================================

    function testE2E_YieldDistribution_RecipientGetsYield() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Verify: at this point shares = 1:1 with underlying
        uint256 assetsBefore = vault.convertToAssets(shares);
        assertApproxEqAbs(assetsBefore, DEPOSIT_AMOUNT, 1, "shares should be ~1:1");

        // Simulate 50% yield (50,000 USDC on 100,000 deposit)
        _simulateYield(50_000e6);

        // Now shares should be worth ~150,000 USDC
        uint256 assetsAfter = vault.convertToAssets(shares);
        assertApproxEqAbs(assetsAfter, 150_000e6, 100, "shares worth ~150k after 50% yield");

        // Release and claim
        _oracleRelease(WALLET_HASH, 1);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);

        uint256 bobReceived = token.balanceOf(bob) - bobBefore;
        // Bob should receive ~150,000 (principal + yield)
        assertApproxEqAbs(bobReceived, 150_000e6, 100, "bob receives principal + 50% yield");
    }

    // =======================================================================
    //  P0: Error paths
    // =======================================================================

    function testE2E_ClaimWithoutAttestation_Reverts() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // No attestation submitted — claim should fail
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.NoAttestation.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);
    }

    function testE2E_ClaimExceedsAllocation_Reverts() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        _oracleRelease(WALLET_HASH, 1);

        // Try to claim more than allocated
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ClaimExceedsRemaining.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares + 1, true);
    }

    function testE2E_ClaimZeroAmount_Reverts() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        _oracleRelease(WALLET_HASH, 1);

        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ClaimAmountZero.selector);
        escrow.claim(WALLET_HASH, 1, bob, 0, true);
    }

    function testE2E_ClaimToZeroAddress_Reverts() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        _oracleRelease(WALLET_HASH, 1);

        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ZeroReceiver.selector);
        escrow.claim(WALLET_HASH, 1, address(0), shares, true);
    }

    function testE2E_ReclaimAfterRelease_Blocked() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        _oracleRelease(WALLET_HASH, 1);

        // Owner tries to reclaim after RELEASE — should fail
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AttestationAlreadyReleased.selector);
        escrow.reclaim(WALLET_HASH, 1, shares);
    }

    function testE2E_ReclaimBeforeAttestation_Succeeds() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // No attestation — reclaim should work
        vm.prank(alice);
        escrow.reclaim(WALLET_HASH, 1, shares);

        assertEq(vault.balanceOf(alice), shares, "alice got shares back");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), 0, "allocation cleared");
    }

    function testE2E_AttackerCannotClaim() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        _oracleRelease(WALLET_HASH, 1);

        // Attacker tries to claim (not wallet owner)
        vm.prank(attacker);
        vm.expectRevert(VaultShareEscrow.NotWalletOwner.selector);
        escrow.claim(WALLET_HASH, 1, attacker, shares, true);
    }

    // =======================================================================
    //  P1: Attestation state transitions → escrow behavior
    // =======================================================================

    function testE2E_HoldThenRelease_ClaimSucceeds() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Oracle first submits HOLD
        _oracleHold(WALLET_HASH, 1);

        // Claim should fail (HOLD, not RELEASE)
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AttestationNotRelease.selector);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);

        // Owner can still reclaim during HOLD
        // (But let's not reclaim — instead update to RELEASE)

        // Oracle updates to RELEASE (overwriting HOLD)
        _oracleRelease(WALLET_HASH, 1);

        // Now claim should succeed
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, shares, true);
        assertGt(token.balanceOf(bob), 0, "bob received assets after HOLD then RELEASE");
    }

    function testE2E_ReclaimDuringHold_ThenDeposit() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Oracle submits HOLD
        _oracleHold(WALLET_HASH, 1);

        // Owner reclaims during HOLD (allowed)
        vm.prank(alice);
        escrow.reclaim(WALLET_HASH, 1, shares);
        assertEq(vault.balanceOf(alice), shares, "alice got shares back");

        // Alice can re-deposit (different wallet hash, since same wallet was already registered)
        vm.prank(deployer);
        escrow.registerWallet(WALLET_HASH_2, alice);
        vm.prank(alice);
        vault.approve(address(escrow), shares);

        uint256[] memory newIndices = new uint256[](1);
        uint256[] memory newAmounts = new uint256[](1);
        newIndices[0] = 1;
        newAmounts[0] = shares;
        vm.prank(alice);
        escrow.deposit(WALLET_HASH_2, shares, newIndices, newAmounts);

        assertEq(escrow.allocatedShares(WALLET_HASH_2, 1), shares, "re-deposited in new wallet");
    }

    function testE2E_ReleaseIsFinal_CannotOverwrite() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Oracle releases
        _oracleRelease(WALLET_HASH, 1);

        // Cache constants before expectRevert (they are external calls that consume expectRevert)
        uint8 srcOracle = attestation.SOURCE_ORACLE();
        uint8 srcFallback = attestation.SOURCE_FALLBACK();
        uint8 decHold = attestation.DECISION_HOLD();
        uint8 decRelease = attestation.DECISION_RELEASE();

        // Oracle tries to overwrite RELEASE with HOLD — should revert
        vm.prank(oracle);
        vm.expectRevert(ReleaseAttestation.ReleaseIsFinal.selector);
        attestation.submitAttestation(srcOracle, WALLET_HASH, 1, decHold, REASON_CODE, EVIDENCE);

        // Fallback also cannot overwrite RELEASE
        vm.prank(fallbackAuth);
        vm.expectRevert(ReleaseAttestation.ReleaseIsFinal.selector);
        attestation.submitAttestation(srcFallback, WALLET_HASH, 1, decRelease, REASON_CODE, EVIDENCE);
    }

    function testE2E_FallbackCannotOverwriteOracle() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Oracle submits HOLD
        _oracleHold(WALLET_HASH, 1);

        // Cache constants before expectRevert
        uint8 srcFallback = attestation.SOURCE_FALLBACK();
        uint8 decRelease = attestation.DECISION_RELEASE();

        // Fallback tries to overwrite oracle's HOLD — should revert
        vm.prank(fallbackAuth);
        vm.expectRevert(ReleaseAttestation.OracleAttestationAlreadyExists.selector);
        attestation.submitAttestation(srcFallback, WALLET_HASH, 1, decRelease, REASON_CODE, EVIDENCE);
    }

    // =======================================================================
    //  P1: Multi-recipient sequential claims with yield between claims
    // =======================================================================

    function testE2E_MultiRecipient_YieldBetweenClaims() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        indices[0] = 1;
        indices[1] = 2;
        amounts[0] = shares / 2;
        amounts[1] = shares - shares / 2;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Release recipient 1, yield accrues, then claim
        _oracleRelease(WALLET_HASH, 1);
        _simulateYield(10_000e6); // 10% yield

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 1, bob, amounts[0], true);
        uint256 bobGot = token.balanceOf(bob) - bobBefore;

        // More yield accrues between claims
        _simulateYield(10_000e6);

        // Release recipient 2 and claim
        _oracleRelease(WALLET_HASH, 2);
        uint256 carolBefore = token.balanceOf(carol);
        vm.prank(alice);
        escrow.claim(WALLET_HASH, 2, carol, amounts[1], true);
        uint256 carolGot = token.balanceOf(carol) - carolBefore;

        // Both should have received more than their original principal share
        assertGt(bobGot, (DEPOSIT_AMOUNT * 50) / 100, "bob got principal + yield");
        assertGt(carolGot, (DEPOSIT_AMOUNT * 50) / 100, "carol got principal + even more yield");

        // Carol should have gotten more yield per share since more time passed
        // (She benefited from yield that accrued while bob's shares were still partially in vault)
        // Note: after bob's claim, remaining shares get proportionally more yield
    }

    // =======================================================================
    //  P1: Partial reclaim (reclaim some, keep some)
    // =======================================================================

    function testE2E_PartialReclaim() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        // Reclaim half
        uint256 half = shares / 2;
        vm.prank(alice);
        escrow.reclaim(WALLET_HASH, 1, half);

        assertEq(vault.balanceOf(alice), half, "alice got half back");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), shares - half, "half still in escrow");

        // Reclaim more than remaining should fail
        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.ReclaimExceedsUnclaimed.selector);
        escrow.reclaim(WALLET_HASH, 1, shares); // tries full shares but only half left
    }

    // =======================================================================
    //  P1: Double registration reverts
    // =======================================================================

    function testE2E_DoubleRegister_Reverts() public {
        vm.prank(deployer);
        escrow.registerWallet(WALLET_HASH, alice);

        // Second registration should fail
        vm.prank(deployer);
        vm.expectRevert(VaultShareEscrow.WalletAlreadyRegistered.selector);
        escrow.registerWallet(WALLET_HASH, alice);

        // Different wallet owner also cannot register same wallet hash
        vm.prank(deployer);
        vm.expectRevert(VaultShareEscrow.WalletAlreadyRegistered.selector);
        escrow.registerWallet(WALLET_HASH, bob);
    }

    // =======================================================================
    //  P1: Deposit sum mismatch reverts
    // =======================================================================

    function testE2E_DepositSumMismatch_Reverts() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);

        vm.prank(deployer);
        escrow.registerWallet(WALLET_HASH, alice);
        vm.prank(alice);
        vault.approve(address(escrow), shares);

        uint256[] memory indices = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        indices[0] = 1;
        indices[1] = 2;
        amounts[0] = shares / 2;
        amounts[1] = shares / 2 - 1; // intentionally 1 short

        vm.prank(alice);
        vm.expectRevert(VaultShareEscrow.AllocationSumMismatch.selector);
        escrow.deposit(WALLET_HASH, shares, indices, amounts);
    }

    // =======================================================================
    //  P1: Escrow deposit preserves vault principal tracking
    // =======================================================================

    function testE2E_PrincipalTracking_ThroughEscrowFlow() public {
        uint256 shares = _aliceDepositsToVault(DEPOSIT_AMOUNT);
        assertEq(vault.userPrincipal(alice), DEPOSIT_AMOUNT, "initial principal");

        // Transfer to escrow should reduce alice's principal
        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = 1;
        amounts[0] = shares;
        _aliceEscrowsShares(WALLET_HASH, shares, indices, amounts);

        assertEq(vault.userPrincipal(alice), 0, "principal = 0 after escrow");
        assertEq(vault.balanceOf(alice), 0, "shares = 0 after escrow");

        // Escrow contract should hold the shares
        assertEq(vault.balanceOf(address(escrow)), shares, "escrow holds all shares");
    }
}
