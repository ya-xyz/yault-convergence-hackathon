// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ReleaseAttestation
 * @author Yault
 * @notice Stores release attestations from Oracle (primary) and Fallback (entity authority).
 *        Only the configured oracle submitter (e.g. Chainlink CRE Forwarder) can submit
 *        oracle attestations; only whitelisted fallback addresses can submit fallback attestations.
 *        Platform and clients read getAttestation to implement "oracle first, fallback when absent".
 */
contract ReleaseAttestation is Ownable {
    // -----------------------------------------------------------------------
    //  Sources and decisions (match platform ReleaseDecision semantics)
    // -----------------------------------------------------------------------

    uint8 public constant SOURCE_ORACLE = 0;
    uint8 public constant SOURCE_FALLBACK = 1;

    uint8 public constant DECISION_RELEASE = 0;
    uint8 public constant DECISION_HOLD = 1;
    uint8 public constant DECISION_REJECT = 2;

    struct Attestation {
        uint8 source;       // SOURCE_ORACLE | SOURCE_FALLBACK
        uint8 decision;     // DECISION_RELEASE | DECISION_HOLD | DECISION_REJECT
        bytes32 reasonCode; // e.g. keccak256("verified_death") — optional, 0 for none
        bytes32 evidenceHash;
        uint64 timestamp;
        address submitter;
    }

    /// @notice (walletIdHash => (recipientIndex => Attestation))
    mapping(bytes32 => mapping(uint256 => Attestation)) private _attestations;

    /// @notice Address allowed to submit SOURCE_ORACLE attestations (e.g. Chainlink CRE Forwarder).
    address public oracleSubmitter;

    /// @notice Addresses allowed to submit SOURCE_FALLBACK attestations (entity authorities / relayer).
    mapping(address => bool) public fallbackSubmitters;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event AttestationSubmitted(
        bytes32 indexed walletIdHash,
        uint256 indexed recipientIndex,
        uint8 source,
        uint8 decision,
        bytes32 evidenceHash,
        address submitter
    );

    event OracleSubmitterSet(address indexed previous, address indexed current);
    event FallbackSubmitterSet(address indexed submitter, bool allowed);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error OnlyOracleSubmitter();
    error OnlyFallbackSubmitter();
    error InvalidSource();
    error InvalidDecision();
    /// @dev #6 FIX: Thrown when a fallback attestation tries to overwrite an existing oracle attestation.
    error OracleAttestationAlreadyExists();
    /// @dev Thrown when attempting to overwrite a RELEASE attestation (RELEASE is final/immutable).
    error ReleaseIsFinal();

    // -----------------------------------------------------------------------
    //  Constructor & admin
    // -----------------------------------------------------------------------

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Set the address allowed to submit oracle attestations (CRE Forwarder or DON).
    function setOracleSubmitter(address _oracleSubmitter) external onlyOwner {
        // L-01 FIX: Prevent setting oracle submitter to address(0).
        if (_oracleSubmitter == address(0)) revert ZeroAddress();
        address previous = oracleSubmitter;
        oracleSubmitter = _oracleSubmitter;
        emit OracleSubmitterSet(previous, _oracleSubmitter);
    }

    /// @notice Allow or disallow a fallback submitter (entity authority relayer / backend).
    function setFallbackSubmitter(address submitter, bool allowed) external onlyOwner {
        fallbackSubmitters[submitter] = allowed;
        emit FallbackSubmitterSet(submitter, allowed);
    }

    // -----------------------------------------------------------------------
    //  Submit
    // -----------------------------------------------------------------------

    /**
     * @notice Submit an attestation for a (walletIdHash, recipientIndex).
     * @param source SOURCE_ORACLE (0) or SOURCE_FALLBACK (1).
     * @param walletIdHash keccak256(wallet_id) for privacy or wallet_id as bytes32 if short.
     * @param recipientIndex Recipient path index (0-based or 1-based must match platform).
     * @param decision DECISION_RELEASE (0) | DECISION_HOLD (1) | DECISION_REJECT (2).
     * @param reasonCode Optional reason code hash; use bytes32(0) if not used.
     * @param evidenceHash SHA-256 or similar evidence hash (platform convention).
     */
    function submitAttestation(
        uint8 source,
        bytes32 walletIdHash,
        uint256 recipientIndex,
        uint8 decision,
        bytes32 reasonCode,
        bytes32 evidenceHash
    ) external {
        if (source == SOURCE_ORACLE) {
            if (msg.sender != oracleSubmitter) revert OnlyOracleSubmitter();
        } else if (source == SOURCE_FALLBACK) {
            if (!fallbackSubmitters[msg.sender]) revert OnlyFallbackSubmitter();
        } else {
            revert InvalidSource();
        }
        if (decision > DECISION_REJECT) revert InvalidDecision();

        Attestation memory existing = _attestations[walletIdHash][recipientIndex];

        // RELEASE is final: once a RELEASE attestation is recorded for a
        // (walletIdHash, recipientIndex), no source may overwrite it.
        // This ensures recipients' committed funds cannot be clawed back
        // by a subsequent HOLD/REJECT that would re-enable reclaim().
        if (existing.timestamp != 0 && existing.decision == DECISION_RELEASE) {
            revert ReleaseIsFinal();
        }

        // #6 FIX: Prevent fallback attestations from overwriting oracle attestations.
        // Oracle attestations take precedence; once set, only another oracle can update.
        if (source == SOURCE_FALLBACK) {
            if (existing.timestamp != 0 && existing.source == SOURCE_ORACLE) {
                revert OracleAttestationAlreadyExists();
            }
        }

        _attestations[walletIdHash][recipientIndex] = Attestation({
            source: source,
            decision: decision,
            reasonCode: reasonCode,
            evidenceHash: evidenceHash,
            timestamp: uint64(block.timestamp),
            submitter: msg.sender
        });

        emit AttestationSubmitted(walletIdHash, recipientIndex, source, decision, evidenceHash, msg.sender);
    }

    // -----------------------------------------------------------------------
    //  View
    // -----------------------------------------------------------------------

    /**
     * @notice Get the latest attestation for (walletIdHash, recipientIndex).
     * @dev #SUGGESTION: Return the struct directly for better readability and extensibility.
     * @return attestation The Attestation struct.
     */
    function getAttestation(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (Attestation memory attestation)
    {
        return _attestations[walletIdHash][recipientIndex];
    }

    /// @notice Check if an attestation exists (any source).
    function hasAttestation(bytes32 walletIdHash, uint256 recipientIndex) external view returns (bool) {
        return _attestations[walletIdHash][recipientIndex].timestamp != 0;
    }
}
