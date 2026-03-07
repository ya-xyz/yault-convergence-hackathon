// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CrossChainVaultBridge} from "../src/CrossChainVaultBridge.sol";
import {Client} from "../src/interfaces/ICCIPRouter.sol";

/// @dev Mock CCIP Router for testing.
contract MockCCIPRouter {
    uint256 public constant MOCK_FEE = 0.01 ether;
    bytes32 public lastMessageId;
    uint256 private _nonce;

    function getFee(uint64, Client.EVM2AnyMessage memory) external pure returns (uint256) {
        return MOCK_FEE;
    }

    function ccipSend(uint64, Client.EVM2AnyMessage calldata) external payable returns (bytes32) {
        _nonce++;
        lastMessageId = keccak256(abi.encodePacked(_nonce));
        return lastMessageId;
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }
}

/// @dev Mock ERC-4626 vault for syncPosition tests.
contract MockVault4626 {
    mapping(address => uint256) public shares;
    uint256 public totalSupply;

    function setShares(address user, uint256 amount) external {
        shares[user] = amount;
        totalSupply += amount;
    }

    function balanceOf(address user) external view returns (uint256) {
        return shares[user];
    }

    function convertToAssets(uint256 _shares) external pure returns (uint256) {
        // 1:1.1 share-to-asset ratio for testing
        return (_shares * 11) / 10;
    }
}

