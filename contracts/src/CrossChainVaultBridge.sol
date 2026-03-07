// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Client, IRouterClient, CCIPReceiver} from "./interfaces/ICCIPRouter.sol";

/**
 * @title CrossChainVaultBridge
 * @author Yault
 * @notice Chainlink CCIP bridge for cross-chain vault operations.
 *
 * @dev Enables:
 *      1. Cross-chain attestation relay — relay release attestations from one chain to another
 *      2. Cross-chain portfolio sync — sync vault position data across chains
 *      3. Cross-chain deposit — deposit on chain A, receive vault shares on chain B
 *
 *      Message types:
 *      - ATTESTATION_RELAY: Forward a release attestation to a remote chain
 *      - POSITION_SYNC: Broadcast portfolio position data to remote trackers
 *      - DEPOSIT_INTENT: Signal intent to deposit on remote chain
 *
 *      Security:
 *      - Only whitelisted source chains and senders
 *      - Replay protection via nonces
 *      - Rate limiting on message sends
 */
contract CrossChainVaultBridge is Ownable, ReentrancyGuard, CCIPReceiver {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    //  Message Types
    // -----------------------------------------------------------------------

    uint8 public constant MSG_ATTESTATION_RELAY = 1;
    uint8 public constant MSG_POSITION_SYNC = 2;
    uint8 public constant MSG_DEPOSIT_INTENT = 3;

    // -----------------------------------------------------------------------
    //  Types
    // -----------------------------------------------------------------------

    struct CrossChainMessage {
        uint8 msgType;
        bytes32 nonce;
        bytes payload;
    }

    struct AttestationPayload {
        bytes32 walletIdHash;
        uint256 recipientIndex;
        uint8 decision;
        bytes32 evidenceHash;
    }

    struct PositionPayload {
        address user;
        address vault;
        uint256 shares;
        uint256 assetsUnderlying;
        uint256 valueUSD;
        uint256 timestamp;
    }

    struct RemoteChainConfig {
        address remoteBridge;   // Bridge contract on the remote chain
        bool allowed;
        uint256 lastMessageTime;
    }

    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------

    /// @notice Chainlink CCIP Router.
    IRouterClient public immutable ccipRouter;

    /// @notice LINK token for paying CCIP fees (address(0) = pay in native).
    address public linkToken;

    /// @notice Remote chain configurations (chainSelector => config).
    mapping(uint64 => RemoteChainConfig) public remoteChains;

    /// @notice Supported remote chain selectors (for iteration).
    uint64[] public supportedChains;

    /// @notice Processed message nonces (replay protection).
    mapping(bytes32 => bool) public processedNonces;

    /// @notice Monotonic nonce for outgoing messages.
    uint256 public outgoingNonce;

    /// @notice Deployment timestamp for nonce uniqueness across redeployments.
    uint256 public immutable deployedAt;

    /// @notice Minimum interval between messages to the same chain (rate limiting).
    uint256 public minMessageInterval = 60; // 1 minute

    /// @notice Gas limit for CCIP messages.
    uint256 public ccipGasLimit = 200_000;

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------

    event MessageSent(
        bytes32 indexed messageId,
        uint64 indexed destChainSelector,
        uint8 msgType,
        bytes32 nonce
    );
    event MessageReceived(
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        uint8 msgType,
        bytes32 nonce
    );
    event AttestationRelayed(
        bytes32 indexed walletIdHash,
        uint256 recipientIndex,
        uint8 decision,
        uint64 sourceChain
    );
    event PositionSynced(
        address indexed user,
        address indexed vault,
        uint256 valueUSD,
        uint64 sourceChain
    );
    event RemoteChainConfigured(uint64 indexed chainSelector, address remoteBridge, bool allowed);

    // -----------------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error ChainNotSupported(uint64 chainSelector);
    error UnauthorizedSender(uint64 sourceChain, address sender);
    error MessageAlreadyProcessed(bytes32 nonce);
    error RateLimitExceeded(uint64 chainSelector);
    error InvalidMessageType(uint8 msgType);
    error InsufficientFee(uint256 required, uint256 provided);
    error OnlyRouter();
    error ETHTransferFailed();
    error MinIntervalTooLow();

    // -----------------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------------

    constructor(
        address initialOwner,
        address _ccipRouter,
        address _linkToken
    ) Ownable(initialOwner) {
        if (_ccipRouter == address(0)) revert ZeroAddress();
        ccipRouter = IRouterClient(_ccipRouter);
        linkToken = _linkToken;
        deployedAt = block.timestamp;
    }

    // -----------------------------------------------------------------------
    //  Admin: Chain Configuration
    // -----------------------------------------------------------------------

    /// @notice Configure a remote chain for cross-chain messaging.
    function configureRemoteChain(
        uint64 chainSelector,
        address remoteBridge,
        bool allowed
    ) external onlyOwner {
        if (remoteBridge == address(0)) revert ZeroAddress();

        bool wasAllowed = remoteChains[chainSelector].allowed
            && remoteChains[chainSelector].remoteBridge != address(0);

        remoteChains[chainSelector] = RemoteChainConfig({
            remoteBridge: remoteBridge,
            allowed: allowed,
            lastMessageTime: 0
        });

        if (allowed && !wasAllowed) {
            // Add to supportedChains on first enable or re-enable after disable
            supportedChains.push(chainSelector);
        } else if (!allowed && wasAllowed) {
            // SC-M-08 FIX: Remove disabled chain from supportedChains (swap-and-pop)
            for (uint256 i; i < supportedChains.length;) {
                if (supportedChains[i] == chainSelector) {
                    supportedChains[i] = supportedChains[supportedChains.length - 1];
                    supportedChains.pop();
                    break;
                }
                unchecked { ++i; }
            }
        }

        emit RemoteChainConfigured(chainSelector, remoteBridge, allowed);
    }

    /// @notice Update the CCIP gas limit.
    function setCcipGasLimit(uint256 gasLimit) external onlyOwner {
        ccipGasLimit = gasLimit;
    }

    /// @notice Update the minimum message interval (minimum 10 seconds).
    function setMinMessageInterval(uint256 interval) external onlyOwner {
        if (interval < 10) revert MinIntervalTooLow();
        minMessageInterval = interval;
    }

    // -----------------------------------------------------------------------
    //  Send: Attestation Relay
    // -----------------------------------------------------------------------

    /// @notice Relay a release attestation to a remote chain via CCIP.
    function relayAttestation(
        uint64 destChainSelector,
        bytes32 walletIdHash,
        uint256 recipientIndex,
        uint8 decision,
        bytes32 evidenceHash
    ) external onlyOwner nonReentrant returns (bytes32 messageId) {
        _validateDestination(destChainSelector);

        AttestationPayload memory payload = AttestationPayload({
            walletIdHash: walletIdHash,
            recipientIndex: recipientIndex,
            decision: decision,
            evidenceHash: evidenceHash
        });

        bytes32 nonce = _nextNonce();

        CrossChainMessage memory ccMsg = CrossChainMessage({
            msgType: MSG_ATTESTATION_RELAY,
            nonce: nonce,
            payload: abi.encode(payload)
        });

        messageId = _sendCCIPMessage(destChainSelector, abi.encode(ccMsg));
        emit MessageSent(messageId, destChainSelector, MSG_ATTESTATION_RELAY, nonce);
    }

    // -----------------------------------------------------------------------
    //  Send: Position Sync
    // -----------------------------------------------------------------------

    /// @notice Sync a user's vault position to remote chains.
    function syncPosition(
        uint64 destChainSelector,
        address user,
        address vault,
        uint256 valueUSD
    ) external onlyOwner nonReentrant returns (bytes32 messageId) {
        _validateDestination(destChainSelector);

        IERC4626 v = IERC4626(vault);
        uint256 shares = v.balanceOf(user);
        uint256 assets = shares > 0 ? v.convertToAssets(shares) : 0;

        PositionPayload memory payload = PositionPayload({
            user: user,
            vault: vault,
            shares: shares,
            assetsUnderlying: assets,
            valueUSD: valueUSD,
            timestamp: block.timestamp
        });

        bytes32 nonce = _nextNonce();

        CrossChainMessage memory ccMsg = CrossChainMessage({
            msgType: MSG_POSITION_SYNC,
            nonce: nonce,
            payload: abi.encode(payload)
        });

        messageId = _sendCCIPMessage(destChainSelector, abi.encode(ccMsg));
        emit MessageSent(messageId, destChainSelector, MSG_POSITION_SYNC, nonce);
    }

    // -----------------------------------------------------------------------
    //  Receive: CCIP Message Handler
    // -----------------------------------------------------------------------

    /// @notice Called by the CCIP router when a message is received.
    function ccipReceive(Client.Any2EVMMessage calldata message) external override {
        if (msg.sender != address(ccipRouter)) revert OnlyRouter();

        uint64 sourceChain = message.sourceChainSelector;
        address sender = abi.decode(message.sender, (address));

        // Verify the sender is an authorized remote bridge
        RemoteChainConfig storage config = remoteChains[sourceChain];
        if (!config.allowed || config.remoteBridge != sender) {
            revert UnauthorizedSender(sourceChain, sender);
        }

        CrossChainMessage memory ccMsg = abi.decode(message.data, (CrossChainMessage));

        // Replay protection
        if (processedNonces[ccMsg.nonce]) {
            revert MessageAlreadyProcessed(ccMsg.nonce);
        }
        processedNonces[ccMsg.nonce] = true;

        if (ccMsg.msgType == MSG_ATTESTATION_RELAY) {
            _handleAttestationRelay(ccMsg.payload, sourceChain);
        } else if (ccMsg.msgType == MSG_POSITION_SYNC) {
            _handlePositionSync(ccMsg.payload, sourceChain);
        } else {
            revert InvalidMessageType(ccMsg.msgType);
        }

        emit MessageReceived(message.messageId, sourceChain, ccMsg.msgType, ccMsg.nonce);
    }

    // -----------------------------------------------------------------------
    //  View
    // -----------------------------------------------------------------------

    /// @notice Get the fee for sending a CCIP message to a destination chain.
    function getMessageFee(uint64 destChainSelector, bytes calldata data)
        external
        view
        returns (uint256)
    {
        Client.EVM2AnyMessage memory ccipMessage = _buildCCIPMessage(
            destChainSelector, data
        );
        return ccipRouter.getFee(destChainSelector, ccipMessage);
    }

    /// @notice Get all supported chain selectors.
    function getSupportedChains() external view returns (uint64[] memory) {
        return supportedChains;
    }

    // -----------------------------------------------------------------------
    //  Internal
    // -----------------------------------------------------------------------

    function _validateDestination(uint64 destChainSelector) internal {
        RemoteChainConfig storage config = remoteChains[destChainSelector];
        if (!config.allowed) revert ChainNotSupported(destChainSelector);

        // Rate limiting
        if (block.timestamp < config.lastMessageTime + minMessageInterval) {
            revert RateLimitExceeded(destChainSelector);
        }
        config.lastMessageTime = block.timestamp;
    }

    /// @dev SC-M-03 FIX: Include deployedAt to prevent nonce collision across redeployments.
    function _nextNonce() internal returns (bytes32) {
        outgoingNonce++;
        return keccak256(abi.encodePacked(block.chainid, address(this), deployedAt, outgoingNonce));
    }

    function _buildCCIPMessage(uint64 destChainSelector, bytes memory data)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        RemoteChainConfig storage config = remoteChains[destChainSelector];
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);

        return Client.EVM2AnyMessage({
            receiver: abi.encode(config.remoteBridge),
            data: data,
            tokenAmounts: tokenAmounts,
            /// @dev SC-L-08 FIX: Use CCIP-standard extraArgs encoding.
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: ccipGasLimit})),
            feeToken: linkToken
        });
    }

    function _sendCCIPMessage(uint64 destChainSelector, bytes memory data)
        internal
        returns (bytes32)
    {
        Client.EVM2AnyMessage memory ccipMessage = _buildCCIPMessage(
            destChainSelector, data
        );

        uint256 fee = ccipRouter.getFee(destChainSelector, ccipMessage);

        if (linkToken != address(0)) {
            // SC-C-02 FIX: Use forceApprove for safe approval handling
            IERC20(linkToken).forceApprove(address(ccipRouter), fee);
            return ccipRouter.ccipSend(destChainSelector, ccipMessage);
        } else {
            return ccipRouter.ccipSend{value: fee}(destChainSelector, ccipMessage);
        }
    }

    /// @dev SC-H-03 FIX: Store relayed attestations on-chain for downstream consumers.
    mapping(bytes32 => mapping(uint256 => AttestationPayload)) public relayedAttestations;

    function _handleAttestationRelay(bytes memory payload, uint64 sourceChain) internal {
        AttestationPayload memory att = abi.decode(payload, (AttestationPayload));
        // Store the relayed attestation for downstream contracts to query
        relayedAttestations[att.walletIdHash][att.recipientIndex] = att;
        emit AttestationRelayed(
            att.walletIdHash,
            att.recipientIndex,
            att.decision,
            sourceChain
        );
    }

    /// @dev SC-I-06 FIX: Store synced positions on-chain.
    mapping(address => mapping(address => PositionPayload)) public syncedPositions;

    function _handlePositionSync(bytes memory payload, uint64 sourceChain) internal {
        PositionPayload memory pos = abi.decode(payload, (PositionPayload));
        syncedPositions[pos.user][pos.vault] = pos;
        emit PositionSynced(pos.user, pos.vault, pos.valueUSD, sourceChain);
    }

    /// @notice Withdraw stuck ETH from the contract.
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        // SC-L-02 FIX: Use custom error instead of require string
        if (!ok) revert ETHTransferFailed();
    }

    /// @notice Withdraw stuck LINK (or any ERC-20) from the contract.
    /// @dev SC-C-01 FIX: Use safeTransfer for non-standard ERC-20 compatibility.
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Accept native token for CCIP fees.
    receive() external payable {}
}
