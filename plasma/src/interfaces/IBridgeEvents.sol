// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IBridgeEvents
/// @notice All events emitted by CantonBridge and TokenRegistry.
interface IBridgeEvents {
    // ─── token registry ───────────────────────────────────────────────────────
    event TokenRegistered(address indexed token, string symbol, string cip56Id);
    event TokenDeregistered(address indexed token);

    // ─── bridge lifecycle ─────────────────────────────────────────────────────
    event BridgePaused(address indexed by);
    event BridgeUnpaused(address indexed by);

    // ─── access control ───────────────────────────────────────────────────────
    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);

    // ─── deposit (EVM → Canton) ───────────────────────────────────────────────
    /// @param token     EVM token address
    /// @param user      depositing address
    /// @param amount    raw token amount (in token decimals)
    /// @param fingerprint  bytes32 fingerprint of the Canton recipient party
    /// @param nonce     per-(user, token) deposit counter
    event DepositToCanton(
        address indexed token,
        address indexed user,
        uint256 amount,
        bytes32 indexed fingerprint,
        uint256 nonce
    );

    // ─── withdrawal (Canton → EVM) ────────────────────────────────────────────
    event WithdrawalProcessed(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        bytes32 indexed withdrawalId
    );

    /// @notice Large withdrawal queued behind a time lock.
    event TimeLockQueued(bytes32 indexed withdrawalId, uint256 executeAfter);

    /// @notice Time-locked withdrawal released.
    event TimeLockExecuted(bytes32 indexed withdrawalId);

    // ─── security config ──────────────────────────────────────────────────────
    event RateLimitSet(address indexed token, uint256 maxAmount, uint256 period);
    event TimeLockThresholdSet(address indexed token, uint256 threshold, uint256 delay);

    // ─── emergency ────────────────────────────────────────────────────────────
    event EmergencyWithdrawal(address indexed token, address indexed to, uint256 amount);
}
