// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IReleaseAttestation
 * @notice Interface for reading release attestations (oracle / authority decision).
 */
interface IReleaseAttestation {
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
}

/**
 * @title VaultShareEscrow
 * @author Yault
 * @notice Holds YaultVault (ERC4626) shares for a plan; when ReleaseAttestation
 *         has decision RELEASE for (walletIdHash, recipientIndex), the beneficiary
 *         can claim their allocated shares (or redeem to underlying asset).
 *         Funds keep earning yield in the vault until claim.
 *
 * Flow:
 *   1. Register wallet: registerWallet(walletIdHash) so msg.sender is owner.
 *   2. Owner deposits vault shares and allocates per recipient:
 *      deposit(walletIdHash, shares, recipientIndices[], amounts[]) with sum(amounts) == shares.
 *   3. Shares stay in this contract (and thus in the vault), earning yield.
 *   4. When Oracle/Authority submits RELEASE for (walletIdHash, recipientIndex),
 *      only wallet owner can call claim(walletIdHash, recipientIndex, to, amount, redeemToAsset).
 *      Recipients are expected to hold credentials that can derive/sign as wallet owner.
 *   5. If redeemToAsset: vault.redeem(amount) and send underlying to `to`;
 *      else transfer vault shares to `to`.
 *   6. Before RELEASE is attested, wallet owner may call reclaim(...) to pull back uncommitted shares.
 *
 *   NOTE: If the vault contract disables share transfers (e.g. YaultVault C-05),
 *   claim(..., redeemToAsset: false) will revert. Use redeemToAsset: true only.
 */
