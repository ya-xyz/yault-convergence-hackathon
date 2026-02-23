// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ReleaseAttestation} from "../src/ReleaseAttestation.sol";

contract ReleaseAttestationTest is Test {
    ReleaseAttestation public attestation;

    address public owner;
    address public oracleSubmitter;
    address public fallbackSubmitter;
    address public stranger;

    bytes32 constant WALLET_HASH = keccak256("wallet-1");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    bytes32 constant REASON_CODE = keccak256("verified_death");

    function setUp() public {
        owner = address(this);
        oracleSubmitter = makeAddr("oracle");
        fallbackSubmitter = makeAddr("fallback");
        stranger = makeAddr("stranger");

        attestation = new ReleaseAttestation(owner);
    }

    function test_InitialState() public view {
        assertEq(attestation.oracleSubmitter(), address(0));
        assertFalse(attestation.fallbackSubmitters(fallbackSubmitter));
        ReleaseAttestation.Attestation memory a = attestation.getAttestation(WALLET_HASH, 0);
        assertEq(a.source, 0);
        assertEq(a.decision, 0);
        assertFalse(attestation.hasAttestation(WALLET_HASH, 0));
    }

    function test_SetOracleSubmitter() public {
        attestation.setOracleSubmitter(oracleSubmitter);
        assertEq(attestation.oracleSubmitter(), oracleSubmitter);
    }

    function test_SetFallbackSubmitter() public {
        attestation.setFallbackSubmitter(fallbackSubmitter, true);
        assertTrue(attestation.fallbackSubmitters(fallbackSubmitter));
        attestation.setFallbackSubmitter(fallbackSubmitter, false);
        assertFalse(attestation.fallbackSubmitters(fallbackSubmitter));
    }

    function test_RevertWhen_StrangerSubmitsOracle() public {
        attestation.setOracleSubmitter(oracleSubmitter);
        // Call as address(this); we are not oracle, so submitAttestation reverts.
        // Cache constants so the only call after expectRevert is submitAttestation (not getters).
        uint8 so = attestation.SOURCE_ORACLE();
        uint8 dr = attestation.DECISION_RELEASE();
        vm.expectRevert();
        attestation.submitAttestation(so, WALLET_HASH, 0, dr, REASON_CODE, EVIDENCE_HASH);
    }

    function test_RevertWhen_StrangerSubmitsFallback() public {
        attestation.setFallbackSubmitter(fallbackSubmitter, true);
        // Call as address(this); we are not fallback, so submitAttestation reverts.
        uint8 sf = attestation.SOURCE_FALLBACK();
        uint8 dr = attestation.DECISION_RELEASE();
        vm.expectRevert();
        attestation.submitAttestation(sf, WALLET_HASH, 0, dr, REASON_CODE, EVIDENCE_HASH);
    }

    function test_OracleSubmitsAttestation() public {
        attestation.setOracleSubmitter(oracleSubmitter);
        vm.startPrank(oracleSubmitter);
        attestation.submitAttestation(
            attestation.SOURCE_ORACLE(),
            WALLET_HASH,
            0,
            attestation.DECISION_RELEASE(),
            REASON_CODE,
            EVIDENCE_HASH
        );

        ReleaseAttestation.Attestation memory a = attestation.getAttestation(WALLET_HASH, 0);

        assertEq(a.source, attestation.SOURCE_ORACLE());
        assertEq(a.decision, attestation.DECISION_RELEASE());
        assertEq(a.reasonCode, REASON_CODE);
        assertEq(a.evidenceHash, EVIDENCE_HASH);
        assertGt(a.timestamp, 0);
        assertEq(a.submitter, oracleSubmitter);
        assertTrue(attestation.hasAttestation(WALLET_HASH, 0));
        vm.stopPrank();
    }

    function test_FallbackSubmitsAttestation() public {
        attestation.setFallbackSubmitter(fallbackSubmitter, true);
        vm.startPrank(fallbackSubmitter);
        attestation.submitAttestation(
            attestation.SOURCE_FALLBACK(),
            WALLET_HASH,
            1,
            attestation.DECISION_HOLD(),
            bytes32(0),
            EVIDENCE_HASH
        );

        ReleaseAttestation.Attestation memory a = attestation.getAttestation(WALLET_HASH, 1);
        assertEq(a.source, attestation.SOURCE_FALLBACK());
        assertEq(a.decision, attestation.DECISION_HOLD());
        assertTrue(attestation.hasAttestation(WALLET_HASH, 1));
        vm.stopPrank();
    }

    function test_RevertWhen_InvalidDecision() public {
        attestation.setOracleSubmitter(oracleSubmitter);
        vm.prank(oracleSubmitter);
        try attestation.submitAttestation(
            attestation.SOURCE_ORACLE(),
            WALLET_HASH,
            0,
            3, // invalid decision
            REASON_CODE,
            EVIDENCE_HASH
        ) {
            fail("should have reverted with InvalidDecision");
        } catch (bytes memory reason) {
            assertGt(reason.length, 0, "should revert with some error");
        }
    }

    function test_RevertWhen_InvalidSource() public {
        attestation.setOracleSubmitter(oracleSubmitter);
        vm.prank(oracleSubmitter);
        try attestation.submitAttestation(
            2, // invalid source
            WALLET_HASH,
            0,
            attestation.DECISION_RELEASE(),
            REASON_CODE,
            EVIDENCE_HASH
        ) {
            fail("should have reverted with InvalidSource");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), ReleaseAttestation.InvalidSource.selector);
        }
    }

    // -----------------------------------------------------------------------
    //  P1 FIX: RELEASE is final / immutable
    // -----------------------------------------------------------------------

    function test_ReleaseIsFinal_OracleCannotOverwrite() public {
        attestation.setOracleSubmitter(oracleSubmitter);

        // Oracle submits RELEASE
        uint8 srcO = attestation.SOURCE_ORACLE();
        uint8 decR = attestation.DECISION_RELEASE();
        uint8 decH = attestation.DECISION_HOLD();

        vm.prank(oracleSubmitter);
        attestation.submitAttestation(srcO, WALLET_HASH, 0, decR, REASON_CODE, EVIDENCE_HASH);

        // Verify it's recorded
        ReleaseAttestation.Attestation memory a = attestation.getAttestation(WALLET_HASH, 0);
        assertEq(a.decision, decR, "should be RELEASE");

        // Oracle tries to overwrite RELEASE with HOLD — must revert
        vm.prank(oracleSubmitter);
        vm.expectRevert(ReleaseAttestation.ReleaseIsFinal.selector);
        attestation.submitAttestation(srcO, WALLET_HASH, 0, decH, REASON_CODE, EVIDENCE_HASH);
    }

    function test_ReleaseIsFinal_FallbackCannotOverwrite() public {
        attestation.setFallbackSubmitter(fallbackSubmitter, true);

        // Fallback submits RELEASE
        uint8 srcF = attestation.SOURCE_FALLBACK();
        uint8 decR = attestation.DECISION_RELEASE();
        uint8 decH = attestation.DECISION_HOLD();

        vm.prank(fallbackSubmitter);
        attestation.submitAttestation(srcF, WALLET_HASH, 2, decR, bytes32(0), EVIDENCE_HASH);

        // Fallback tries to overwrite — must revert
        vm.prank(fallbackSubmitter);
        vm.expectRevert(ReleaseAttestation.ReleaseIsFinal.selector);
        attestation.submitAttestation(srcF, WALLET_HASH, 2, decH, bytes32(0), EVIDENCE_HASH);
    }

    function test_HoldCanBeOverwrittenToRelease() public {
        attestation.setOracleSubmitter(oracleSubmitter);

        uint8 srcO = attestation.SOURCE_ORACLE();
        uint8 decH = attestation.DECISION_HOLD();
        uint8 decR = attestation.DECISION_RELEASE();

        // Oracle submits HOLD first
        vm.prank(oracleSubmitter);
        attestation.submitAttestation(srcO, WALLET_HASH, 3, decH, REASON_CODE, EVIDENCE_HASH);

        ReleaseAttestation.Attestation memory a1 = attestation.getAttestation(WALLET_HASH, 3);
        assertEq(a1.decision, decH, "should be HOLD");

        // Oracle overwrites HOLD with RELEASE — should succeed
        vm.prank(oracleSubmitter);
        attestation.submitAttestation(srcO, WALLET_HASH, 3, decR, REASON_CODE, EVIDENCE_HASH);

        ReleaseAttestation.Attestation memory a2 = attestation.getAttestation(WALLET_HASH, 3);
        assertEq(a2.decision, decR, "should now be RELEASE");
    }

    function test_RejectCanBeOverwrittenToRelease() public {
        attestation.setOracleSubmitter(oracleSubmitter);

        uint8 srcO = attestation.SOURCE_ORACLE();
        uint8 decRej = attestation.DECISION_REJECT();
        uint8 decR = attestation.DECISION_RELEASE();

        // Oracle submits REJECT first
        vm.prank(oracleSubmitter);
        attestation.submitAttestation(srcO, WALLET_HASH, 4, decRej, REASON_CODE, EVIDENCE_HASH);

        // Oracle overwrites REJECT with RELEASE — should succeed
        vm.prank(oracleSubmitter);
        attestation.submitAttestation(srcO, WALLET_HASH, 4, decR, REASON_CODE, EVIDENCE_HASH);

        ReleaseAttestation.Attestation memory a = attestation.getAttestation(WALLET_HASH, 4);
        assertEq(a.decision, decR, "should now be RELEASE");
    }
}
