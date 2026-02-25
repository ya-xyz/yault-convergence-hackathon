// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
 * @title YaultPathClaim
 * @author Yault
 * @notice Holds assets in a pool per wallet; owner registers paths with a path controller
 *         address and total claimable amount. Recipients claim by submitting a signature
 *         from the path-derived key. Claim is only allowed when ReleaseAttestation has
 *         decision RELEASE for (walletIdHash, pathIndex). Supports partial claims:
 *         each path can claim multiple times up to totalAmount (state in contract).
 *
 * Flow:
 *   1. Register wallet: registerWallet(walletIdHash) so msg.sender is owner for that wallet.
 *   2. Owner deposits: deposit(walletIdHash, amount) — transfers tokens into the contract.
 *   3. Owner registers path: registerPath(walletIdHash, pathIndex, pathControllerAddress, totalAmount).
 *   4. When event triggers, Authority/Oracle submit RELEASE attestation to ReleaseAttestation.
 *   5. Recipient activates path off-chain, signs claim message with path's EVM key, then
 *      anyone calls claim(walletIdHash, pathIndex, amount, to, deadline, v, r, s).
 *   6. Contract checks: attestation decision == RELEASE, signature from pathController, amount <= remaining.
 *   7. Transfer tokens to `to`, increase claimed for that path.
 */