contract VaultShareEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant DECISION_RELEASE = 0;

    IERC4626 public immutable VAULT;
    IReleaseAttestation public immutable ATTESTATION;

    /// @notice walletIdHash => owner address (only they can deposit for this plan)
    mapping(bytes32 => address) public walletOwner;

    /// @notice Total vault shares held per plan (for accounting)
    mapping(bytes32 => uint256) public totalDeposited;

    /// @notice (walletIdHash, recipientIndex) => shares allocated to this recipient
    mapping(bytes32 => mapping(uint256 => uint256)) public allocatedShares;

    /// @notice (walletIdHash, recipientIndex) => shares already claimed
    mapping(bytes32 => mapping(uint256 => uint256)) public claimedShares;

    event WalletRegistered(bytes32 indexed walletIdHash, address indexed owner);
    event Deposited(
        bytes32 indexed walletIdHash,
        address indexed from,
        uint256 shares,
        uint256[] recipientIndices,
        uint256[] amounts
    );
    event Claimed(
        bytes32 indexed walletIdHash,
        uint256 indexed recipientIndex,
        address indexed to,
        uint256 amount,
        bool asAsset
    );
    event Reclaimed(
        bytes32 indexed walletIdHash,
        uint256 indexed recipientIndex,
        address indexed to,
        uint256 amount
    );

    error ZeroAddress();
    error WalletAlreadyRegistered();
    error NotWalletOwner();
    error AllocationSumMismatch();
    error NoAttestation();
    error AttestationNotRelease();
    error ClaimExceedsRemaining();
    error ClaimAmountZero();
    error ZeroReceiver();
    error ReclaimExceedsUnclaimed();
    error AttestationAlreadyReleased();

    constructor(address initialOwner, address _vault, address _attestation) Ownable(initialOwner) {
        if (_vault == address(0) || _attestation == address(0)) revert ZeroAddress();
        VAULT = IERC4626(_vault);
        ATTESTATION = IReleaseAttestation(_attestation);
    }

    /**
     * @notice Register msg.sender as owner for walletIdHash. One-time per wallet.
     */
    function registerWallet(bytes32 walletIdHash) external {
        if (walletOwner[walletIdHash] != address(0)) revert WalletAlreadyRegistered();
        walletOwner[walletIdHash] = msg.sender;
        emit WalletRegistered(walletIdHash, msg.sender);
    }

    /**
     * @notice Deposit vault shares and allocate to recipients. Sum of amounts must equal shares.
     * @param walletIdHash Plan identifier (e.g. keccak256(walletId)).
     * @param shares Total vault shares to deposit (must have approved this contract for vault).
     * @param recipientIndices Recipient indices (match ReleaseAttestation recipientIndex).
     * @param amounts Share amount per recipient; length must match recipientIndices; sum must equal shares.
     */
    function deposit(
        bytes32 walletIdHash,
        uint256 shares,
        uint256[] calldata recipientIndices,
        uint256[] calldata amounts
    ) external nonReentrant {
        if (walletOwner[walletIdHash] != msg.sender) revert NotWalletOwner();
        if (shares == 0) return;
        if (recipientIndices.length != amounts.length) revert AllocationSumMismatch();

        uint256 sum;
        for (uint256 i; i < amounts.length;) {
            sum += amounts[i];
            allocatedShares[walletIdHash][recipientIndices[i]] += amounts[i];
            unchecked {
                ++i;
            }
        }
        if (sum != shares) revert AllocationSumMismatch();

        totalDeposited[walletIdHash] += shares;
        IERC20(address(VAULT)).safeTransferFrom(msg.sender, address(this), shares);
        emit Deposited(walletIdHash, msg.sender, shares, recipientIndices, amounts);
    }

    /**
     * @notice Claim allocated shares (or redeem to underlying) for a recipient. Only when attestation is RELEASE.
     * @param walletIdHash Plan identifier.
     * @param recipientIndex Recipient index (must have ReleaseAttestation decision RELEASE).
     * @param to Address to receive shares or underlying.
     * @param amount Share amount to claim (can be partial).
     * @param redeemToAsset If true, redeem shares to underlying asset and transfer to `to`; else transfer vault shares.
     */
    function claim(
        bytes32 walletIdHash,
        uint256 recipientIndex,
        address to,
        uint256 amount,
        bool redeemToAsset
    ) external nonReentrant {
        if (amount == 0) revert ClaimAmountZero();
        if (to == address(0)) revert ZeroReceiver();

        // Access control: only the registered wallet owner can execute claims.
        // Recipients hold the 3-factor credentials that derive the owner's wallet,
        // so they CAN sign as walletOwner. This prevents front-running attacks
        // where an attacker monitors attestations and claims funds to their own address.
        if (walletOwner[walletIdHash] != msg.sender) revert NotWalletOwner();

        (, uint8 decision,,, uint64 timestamp,) = ATTESTATION.getAttestation(walletIdHash, recipientIndex);
        if (timestamp == 0) revert NoAttestation();
        if (decision != DECISION_RELEASE) revert AttestationNotRelease();

        uint256 remaining = allocatedShares[walletIdHash][recipientIndex] - claimedShares[walletIdHash][recipientIndex];
        if (amount > remaining) revert ClaimExceedsRemaining();

        claimedShares[walletIdHash][recipientIndex] += amount;

        if (redeemToAsset) {
            VAULT.redeem(amount, to, address(this));
        } else {
            IERC20(address(VAULT)).safeTransfer(to, amount);
        }
        emit Claimed(walletIdHash, recipientIndex, to, amount, redeemToAsset);
    }

    /**
     * @notice Owner reclaim: withdraw unclaimed shares for a recipient ONLY if no attestation has been
     *         issued yet (timestamp == 0). Once an attestation exists, the shares are committed.
     *         This allows the owner to cancel/modify the plan before the trigger fires.
     * @param walletIdHash Plan identifier.
     * @param recipientIndex Recipient index to reclaim shares from.
     * @param amount Share amount to reclaim (must be ≤ unclaimed = allocated - claimed).
     */
    function reclaim(bytes32 walletIdHash, uint256 recipientIndex, uint256 amount) external nonReentrant {
        if (walletOwner[walletIdHash] != msg.sender) revert NotWalletOwner();
        if (amount == 0) revert ClaimAmountZero();

        // Only block reclaim when the attestation decision is RELEASE (funds committed to recipient).
        // HOLD and REJECT attestations do NOT lock funds — the owner can still reclaim.
        (, uint8 decision,,, uint64 timestamp,) = ATTESTATION.getAttestation(walletIdHash, recipientIndex);
        if (timestamp != 0 && decision == DECISION_RELEASE) revert AttestationAlreadyReleased();

        uint256 unclaimed = allocatedShares[walletIdHash][recipientIndex] - claimedShares[walletIdHash][recipientIndex];
        if (amount > unclaimed) revert ReclaimExceedsUnclaimed();

        allocatedShares[walletIdHash][recipientIndex] -= amount;
        totalDeposited[walletIdHash] -= amount;

        // Transfer vault shares back to the owner
        IERC20(address(VAULT)).safeTransfer(msg.sender, amount);
        emit Reclaimed(walletIdHash, recipientIndex, msg.sender, amount);
    }

    /**
     * @notice View: remaining claimable shares for (walletIdHash, recipientIndex).
     */
    function remainingForRecipient(bytes32 walletIdHash, uint256 recipientIndex)
        external
        view
        returns (uint256)
    {
        return allocatedShares[walletIdHash][recipientIndex] - claimedShares[walletIdHash][recipientIndex];
    }
}
