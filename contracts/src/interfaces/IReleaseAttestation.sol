// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IReleaseAttestation
 * @notice Shared interface for reading release attestations (oracle / authority decision).
 *         Used by VaultShareEscrow and YaultPathClaim to check attestation state.
 *         Must match ReleaseAttestation.sol's getAttestation return signature.
 */
/// @dev SC-H-01 FIX: Attestation struct shared between interface and implementation.
struct Attestation {
    uint8 source;
    uint8 decision;
    bytes32 reasonCode;
    bytes32 evidenceHash;
    uint64 timestamp;
    address submitter;
}

interface IReleaseAttestation {
    /// @dev SC-H-01 FIX: Return struct to match ReleaseAttestation implementation.
    function getAttestation(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (Attestation memory attestation);
}
