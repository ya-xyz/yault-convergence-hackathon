// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title IReleaseAttestation
 * @notice Minimal interface for reading and submitting attestations.
 */
interface IReleaseAttestationFull {
    function getAttestation(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (
            uint8 source,
            uint8 decision,
            bytes32 reasonCode,
            bytes32 evidenceHash,
            uint64 timestamp,
            address submitter
        );

    function submitAttestation(
        uint8 source,
        bytes32 walletIdHash,
        uint256 recipientIndex,
        uint8 decision,
        bytes32 reasonCode,
        bytes32 evidenceHash
    ) external;
}

/**
 * @title IVaultShareEscrow
 * @notice Minimal interface for reclaim operations on VaultShareEscrow.
 */
interface IVaultShareEscrow {
    function remainingForRecipient(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (uint256);

    function reclaimFor(
        bytes32 walletIdHash,
        uint256 recipientIndex,
        uint256 amount,
        address walletAddr
    ) external;
}

/**
 * @title AdminFactorVault
 * @author Yault
 * @notice Stores encrypted AdminFactors on-chain, separate from the credential NFT.
 *         Plan owners can destroy an AF before RELEASE attestation, which atomically
 *         submits a REJECT attestation to prevent a future RELEASE from locking funds.
 *
 * Security model:
 *   - AF is encrypted client-side with recipient's x25519 public key (ECIES).
 *     Only the recipient can decrypt. The ciphertext is public on-chain but useless
 *     without the recipient's private key.
 *   - Plan owner (msg.sender on store()) is the only address that can destroy().
 *   - destroy() checks ReleaseAttestation: if RELEASE already exists, revert.
 *     Otherwise, submit REJECT via fallback source to lock the attestation slot,
 *     then zero out the encrypted data.
 *   - After destroy(), owner can safely call VaultShareEscrow.reclaim() since the
 *     attestation is REJECT (not RELEASE).
 *
 * Storage key: keccak256(walletIdHash, recipientIndex) — deterministic, no PII.
 *
 * Flow:
 *   1. Plan creation: owner calls store(walletIdHash, index, ciphertext, fingerprint).
 *   2. Normal claim:  recipient calls retrieve() to get ciphertext, decrypts off-chain
 *                     with x25519 private key, uses AF as third factor for claim.
 *   3. Revocation:    owner calls destroyAndReclaim() — REJECT attestation submitted,
 *                     AF zeroed, and escrow shares reclaimed atomically in one tx.
 *
 * NOTE: This contract must be registered as a fallbackSubmitter on ReleaseAttestation
 *       for the destroy-with-REJECT flow to work.
 */
contract AdminFactorVault is Ownable {
    uint8 public constant SOURCE_FALLBACK = 1;
    uint8 public constant DECISION_RELEASE = 0;
    uint8 public constant DECISION_REJECT = 2;

    /// @notice Reason code emitted when AF is destroyed by plan owner.
    bytes32 public constant REASON_AF_DESTROYED = keccak256("AF_DESTROYED");

    IReleaseAttestationFull public immutable ATTESTATION;
    IVaultShareEscrow public immutable ESCROW;

    struct EncryptedAF {
        bytes ciphertext;       // ECIES(xidentity, AF): ephemeral_pub || nonce || ciphertext+tag (~92 bytes)
        bytes32 fingerprint;    // SHA-256(AF) for verification
        address owner;          // plan owner — only address that can destroy
    }

    /// @notice key = keccak256(walletIdHash, recipientIndex) => EncryptedAF
    mapping(bytes32 => EncryptedAF) private _vault;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event AdminFactorStored(
        bytes32 indexed walletIdHash,
        uint256 indexed recipientIndex,
        bytes32 fingerprint,
        address indexed owner
    );

    event AdminFactorDestroyed(
        bytes32 indexed walletIdHash,
        uint256 indexed recipientIndex,
        address indexed owner
    );

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error CiphertextEmpty();
    error AlreadyStored();
    error NotStored();
    error NotAFOwner();
    error ReleaseAlreadyAttested();
    error AlreadyDestroyed();

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor(address initialOwner, address _attestation, address _escrow) Ownable(initialOwner) {
        ATTESTATION = IReleaseAttestationFull(_attestation);
        ESCROW = IVaultShareEscrow(_escrow);
    }

    // -----------------------------------------------------------------------
    //  Core functions
    // -----------------------------------------------------------------------

    /**
     * @notice Store an encrypted AdminFactor for a (walletIdHash, recipientIndex) pair.
     *         Caller becomes the AF owner (only they can destroy it later).
     *
     * @param walletIdHash  Plan/wallet identifier hash.
     * @param recipientIndex Recipient path index (matches ReleaseAttestation).
     * @param ciphertext     ECIES-encrypted AF (encrypted with recipient's x25519 pubkey).
     * @param fingerprint    SHA-256(plaintext AF) for on-chain verification.
     */
    function store(
        bytes32 walletIdHash,
        uint256 recipientIndex,
        bytes calldata ciphertext,
        bytes32 fingerprint
    ) external {
        if (ciphertext.length == 0) revert CiphertextEmpty();

        bytes32 key = _key(walletIdHash, recipientIndex);
        if (_vault[key].owner != address(0)) revert AlreadyStored();

        _vault[key] = EncryptedAF({
            ciphertext: ciphertext,
            fingerprint: fingerprint,
            owner: msg.sender
        });

        emit AdminFactorStored(walletIdHash, recipientIndex, fingerprint, msg.sender);
    }

    /**
     * @notice Destroy an encrypted AdminFactor. Only callable by the AF owner.
     *
     *         If no RELEASE attestation exists for this (walletIdHash, recipientIndex),
     *         this function atomically submits a REJECT attestation to prevent any future
     *         RELEASE, then zeros the encrypted data.
     *
     *         If RELEASE attestation already exists, reverts (commitment is final).
     *
     *         After destroy(), the plan owner can safely call VaultShareEscrow.reclaim()
     *         or YaultPathClaim equivalent since the attestation is REJECT.
     *
     * @param walletIdHash   Plan/wallet identifier hash.
     * @param recipientIndex Recipient path index.
     */
    function destroy(bytes32 walletIdHash, uint256 recipientIndex) external {
        bytes32 key = _key(walletIdHash, recipientIndex);
        EncryptedAF storage entry = _vault[key];

        if (entry.owner == address(0)) revert NotStored();
        if (entry.owner != msg.sender) revert NotAFOwner();
        if (entry.ciphertext.length == 0) revert AlreadyDestroyed();

        // Check attestation status — RELEASE is final, cannot destroy after RELEASE.
        (, uint8 decision,,, uint64 timestamp,) =
            ATTESTATION.getAttestation(walletIdHash, recipientIndex);

        if (timestamp != 0 && decision == DECISION_RELEASE) {
            revert ReleaseAlreadyAttested();
        }

        // Submit REJECT attestation to lock the slot (prevent future RELEASE).
        // Only attempt if no attestation exists yet or current is not already REJECT.
        // This call will revert if this contract is not a registered fallbackSubmitter,
        // which is the expected configuration.
        if (timestamp == 0 || decision != DECISION_REJECT) {
            ATTESTATION.submitAttestation(
                SOURCE_FALLBACK,
                walletIdHash,
                recipientIndex,
                DECISION_REJECT,
                REASON_AF_DESTROYED,
                bytes32(0)
            );
        }

        // Zero out the encrypted data (true deletion from storage).
        delete _vault[key].ciphertext;
        // Keep owner and fingerprint for audit trail; mark as destroyed by empty ciphertext.

        emit AdminFactorDestroyed(walletIdHash, recipientIndex, msg.sender);
    }

    /**
     * @notice Destroy AF and reclaim escrow shares in a single transaction.
     *         Atomically: submit REJECT attestation → zero ciphertext → reclaim shares.
     *         Owner signs once instead of twice.
     *
     * @param walletIdHash   Plan/wallet identifier hash.
     * @param recipientIndex Recipient path index.
     */
    function destroyAndReclaim(bytes32 walletIdHash, uint256 recipientIndex) external {
        bytes32 key = _key(walletIdHash, recipientIndex);
        EncryptedAF storage entry = _vault[key];

        if (entry.owner == address(0)) revert NotStored();
        if (entry.owner != msg.sender) revert NotAFOwner();
        if (entry.ciphertext.length == 0) revert AlreadyDestroyed();

        // Check attestation status — RELEASE is final, cannot destroy after RELEASE.
        (, uint8 decision,,, uint64 timestamp,) =
            ATTESTATION.getAttestation(walletIdHash, recipientIndex);

        if (timestamp != 0 && decision == DECISION_RELEASE) {
            revert ReleaseAlreadyAttested();
        }

        // Submit REJECT attestation to lock the slot (prevent future RELEASE).
        if (timestamp == 0 || decision != DECISION_REJECT) {
            ATTESTATION.submitAttestation(
                SOURCE_FALLBACK,
                walletIdHash,
                recipientIndex,
                DECISION_REJECT,
                REASON_AF_DESTROYED,
                bytes32(0)
            );
        }

        // Zero out the encrypted data.
        delete _vault[key].ciphertext;

        emit AdminFactorDestroyed(walletIdHash, recipientIndex, msg.sender);

        // Reclaim escrow shares back to the owner in the same tx.
        uint256 remaining = ESCROW.remainingForRecipient(walletIdHash, recipientIndex);
        if (remaining > 0) {
            ESCROW.reclaimFor(walletIdHash, recipientIndex, remaining, msg.sender);
        }
    }

    /**
     * @notice Retrieve the encrypted AdminFactor for a (walletIdHash, recipientIndex).
     *         Anyone can call this — the ciphertext is encrypted with the recipient's
     *         x25519 public key and is useless without the corresponding private key.
     *
     * @param walletIdHash   Plan/wallet identifier hash.
     * @param recipientIndex Recipient path index.
     * @return ciphertext    The ECIES-encrypted AF (empty if destroyed).
     * @return fingerprint   SHA-256(plaintext AF).
     * @return owner         The plan owner address.
     */
    function retrieve(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (bytes memory ciphertext, bytes32 fingerprint, address owner)
    {
        bytes32 key = _key(walletIdHash, recipientIndex);
        EncryptedAF storage entry = _vault[key];
        return (entry.ciphertext, entry.fingerprint, entry.owner);
    }

    /**
     * @notice Check if an AF exists and has not been destroyed.
     */
    function isActive(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (bool)
    {
        bytes32 key = _key(walletIdHash, recipientIndex);
        return _vault[key].owner != address(0) && _vault[key].ciphertext.length > 0;
    }

    // -----------------------------------------------------------------------
    //  Internal
    // -----------------------------------------------------------------------

    function _key(bytes32 walletIdHash, uint256 recipientIndex)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(walletIdHash, recipientIndex));
    }
}