contract YaultPathClaim is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    IReleaseAttestation public immutable attestation;

    uint8 public constant DECISION_RELEASE = 0;

    struct PathInfo {
        address pathController; // EVM address that can sign claims (derived from path when activated)
        uint256 totalAmount;    // Max claimable for this path (can claim in multiple times)
        uint256 claimedAmount; // Already claimed (remaining = totalAmount - claimedAmount)
    }

    /// @notice Wallet owner (only they can deposit and register paths for this wallet)
    mapping(bytes32 => address) public walletOwner;

    /// @notice Total tokens deposited per wallet (pool balance)
    mapping(bytes32 => uint256) public totalDeposited;

    /// @notice Sum of path totalAmounts per wallet (cannot exceed totalDeposited)
    mapping(bytes32 => uint256) public totalAllocated;

    /// @notice (walletIdHash, pathIndex) => PathInfo
    mapping(bytes32 => mapping(uint256 => PathInfo)) public pathInfo;

    /// @notice Nonce per (walletIdHash, pathIndex) for replay protection
    mapping(bytes32 => mapping(uint256 => uint256)) public claimNonce;

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(bytes32 walletIdHash,uint256 pathIndex,uint256 amount,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    event WalletRegistered(bytes32 indexed walletIdHash, address indexed owner);
    event Deposited(bytes32 indexed walletIdHash, address indexed from, uint256 amount);
    event PathRegistered(
        bytes32 indexed walletIdHash,
        uint256 indexed pathIndex,
        address pathController,
        uint256 totalAmount
    );
    event Claimed(
        bytes32 indexed walletIdHash,
        uint256 indexed pathIndex,
        address indexed to,
        uint256 amount
    );

    error ZeroAddress();
    error WalletAlreadyRegistered();
    error NotWalletOwner();
    error InsufficientDeposit();
    error PathAlreadyRegistered();
    error NoAttestation();
    error AttestationNotRelease();
    error PathNotRegistered();
    error InvalidSignature();
    error ClaimExceedsRemaining();
    error ClaimAmountZero();
    error ZeroReceiver();
    error DeadlineExpired();

    constructor(address initialOwner, IERC20 _asset, address _attestation)
        Ownable(initialOwner)
    {
        if (address(_asset) == address(0) || _attestation == address(0)) revert ZeroAddress();
        asset = _asset;
        attestation = IReleaseAttestation(_attestation);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("YaultPathClaim"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
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
     * @notice Deposit tokens into the pool for a wallet. Only wallet owner.
     */
    function deposit(bytes32 walletIdHash, uint256 amount) external nonReentrant {
        if (walletOwner[walletIdHash] != msg.sender) revert NotWalletOwner();
        if (amount == 0) return;
        totalDeposited[walletIdHash] += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(walletIdHash, msg.sender, amount);
    }

    /**
     * @notice Register a path: pathController is the EVM address that will sign claims
     *         (derived when recipient activates the path). totalAmount is the max
     *         claimable for this path (can be claimed in multiple partial claims).
     */
    function registerPath(
        bytes32 walletIdHash,
        uint256 pathIndex,
        address pathController,
        uint256 totalAmount
    ) external {
        if (walletOwner[walletIdHash] != msg.sender) revert NotWalletOwner();
        if (pathController == address(0)) revert ZeroAddress();
        PathInfo storage p = pathInfo[walletIdHash][pathIndex];
        if (p.pathController != address(0)) revert PathAlreadyRegistered();
        if (totalAllocated[walletIdHash] + totalAmount > totalDeposited[walletIdHash]) {
            revert InsufficientDeposit();
        }
        totalAllocated[walletIdHash] += totalAmount;
        p.pathController = pathController;
        p.totalAmount = totalAmount;
        p.claimedAmount = 0;
        emit PathRegistered(walletIdHash, pathIndex, pathController, totalAmount);
    }

    /**
     * @notice Hash of the claim message for EIP-712 signing.
     */
    function getClaimHash(
        bytes32 walletIdHash,
        uint256 pathIndex,
        uint256 amount,
        address to,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        CLAIM_TYPEHASH,
                        walletIdHash,
                        pathIndex,
                        amount,
                        to,
                        nonce,
                        deadline
                    )
                )
            )
        );
    }

    /**
     * @notice Claim tokens to `to`. Signature must be from pathController (path-derived EVM key).
     *         Only allowed when ReleaseAttestation has decision RELEASE for (walletIdHash, pathIndex).
     *         amount is the signed maximum; we transfer min(amount, remaining) so Amount-Bound KDF
     *         is safe with rounding (e.g. nominal 10, remaining 9.999... → transfer 9.999...).
     */
    function claim(
        bytes32 walletIdHash,
        uint256 pathIndex,
        uint256 amount,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (amount == 0) revert ClaimAmountZero();
        if (to == address(0)) revert ZeroReceiver();
        if (block.timestamp > deadline) revert DeadlineExpired();

        (, uint8 decision,,, uint64 timestamp,) = attestation.getAttestation(walletIdHash, pathIndex);
        if (timestamp == 0) revert NoAttestation(); // no attestation submitted yet
        if (decision != DECISION_RELEASE) revert AttestationNotRelease();

        PathInfo storage p = pathInfo[walletIdHash][pathIndex];
        if (p.pathController == address(0)) revert PathNotRegistered();

        uint256 remaining = p.totalAmount - p.claimedAmount;
        uint256 actualTransfer = amount > remaining ? remaining : amount;
        if (actualTransfer == 0) revert ClaimExceedsRemaining();

        uint256 nonce = claimNonce[walletIdHash][pathIndex];
        bytes32 digest = getClaimHash(walletIdHash, pathIndex, amount, to, nonce, deadline);
        address signer = ecrecover(digest, v, r, s);
        if (signer != p.pathController) revert InvalidSignature();

        claimNonce[walletIdHash][pathIndex] = nonce + 1;
        p.claimedAmount += actualTransfer;

        asset.safeTransfer(to, actualTransfer);
        emit Claimed(walletIdHash, pathIndex, to, actualTransfer);
    }

    /**
     * @notice View: remaining claimable for (walletIdHash, pathIndex).
     */
    function remainingForPath(bytes32 walletIdHash, uint256 pathIndex)
        external
        view
        returns (uint256)
    {
        PathInfo storage p = pathInfo[walletIdHash][pathIndex];
        return p.totalAmount - p.claimedAmount;
    }
}
