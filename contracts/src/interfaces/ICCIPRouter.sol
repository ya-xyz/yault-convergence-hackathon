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