contract CrossChainVaultBridgeTest is Test {
    CrossChainVaultBridge public bridge;
    MockCCIPRouter public router;
    MockVault4626 public vault;

    address public owner = address(this);
    address public user = address(0xBEEF);
    uint64 public constant DEST_CHAIN = 16015286601757825753; // Sepolia selector
    address public constant REMOTE_BRIDGE = address(0xCAFE);

    function setUp() public {
        // Warp to a realistic timestamp so rate limiting doesn't block initial sends
        vm.warp(1000);

        router = new MockCCIPRouter();
        vault = new MockVault4626();
        bridge = new CrossChainVaultBridge(owner, address(router), address(0));

        // Fund the bridge for native fee payments
        vm.deal(address(bridge), 10 ether);

        // Configure a remote chain
        bridge.configureRemoteChain(DEST_CHAIN, REMOTE_BRIDGE, true);

        // Set up vault shares for user
        vault.setShares(user, 1000e18);
    }

    // -----------------------------------------------------------------------
    //  Configuration Tests
    // -----------------------------------------------------------------------

    function test_configureRemoteChain() public {
        uint64 newChain = 12345;
        bridge.configureRemoteChain(newChain, address(0xDEAD), true);

        (address remoteBridge, bool allowed,) = bridge.remoteChains(newChain);
        assertEq(remoteBridge, address(0xDEAD));
        assertTrue(allowed);
    }

    function test_configureRemoteChain_revert_zeroAddress() public {
        vm.expectRevert(CrossChainVaultBridge.ZeroAddress.selector);
        bridge.configureRemoteChain(12345, address(0), true);
    }

    function test_configureRemoteChain_onlyOwner() public {
        vm.prank(user);
        vm.expectRevert();
        bridge.configureRemoteChain(12345, address(0xDEAD), true);
    }

    function test_setCcipGasLimit() public {
        bridge.setCcipGasLimit(500_000);
        assertEq(bridge.ccipGasLimit(), 500_000);
    }

    function test_setMinMessageInterval() public {
        bridge.setMinMessageInterval(120);
        assertEq(bridge.minMessageInterval(), 120);
    }

    // -----------------------------------------------------------------------
    //  Relay Attestation Tests
    // -----------------------------------------------------------------------

    function test_relayAttestation() public {
        bytes32 walletIdHash = keccak256("wallet123");
        bytes32 evidenceHash = keccak256("evidence");

        bytes32 messageId = bridge.relayAttestation(
            DEST_CHAIN,
            walletIdHash,
            0,
            1, // hold
            evidenceHash
        );

        assertTrue(messageId != bytes32(0));
        assertEq(bridge.outgoingNonce(), 1);
    }

    function test_relayAttestation_onlyOwner() public {
        vm.prank(user);
        vm.expectRevert();
        bridge.relayAttestation(
            DEST_CHAIN,
            keccak256("wallet"),
            0,
            0,
            keccak256("evidence")
        );
    }

    function test_relayAttestation_chainNotSupported() public {
        uint64 unsupported = 99999;
        vm.expectRevert(abi.encodeWithSelector(
            CrossChainVaultBridge.ChainNotSupported.selector, unsupported
        ));
        bridge.relayAttestation(
            unsupported,
            keccak256("wallet"),
            0,
            0,
            keccak256("evidence")
        );
    }

    function test_relayAttestation_rateLimited() public {
        bridge.relayAttestation(
            DEST_CHAIN,
            keccak256("wallet"),
            0,
            0,
            keccak256("evidence")
        );

        // Second call within minMessageInterval should revert
        vm.expectRevert(abi.encodeWithSelector(
            CrossChainVaultBridge.RateLimitExceeded.selector, DEST_CHAIN
        ));
        bridge.relayAttestation(
            DEST_CHAIN,
            keccak256("wallet2"),
            0,
            0,
            keccak256("evidence2")
        );
    }

    function test_relayAttestation_afterInterval() public {
        bridge.relayAttestation(
            DEST_CHAIN,
            keccak256("wallet"),
            0,
            0,
            keccak256("evidence")
        );

        // Advance time past the interval
        vm.warp(block.timestamp + bridge.minMessageInterval() + 1);

        // Should succeed now
        bytes32 messageId = bridge.relayAttestation(
            DEST_CHAIN,
            keccak256("wallet2"),
            0,
            0,
            keccak256("evidence2")
        );
        assertTrue(messageId != bytes32(0));
        assertEq(bridge.outgoingNonce(), 2);
    }

    // -----------------------------------------------------------------------
    //  Sync Position Tests
    // -----------------------------------------------------------------------

    function test_syncPosition() public {
        bytes32 messageId = bridge.syncPosition(
            DEST_CHAIN,
            user,
            address(vault),
            5000e18
        );

        assertTrue(messageId != bytes32(0));
    }

    function test_syncPosition_onlyOwner() public {
        vm.prank(user);
        vm.expectRevert();
        bridge.syncPosition(DEST_CHAIN, user, address(vault), 5000e18);
    }

    // -----------------------------------------------------------------------
    //  Receive: CCIP Message Handler Tests
    // -----------------------------------------------------------------------

    function test_ccipReceive_attestationRelay() public {
        // Build a valid CrossChainMessage
        CrossChainVaultBridge.AttestationPayload memory att = CrossChainVaultBridge.AttestationPayload({
            walletIdHash: keccak256("wallet"),
            recipientIndex: 0,
            decision: 1,
            evidenceHash: keccak256("evidence")
        });

        bytes32 nonce = keccak256("nonce1");
        CrossChainVaultBridge.CrossChainMessage memory ccMsg = CrossChainVaultBridge.CrossChainMessage({
            msgType: bridge.MSG_ATTESTATION_RELAY(),
            nonce: nonce,
            payload: abi.encode(att)
        });

        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: keccak256("msg1"),
            sourceChainSelector: DEST_CHAIN,
            sender: abi.encode(REMOTE_BRIDGE),
            data: abi.encode(ccMsg),
            destTokenAmounts: tokenAmounts
        });

        // Must be called by the router
        vm.prank(address(router));
        bridge.ccipReceive(message);

        assertTrue(bridge.processedNonces(nonce));
    }

    function test_ccipReceive_replayProtection() public {
        bytes32 nonce = keccak256("nonce1");

        CrossChainVaultBridge.AttestationPayload memory att = CrossChainVaultBridge.AttestationPayload({
            walletIdHash: keccak256("wallet"),
            recipientIndex: 0,
            decision: 0,
            evidenceHash: keccak256("evidence")
        });

        CrossChainVaultBridge.CrossChainMessage memory ccMsg = CrossChainVaultBridge.CrossChainMessage({
            msgType: bridge.MSG_ATTESTATION_RELAY(),
            nonce: nonce,
            payload: abi.encode(att)
        });

        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: keccak256("msg1"),
            sourceChainSelector: DEST_CHAIN,
            sender: abi.encode(REMOTE_BRIDGE),
            data: abi.encode(ccMsg),
            destTokenAmounts: tokenAmounts
        });

        vm.prank(address(router));
        bridge.ccipReceive(message);

        // Second call with same nonce should revert
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(
            CrossChainVaultBridge.MessageAlreadyProcessed.selector, nonce
        ));
        bridge.ccipReceive(message);
    }

    function test_ccipReceive_onlyRouter() public {
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: keccak256("msg1"),
            sourceChainSelector: DEST_CHAIN,
            sender: abi.encode(REMOTE_BRIDGE),
            data: "",
            destTokenAmounts: tokenAmounts
        });

        vm.prank(user);
        vm.expectRevert(CrossChainVaultBridge.OnlyRouter.selector);
        bridge.ccipReceive(message);
    }

    function test_ccipReceive_unauthorizedSender() public {
        bytes32 nonce = keccak256("nonce_unauth");
        CrossChainVaultBridge.CrossChainMessage memory ccMsg = CrossChainVaultBridge.CrossChainMessage({
            msgType: 1,
            nonce: nonce,
            payload: ""
        });

        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: keccak256("msg"),
            sourceChainSelector: DEST_CHAIN,
            sender: abi.encode(address(0xBAD)),
            data: abi.encode(ccMsg),
            destTokenAmounts: tokenAmounts
        });

        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(
            CrossChainVaultBridge.UnauthorizedSender.selector, DEST_CHAIN, address(0xBAD)
        ));
        bridge.ccipReceive(message);
    }

    function test_ccipReceive_positionSync() public {
        CrossChainVaultBridge.PositionPayload memory pos = CrossChainVaultBridge.PositionPayload({
            user: user,
            vault: address(vault),
            shares: 1000e18,
            assetsUnderlying: 1100e18,
            valueUSD: 1100e18,
            timestamp: block.timestamp
        });

        bytes32 nonce = keccak256("nonce_pos");
        CrossChainVaultBridge.CrossChainMessage memory ccMsg = CrossChainVaultBridge.CrossChainMessage({
            msgType: bridge.MSG_POSITION_SYNC(),
            nonce: nonce,
            payload: abi.encode(pos)
        });

        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: keccak256("msg_pos"),
            sourceChainSelector: DEST_CHAIN,
            sender: abi.encode(REMOTE_BRIDGE),
            data: abi.encode(ccMsg),
            destTokenAmounts: tokenAmounts
        });

        vm.prank(address(router));
        bridge.ccipReceive(message);

        assertTrue(bridge.processedNonces(nonce));
    }

    function test_ccipReceive_invalidMessageType() public {
        bytes32 nonce = keccak256("nonce_invalid");
        CrossChainVaultBridge.CrossChainMessage memory ccMsg = CrossChainVaultBridge.CrossChainMessage({
            msgType: 99, // invalid
            nonce: nonce,
            payload: ""
        });

        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory message = Client.Any2EVMMessage({
            messageId: keccak256("msg_invalid"),
            sourceChainSelector: DEST_CHAIN,
            sender: abi.encode(REMOTE_BRIDGE),
            data: abi.encode(ccMsg),
            destTokenAmounts: tokenAmounts
        });

        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(
            CrossChainVaultBridge.InvalidMessageType.selector, uint8(99)
        ));
        bridge.ccipReceive(message);
    }

    // -----------------------------------------------------------------------
    //  View Tests
    // -----------------------------------------------------------------------

    function test_getSupportedChains() public view {
        uint64[] memory chains = bridge.getSupportedChains();
        assertEq(chains.length, 1);
        assertEq(chains[0], DEST_CHAIN);
    }

    function test_receiveEther() public {
        uint256 balBefore = address(bridge).balance;
        (bool ok,) = address(bridge).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(bridge).balance, balBefore + 1 ether);
    }
}
