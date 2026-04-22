// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./TokenRegistry.sol";
import "./security/RateLimiter.sol";
import "./interfaces/ICantonBridge.sol";
import "./interfaces/IBridgeEvents.sol";

/// @title CantonBridge
/// @notice Production-grade one-way (Plasma → Canton) bridge.
///
/// Security features:
///   • Role-based access control (ADMIN, RELAYER, PAUSER)
///   • ReentrancyGuard on all state-changing paths
///   • Pausable for emergency stops
///   • Per-user, per-token deposit nonces (replay protection)
///   • Relayer ECDSA proof required for withdrawals
///   • Withdrawal replay guard (executedWithdrawals mapping)
///   • Per-token rate limiting via RateLimiter
///   • Configurable time-lock for large withdrawals
///   • Emergency withdrawal (admin-only, when paused)
///
/// Deposit flow  : depositToCanton()  → DepositToCanton event → relayer mints CIP-56
/// Withdrawal flow: withdrawFromCanton() with relayer proof → tokens released
contract CantonBridge is
    ICantonBridge,
    IBridgeEvents,
    AccessControl,
    ReentrancyGuard,
    Pausable,
    RateLimiter
{
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    // ─── roles ────────────────────────────────────────────────────────────────
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant PAUSER_ROLE  = keccak256("PAUSER_ROLE");

    // ─── state ────────────────────────────────────────────────────────────────
    TokenRegistry public immutable registry;

    /// @notice Tracks withdrawal IDs that have already been executed.
    mapping(bytes32 => bool) public executedWithdrawals;

    /// @notice Per-user, per-token deposit nonce.
    mapping(address => mapping(address => uint256)) private _userNonces;

    /// @notice Tokens held in escrow by this contract.
    mapping(address => uint256) private _lockedBalances;

    // ─── time-lock ────────────────────────────────────────────────────────────
    struct TimeLockEntry {
        address token;
        uint256 amount;
        address recipient;
        uint256 executeAfter;
        bool    executed;
    }

    /// @notice Pending time-locked withdrawals (withdrawalId → entry).
    mapping(bytes32 => TimeLockEntry) public timeLocked;

    /// @notice Amount threshold above which a withdrawal is time-locked (per token, 0 = disabled).
    mapping(address => uint256) public timeLockThreshold;

    /// @notice Delay applied to time-locked withdrawals in seconds (per token).
    mapping(address => uint256) public timeLockDelay;

    // ─── constructor ──────────────────────────────────────────────────────────

    constructor(address admin, address _registry) {
        registry = TokenRegistry(_registry);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE,        admin);
    }

    // ─── deposit (EVM → Canton) ───────────────────────────────────────────────

    /// @notice Lock ERC-20 tokens on Plasma.
    ///         The Canton relayer watches DepositToCanton events and mints the
    ///         equivalent CIP-56 holding to the party identified by `fingerprint`.
    /// @param token        ERC-20 token (must be registered in TokenRegistry)
    /// @param amount       raw token units (caller must pre-approve this contract)
    /// @param fingerprint  bytes32 fingerprint portion of the Canton party ID
    function depositToCanton(
        address token,
        uint256 amount,
        bytes32 fingerprint
    ) external nonReentrant whenNotPaused {
        if (!registry.isRegistered(token)) revert UnregisteredToken(token);
        if (amount == 0)            revert InvalidAmount();
        if (fingerprint == bytes32(0)) revert InvalidFingerprint();

        _checkAndUpdateRateLimit(token, amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _lockedBalances[token] += amount;

        uint256 nonce = _userNonces[msg.sender][token]++;
        emit DepositToCanton(token, msg.sender, amount, fingerprint, nonce);
    }

    // ─── withdrawal (Canton → EVM) ────────────────────────────────────────────

    /// @notice Release ERC-20 tokens to `recipient` after a Canton-side burn.
    ///         Caller must supply a valid ECDSA proof signed by a RELAYER_ROLE address.
    function withdrawFromCanton(
        address token,
        uint256 amount,
        address recipient,
        bytes32 withdrawalId,
        bytes calldata proof
    ) external nonReentrant whenNotPaused {
        if (!registry.isRegistered(token)) revert UnregisteredToken(token);
        if (amount == 0)                   revert InvalidAmount();
        if (executedWithdrawals[withdrawalId]) revert DuplicateWithdrawal(withdrawalId);

        _verifyRelayerProof(token, amount, recipient, withdrawalId, proof);
        executedWithdrawals[withdrawalId] = true;

        uint256 threshold = timeLockThreshold[token];
        if (threshold > 0 && amount > threshold) {
            uint256 delay = timeLockDelay[token];
            uint256 executeAfter = block.timestamp + delay;
            timeLocked[withdrawalId] = TimeLockEntry({
                token:        token,
                amount:       amount,
                recipient:    recipient,
                executeAfter: executeAfter,
                executed:     false
            });
            // tokens remain locked in _lockedBalances until executeTimeLocked()
            emit TimeLockQueued(withdrawalId, executeAfter);
        } else {
            _lockedBalances[token] -= amount;
            IERC20(token).safeTransfer(recipient, amount);
            emit WithdrawalProcessed(token, recipient, amount, withdrawalId);
        }
    }

    /// @notice Execute a previously time-locked withdrawal once the delay has elapsed.
    function executeTimeLocked(bytes32 withdrawalId) external nonReentrant {
        TimeLockEntry storage entry = timeLocked[withdrawalId];
        if (entry.executeAfter == 0)        revert WithdrawalNotQueued(withdrawalId);
        if (entry.executed)                  revert AlreadyExecuted(withdrawalId);
        if (block.timestamp < entry.executeAfter)
            revert TimeLockNotExpired(withdrawalId, entry.executeAfter);

        entry.executed = true;
        _lockedBalances[entry.token] -= entry.amount;
        IERC20(entry.token).safeTransfer(entry.recipient, entry.amount);

        emit TimeLockExecuted(withdrawalId);
        emit WithdrawalProcessed(entry.token, entry.recipient, entry.amount, withdrawalId);
    }

    // ─── admin ────────────────────────────────────────────────────────────────

    function setRateLimit(address token, uint256 maxAmount, uint256 period)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setRateLimit(token, maxAmount, period);
        emit RateLimitSet(token, maxAmount, period);
    }

    function setTimeLock(address token, uint256 threshold, uint256 delay)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        timeLockThreshold[token] = threshold;
        timeLockDelay[token]     = delay;
        emit TimeLockThresholdSet(token, threshold, delay);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        emit BridgePaused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
        emit BridgeUnpaused(msg.sender);
    }

    /// @notice Drain a token's full balance to `to`. Only callable by admin when paused.
    function emergencyWithdraw(address token, address to)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
    {
        uint256 balance = IERC20(token).balanceOf(address(this));
        _lockedBalances[token] = 0;
        IERC20(token).safeTransfer(to, balance);
        emit EmergencyWithdrawal(token, to, balance);
    }

    // ─── views ────────────────────────────────────────────────────────────────

    function isTokenRegistered(address token) external view returns (bool) {
        return registry.isRegistered(token);
    }

    function getLockedBalance(address token) external view returns (uint256) {
        return _lockedBalances[token];
    }

    function getUserNonce(address user, address token) external view returns (uint256) {
        return _userNonces[user][token];
    }

    // ─── internal ─────────────────────────────────────────────────────────────

    /// @dev Verify that `proof` is a RELAYER_ROLE signature over the withdrawal parameters.
    ///      The signed message is: keccak256(token, amount, recipient, withdrawalId, chainId).
    function _verifyRelayerProof(
        address token,
        uint256 amount,
        address recipient,
        bytes32 withdrawalId,
        bytes calldata proof
    ) internal view {
        bytes32 messageHash = keccak256(
            abi.encodePacked(token, amount, recipient, withdrawalId, block.chainid)
        );
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
        address signer = ECDSA.recover(ethSignedHash, proof);
        if (!hasRole(RELAYER_ROLE, signer)) revert InvalidRelayerProof();
    }
}
