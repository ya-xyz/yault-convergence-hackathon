// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink CCIP message structures (library pattern matching real SDK).
library Client {
    /// @dev EVM-to-any message structure.
    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        bytes extraArgs;
        address feeToken;
    }

    /// @dev Any-to-EVM message structure (received on destination chain).
    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    /// @dev Token amount structure for CCIP.
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    /// @dev SC-L-08 FIX: EVMExtraArgsV1 for proper CCIP extraArgs encoding.
    struct EVMExtraArgsV1 {
        uint256 gasLimit;
    }

    /// @dev 4-byte tag that the CCIP router uses to identify EVMExtraArgsV1.
    bytes4 public constant EVM_EXTRA_ARGS_V1_TAG = 0x97a657c9;

    /// @notice Encode EVMExtraArgsV1 into the bytes format expected by the CCIP router.
    function _argsToBytes(EVMExtraArgsV1 memory extraArgs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EVM_EXTRA_ARGS_V1_TAG, extraArgs);
    }
}

/// @notice Minimal Chainlink CCIP Router interface.
interface IRouterClient {
    /// @notice Check if a destination chain is supported.
    function isChainSupported(uint64 destChainSelector) external view returns (bool);

    /// @notice Get the fee for a CCIP message.
    function getFee(uint64 destChainSelector, Client.EVM2AnyMessage memory message)
        external
        view
        returns (uint256 fee);

    /// @notice Send a CCIP message to a destination chain.
    function ccipSend(uint64 destChainSelector, Client.EVM2AnyMessage calldata message)
        external
        payable
        returns (bytes32 messageId);
}

/// @notice Interface for contracts that receive CCIP messages.
interface CCIPReceiver {
    /// @notice Called by the CCIP router when a message is received.
    function ccipReceive(Client.Any2EVMMessage calldata message) external;
}
