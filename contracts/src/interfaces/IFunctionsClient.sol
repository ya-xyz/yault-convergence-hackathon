// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink Functions request structure.
struct FunctionsRequest {
    /// @dev Source code language (0 = JavaScript).
    uint8 codeLanguage;
    /// @dev JavaScript source code to execute.
    string source;
    /// @dev Encrypted secrets reference (DON-hosted).
    bytes encryptedSecretsReference;
    /// @dev Arguments passed to the source code.
    string[] args;
    /// @dev Byte arguments passed to the source code.
    bytes[] bytesArgs;
}

/// @notice Minimal Chainlink Functions Router interface.
interface IFunctionsRouter {
    /// @notice Send a Functions request.
    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId);
}

/// @notice Interface for Chainlink Functions consumer contracts.
interface IFunctionsClient {
    /// @notice Called by the Functions router with the response.
    function handleOracleFulfillment(bytes32 requestId, bytes memory response, bytes memory err) external;
}
