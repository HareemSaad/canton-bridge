// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICantonBridge
/// @notice External interface and custom errors for CantonBridge.
interface ICantonBridge {
    // ─── errors ───────────────────────────────────────────────────────────────
    error UnregisteredToken(address token);
    error InvalidAmount();
    error InvalidFingerprint();
    error DuplicateWithdrawal(bytes32 withdrawalId);
    error InvalidRelayerProof();
    error WithdrawalNotQueued(bytes32 withdrawalId);
    error TimeLockNotExpired(bytes32 withdrawalId, uint256 executeAfter);
    error AlreadyExecuted(bytes32 withdrawalId);

    // ─── deposit ──────────────────────────────────────────────────────────────
    /// @notice Lock ERC-20 tokens on Plasma.  The Canton relayer watches for
    ///         DepositToCanton events and mints the equivalent CIP-56 holding.
    /// @param token       ERC-20 token address (must be registered)
    /// @param amount      raw token amount (caller must have approved this contract)
    /// @param fingerprint bytes32 fingerprint of the Canton recipient party ID
    function depositToCanton(address token, uint256 amount, bytes32 fingerprint) external;

    // ─── withdrawal ───────────────────────────────────────────────────────────
    /// @notice Release ERC-20 tokens back to an EVM address after a Canton burn.
    ///         Caller supplies a relayer ECDSA proof.
    function withdrawFromCanton(
        address token,
        uint256 amount,
        address recipient,
        bytes32 withdrawalId,
        bytes calldata proof
    ) external;

    /// @notice Execute a previously time-locked withdrawal once the delay expires.
    function executeTimeLocked(bytes32 withdrawalId) external;

    // ─── views ────────────────────────────────────────────────────────────────
    function isTokenRegistered(address token) external view returns (bool);
    function getLockedBalance(address token) external view returns (uint256);
    function getUserNonce(address user, address token) external view returns (uint256);
}
