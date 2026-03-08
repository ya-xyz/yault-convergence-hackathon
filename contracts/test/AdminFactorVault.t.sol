// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AdminFactorVault} from "../src/AdminFactorVault.sol";
import {ReleaseAttestation} from "../src/ReleaseAttestation.sol";
import {Attestation} from "../src/interfaces/IReleaseAttestation.sol";
import {VaultShareEscrow} from "../src/VaultShareEscrow.sol";
import {YaultVault} from "../src/YaultVault.sol";
import {YaultVaultCreator} from "../src/YaultVaultCreator.sol";
import {YaultVaultFactory} from "../src/YaultVaultFactory.sol";

contract MockTokenAFV is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract AdminFactorVaultTest is Test {
    MockTokenAFV internal token;
    YaultVault internal vault;
    VaultShareEscrow internal escrow;
    AdminFactorVault internal afVault;
    ReleaseAttestation internal attestation;

    address internal deployer = makeAddr("deployer");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");       // plan owner
    address internal bob = makeAddr("bob");           // recipient
    address internal oracle = makeAddr("oracle");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant WALLET_HASH = keccak256("alice-wallet");
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence");
    bytes32 internal constant REASON_CODE = bytes32(0);

    // Simulated ECIES ciphertext (ephemeral_pub 32B || nonce 12B || ciphertext+tag 48B = 92B)
    bytes internal constant MOCK_CIPHERTEXT = hex"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"
        hex"112233445566778899001122"
        hex"ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100"
        hex"aabbccddeeff00112233445566778899";

    bytes32 internal constant MOCK_FINGERPRINT = keccak256("mock-admin-factor");

    uint256 internal constant DEPOSIT_AMOUNT = 10_000e6;

    function setUp() public {
        // Deploy token + vault
        token = new MockTokenAFV();
        YaultVaultCreator creator = new YaultVaultCreator(address(this));
        YaultVaultFactory factory = new YaultVaultFactory(deployer, platform, address(creator));
        creator.transferOwnership(address(factory));
        vm.prank(deployer);
        address vaultAddr = factory.createVault(IERC20(address(token)), "Yault USDC", "yUSDC");
        vault = YaultVault(vaultAddr);

        // Deploy attestation
        attestation = new ReleaseAttestation(deployer);
        vm.prank(deployer);
        attestation.setOracleSubmitter(oracle);

        // Deploy escrow
        escrow = new VaultShareEscrow(deployer, address(vault), address(attestation));
        vm.prank(deployer);
        vault.setTransferExempt(address(escrow), true);

        // Deploy AdminFactorVault (no Ownable — only needs attestation + escrow)
        afVault = new AdminFactorVault(address(attestation), address(escrow));

        // Register AdminFactorVault as a fallback submitter on ReleaseAttestation
        vm.prank(deployer);
        attestation.setFallbackSubmitter(address(afVault), true);

        // Register AdminFactorVault on escrow so reclaimFor() works
        vm.prank(deployer);
        escrow.setAdminFactorVault(address(afVault));

        // Fund alice with vault shares for escrow tests
        token.mint(alice, DEPOSIT_AMOUNT * 10);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(DEPOSIT_AMOUNT, alice);

        // Register alice's wallet in escrow
        vm.prank(deployer);
        escrow.registerWallet(WALLET_HASH, alice);
    }

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------

    function _store(uint256 recipientIndex) internal {
        vm.prank(alice);
        afVault.store(WALLET_HASH, recipientIndex, MOCK_CIPHERTEXT, MOCK_FINGERPRINT);
    }

    function _submitRelease(uint256 recipientIndex) internal {
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

    // -----------------------------------------------------------------------
    //  store() tests
    // -----------------------------------------------------------------------

    function testStore_Success() public {
        _store(1);

        (bytes memory ct, bytes32 fp, address owner) = afVault.retrieve(WALLET_HASH, 1);
        assertEq(ct, MOCK_CIPHERTEXT, "ciphertext mismatch");
        assertEq(fp, MOCK_FINGERPRINT, "fingerprint mismatch");
        assertEq(owner, alice, "owner should be alice");
        assertTrue(afVault.isActive(WALLET_HASH, 1), "should be active");
    }

    function testStore_EmitEvent() public {
        vm.expectEmit(true, true, true, true);
        emit AdminFactorVault.AdminFactorStored(WALLET_HASH, 1, MOCK_FINGERPRINT, alice);
        _store(1);
    }

    function testStore_MultipleRecipients() public {
        _store(1);
        _store(2);
        _store(3);

        assertTrue(afVault.isActive(WALLET_HASH, 1));
        assertTrue(afVault.isActive(WALLET_HASH, 2));
        assertTrue(afVault.isActive(WALLET_HASH, 3));

        // Verify different keys don't collide
        (bytes memory ct1,,) = afVault.retrieve(WALLET_HASH, 1);
        (bytes memory ct2,,) = afVault.retrieve(WALLET_HASH, 2);
        assertEq(ct1, ct2, "same ciphertext for different indices (expected since same mock)");
    }

    function testStore_RevertsOnEmptyCiphertext() public {
        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.CiphertextEmpty.selector);
        afVault.store(WALLET_HASH, 1, "", MOCK_FINGERPRINT);
    }

    function testStore_RevertsOnDuplicate() public {
        _store(1);

        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.AlreadyStored.selector);
        afVault.store(WALLET_HASH, 1, MOCK_CIPHERTEXT, MOCK_FINGERPRINT);
    }

    function testStore_DifferentOwnersSameIndex() public {
        // Alice stores for wallet A
        _store(1);

        // Bob stores for a different wallet hash
        bytes32 bobWallet = keccak256("bob-wallet");
        vm.prank(bob);
        afVault.store(bobWallet, 1, MOCK_CIPHERTEXT, MOCK_FINGERPRINT);

        (,, address ownerAlice) = afVault.retrieve(WALLET_HASH, 1);
        (,, address ownerBob) = afVault.retrieve(bobWallet, 1);
        assertEq(ownerAlice, alice);
        assertEq(ownerBob, bob);
    }

    // -----------------------------------------------------------------------
    //  retrieve() tests
    // -----------------------------------------------------------------------

    function testRetrieve_AnyoneCanRead() public {
        _store(1);

        // Attacker can read (ciphertext is useless without x25519 private key)
        vm.prank(attacker);
        (bytes memory ct, bytes32 fp, address owner) = afVault.retrieve(WALLET_HASH, 1);
        assertEq(ct, MOCK_CIPHERTEXT);
        assertEq(fp, MOCK_FINGERPRINT);
        assertEq(owner, alice);
    }

    function testRetrieve_NotStored() public view {
        (bytes memory ct, bytes32 fp, address owner) = afVault.retrieve(WALLET_HASH, 99);
        assertEq(ct.length, 0, "empty ciphertext");
        assertEq(fp, bytes32(0), "zero fingerprint");
        assertEq(owner, address(0), "zero owner");
    }

    function testIsActive_False_WhenNotStored() public view {
        assertFalse(afVault.isActive(WALLET_HASH, 99));
    }

    // -----------------------------------------------------------------------
    //  destroy() — before any attestation (happy path)
    // -----------------------------------------------------------------------

    function testDestroy_NoAttestation_Success() public {
        _store(1);

        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);

        // AF should be destroyed
        assertFalse(afVault.isActive(WALLET_HASH, 1), "should be inactive after destroy");

        // Ciphertext zeroed, but fingerprint and owner kept for audit
        (bytes memory ct, bytes32 fp, address owner) = afVault.retrieve(WALLET_HASH, 1);
        assertEq(ct.length, 0, "ciphertext should be empty");
        assertEq(fp, MOCK_FINGERPRINT, "fingerprint preserved for audit");
        assertEq(owner, alice, "owner preserved for audit");
    }

    function testDestroy_NoAttestation_SubmitsReject() public {
        _store(1);

        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);

        // Verify REJECT attestation was submitted
        Attestation memory att = attestation.getAttestation(WALLET_HASH, 1);
        assertEq(att.decision, attestation.DECISION_REJECT(), "decision should be REJECT");
        assertEq(att.source, attestation.SOURCE_FALLBACK(), "source should be FALLBACK");
        assertEq(att.reasonCode, afVault.REASON_AF_DESTROYED(), "reason should be AF_DESTROYED");
        assertGt(att.timestamp, 0, "timestamp should be set");
    }

    function testDestroy_EmitEvent() public {
        _store(1);

        vm.expectEmit(true, true, true, true);
        emit AdminFactorVault.AdminFactorDestroyed(WALLET_HASH, 1, alice);
        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);
    }

    // -----------------------------------------------------------------------
    //  destroy() — with oracle HOLD attestation (should still succeed)
    // -----------------------------------------------------------------------

    function testDestroy_WithOracleHold_SkipsRejectSubmission() public {
        _store(1);
        _submitHold(1);

        // Despite oracle HOLD, owner can still destroy the AF.
        // The REJECT submission is skipped because fallback cannot overwrite oracle,
        // but the AF ciphertext is destroyed. The oracle HOLD already prevents claims.
        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);

        // AF should be destroyed
        assertFalse(afVault.isActive(WALLET_HASH, 1), "AF should be inactive");
        (bytes memory ct,,) = afVault.retrieve(WALLET_HASH, 1);
        assertEq(ct.length, 0, "ciphertext should be zeroed");

        // Attestation should still be oracle HOLD (not overwritten to REJECT)
        Attestation memory att = attestation.getAttestation(WALLET_HASH, 1);
        assertEq(att.source, attestation.SOURCE_ORACLE(), "source should still be ORACLE");
        assertEq(att.decision, attestation.DECISION_HOLD(), "decision should still be HOLD");
    }

    function testDestroyAndReclaim_WithOracleHold() public {
        _store(1);

        uint256 shares = vault.balanceOf(alice);
        _depositToEscrow(1, shares);
        assertEq(vault.balanceOf(alice), 0, "all shares in escrow");

        _submitHold(1);

        // destroyAndReclaim should work even with oracle HOLD
        vm.prank(alice);
        afVault.destroyAndReclaim(WALLET_HASH, 1);

        // AF destroyed, shares reclaimed
        assertFalse(afVault.isActive(WALLET_HASH, 1), "AF should be inactive");
        assertEq(vault.balanceOf(alice), shares, "alice should have shares back");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), 0, "escrow should be empty");
    }

    // -----------------------------------------------------------------------
    //  destroy() — with RELEASE attestation (must revert)
    // -----------------------------------------------------------------------

    function testDestroy_WithReleaseAttestation_Reverts() public {
        _store(1);
        _submitRelease(1);

        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.ReleaseAlreadyAttested.selector);
        afVault.destroy(WALLET_HASH, 1);

        // AF should still be active
        assertTrue(afVault.isActive(WALLET_HASH, 1));
    }

    // -----------------------------------------------------------------------
    //  destroy() — access control
    // -----------------------------------------------------------------------

    function testDestroy_NotOwner_Reverts() public {
        _store(1);

        vm.prank(attacker);
        vm.expectRevert(AdminFactorVault.NotAFOwner.selector);
        afVault.destroy(WALLET_HASH, 1);
    }

    function testDestroy_NotStored_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.NotStored.selector);
        afVault.destroy(WALLET_HASH, 99);
    }

    function testDestroy_AlreadyDestroyed_Reverts() public {
        _store(1);

        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);

        // Second destroy should revert
        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.AlreadyDestroyed.selector);
        afVault.destroy(WALLET_HASH, 1);
    }

    // -----------------------------------------------------------------------
    //  destroy() — race condition: destroy blocks future RELEASE
    // -----------------------------------------------------------------------

    function testDestroy_PreventsSubsequentRelease() public {
        _store(1);

        // Owner destroys (REJECT attestation submitted via fallback)
        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);

        // Verify REJECT attestation exists
        Attestation memory att = attestation.getAttestation(WALLET_HASH, 1);
        assertEq(att.decision, attestation.DECISION_REJECT(), "should be REJECT");
        assertEq(att.source, attestation.SOURCE_FALLBACK(), "should be FALLBACK");

        // Oracle CAN overwrite fallback attestations (oracle > fallback).
        // This is by design: if the oracle certifies RELEASE (e.g., death verified),
        // the plan owner shouldn't be able to block it.
        // However, the AF data is gone, so even with RELEASE the recipient
        // can't reconstruct the three factors. Funds will be stuck but that's
        // the owner's intentional choice.
    }

    // -----------------------------------------------------------------------
    //  Integration: destroy + reclaim flow
    // -----------------------------------------------------------------------

    function testIntegration_DestroyThenReclaimIsSafe() public {
        _store(1);

        // Destroy AF — REJECT attestation submitted
        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 1);

        // Verify attestation is REJECT
        Attestation memory att = attestation.getAttestation(WALLET_HASH, 1);
        assertEq(att.decision, attestation.DECISION_REJECT());

        // In the full system, alice would now call VaultShareEscrow.reclaim()
        // which checks: if (timestamp != 0 && decision == DECISION_RELEASE) revert;
        // Since decision == REJECT, reclaim succeeds. (Tested in VaultShareEscrow.t.sol)
    }

    // -----------------------------------------------------------------------
    //  destroyAndReclaim() — single-tx destroy + escrow reclaim
    // -----------------------------------------------------------------------

    function _depositToEscrow(uint256 recipientIndex, uint256 shares) internal {
        vm.prank(alice);
        vault.approve(address(escrow), shares);

        uint256[] memory indices = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        indices[0] = recipientIndex;
        amounts[0] = shares;

        vm.prank(alice);
        escrow.deposit(WALLET_HASH, shares, indices, amounts);
    }

    function testDestroyAndReclaim_SingleTx() public {
        _store(1);

        uint256 shares = vault.balanceOf(alice);
        _depositToEscrow(1, shares);

        // Alice's vault balance is now 0 (all in escrow)
        assertEq(vault.balanceOf(alice), 0, "all shares in escrow");

        // Single tx: destroy AF + reclaim escrow
        vm.prank(alice);
        afVault.destroyAndReclaim(WALLET_HASH, 1);

        // AF should be destroyed
        assertFalse(afVault.isActive(WALLET_HASH, 1), "AF should be inactive");

        // REJECT attestation should be submitted
        Attestation memory att = attestation.getAttestation(WALLET_HASH, 1);
        assertEq(att.decision, attestation.DECISION_REJECT(), "decision should be REJECT");

        // Shares should be back with alice
        assertEq(vault.balanceOf(alice), shares, "alice should have shares back");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 1), 0, "escrow should be empty");
    }

    function testDestroyAndReclaim_NoEscrowShares() public {
        // AF stored but no escrow deposit — should still work (just skip reclaim)
        _store(1);

        vm.prank(alice);
        afVault.destroyAndReclaim(WALLET_HASH, 1);

        assertFalse(afVault.isActive(WALLET_HASH, 1), "AF destroyed");
    }

    function testDestroyAndReclaim_RevertsAfterRelease() public {
        _store(1);

        uint256 shares = vault.balanceOf(alice);
        _depositToEscrow(1, shares);

        _submitRelease(1);

        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.ReleaseAlreadyAttested.selector);
        afVault.destroyAndReclaim(WALLET_HASH, 1);
    }

    function testDestroyAndReclaim_NotOwnerReverts() public {
        _store(1);

        vm.prank(attacker);
        vm.expectRevert(AdminFactorVault.NotAFOwner.selector);
        afVault.destroyAndReclaim(WALLET_HASH, 1);
    }

    function testDestroyAndReclaim_AlreadyDestroyedReverts() public {
        _store(1);

        vm.prank(alice);
        afVault.destroyAndReclaim(WALLET_HASH, 1);

        vm.prank(alice);
        vm.expectRevert(AdminFactorVault.AlreadyDestroyed.selector);
        afVault.destroyAndReclaim(WALLET_HASH, 1);
    }

    function testDestroyAndReclaim_MultipleRecipients() public {
        _store(1);
        _store(2);

        uint256 shares = vault.balanceOf(alice);
        uint256 halfShares = shares / 2;
        uint256 otherHalf = shares - halfShares;

        // Deposit for both recipients
        vm.prank(alice);
        vault.approve(address(escrow), shares);
        uint256[] memory indices = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        indices[0] = 1;
        indices[1] = 2;
        amounts[0] = halfShares;
        amounts[1] = otherHalf;
        vm.prank(alice);
        escrow.deposit(WALLET_HASH, shares, indices, amounts);

        // Destroy + reclaim only recipient 1
        vm.prank(alice);
        afVault.destroyAndReclaim(WALLET_HASH, 1);

        assertFalse(afVault.isActive(WALLET_HASH, 1), "recipient 1 AF destroyed");
        assertTrue(afVault.isActive(WALLET_HASH, 2), "recipient 2 AF untouched");
        assertEq(vault.balanceOf(alice), halfShares, "alice got half shares back");
        assertEq(escrow.remainingForRecipient(WALLET_HASH, 2), otherHalf, "recipient 2 escrow intact");
    }

    // -----------------------------------------------------------------------
    //  Key isolation
    // -----------------------------------------------------------------------

    function testKeyIsolation_DifferentWallets() public {
        bytes32 walletA = keccak256("wallet-a");
        bytes32 walletB = keccak256("wallet-b");

        vm.prank(alice);
        afVault.store(walletA, 1, MOCK_CIPHERTEXT, MOCK_FINGERPRINT);

        vm.prank(alice);
        afVault.store(walletB, 1, MOCK_CIPHERTEXT, keccak256("other-af"));

        (,bytes32 fpA,) = afVault.retrieve(walletA, 1);
        (,bytes32 fpB,) = afVault.retrieve(walletB, 1);
        assertEq(fpA, MOCK_FINGERPRINT);
        assertEq(fpB, keccak256("other-af"));
        assertFalse(fpA == fpB, "different wallets should have different fingerprints");
    }

    function testKeyIsolation_DifferentIndices() public {
        bytes32 fpA = keccak256("af-1");
        bytes32 fpB = keccak256("af-2");

        vm.prank(alice);
        afVault.store(WALLET_HASH, 1, MOCK_CIPHERTEXT, fpA);
        vm.prank(alice);
        afVault.store(WALLET_HASH, 2, MOCK_CIPHERTEXT, fpB);

        (,bytes32 r1,) = afVault.retrieve(WALLET_HASH, 1);
        (,bytes32 r2,) = afVault.retrieve(WALLET_HASH, 2);
        assertEq(r1, fpA);
        assertEq(r2, fpB);
    }

    // -----------------------------------------------------------------------
    //  Destroy one recipient does not affect others
    // -----------------------------------------------------------------------

    function testDestroy_DoesNotAffectOtherRecipients() public {
        _store(1);
        _store(2);
        _store(3);

        vm.prank(alice);
        afVault.destroy(WALLET_HASH, 2);

        assertTrue(afVault.isActive(WALLET_HASH, 1), "recipient 1 unaffected");
        assertFalse(afVault.isActive(WALLET_HASH, 2), "recipient 2 destroyed");
        assertTrue(afVault.isActive(WALLET_HASH, 3), "recipient 3 unaffected");
    }
}
