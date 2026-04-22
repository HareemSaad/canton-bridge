// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RateLimiter
/// @notice Abstract contract that enforces per-token deposit rate limits.
///         The limit resets automatically after each period expires.
abstract contract RateLimiter {
    struct RateLimit {
        uint256 maxAmount;   // max cumulative amount per period (0 = disabled)
        uint256 period;      // window duration in seconds
        uint256 lastReset;   // timestamp of the last reset
        uint256 currentUsed; // amount consumed in the current window
    }

    mapping(address => RateLimit) private _rateLimits;

    error TokenRateLimitExceeded(address token, uint256 requested, uint256 remaining);

    // ─── internal ─────────────────────────────────────────────────────────────

    function _setRateLimit(address token, uint256 maxAmount, uint256 period) internal {
        require(maxAmount == 0 || period > 0, "RateLimiter: period must be > 0 when active");
        _rateLimits[token] = RateLimit({
            maxAmount: maxAmount,
            period: period,
            lastReset: block.timestamp,
            currentUsed: 0
        });
    }

    function _checkAndUpdateRateLimit(address token, uint256 amount) internal {
        RateLimit storage rl = _rateLimits[token];
        if (rl.maxAmount == 0) return; // no limit configured

        // auto-reset on period expiry
        if (block.timestamp >= rl.lastReset + rl.period) {
            rl.lastReset = block.timestamp;
            rl.currentUsed = 0;
        }

        uint256 remaining = rl.maxAmount - rl.currentUsed;
        if (amount > remaining) revert TokenRateLimitExceeded(token, amount, remaining);
        rl.currentUsed += amount;
    }

    // ─── views ────────────────────────────────────────────────────────────────

    function getRateLimit(address token)
        external
        view
        returns (uint256 maxAmount, uint256 period, uint256 currentUsed, uint256 lastReset)
    {
        RateLimit storage rl = _rateLimits[token];
        return (rl.maxAmount, rl.period, rl.currentUsed, rl.lastReset);
    }

    function getRemainingRateLimit(address token) external view returns (uint256) {
        RateLimit storage rl = _rateLimits[token];
        if (rl.maxAmount == 0) return type(uint256).max;
        if (block.timestamp >= rl.lastReset + rl.period) return rl.maxAmount;
        return rl.maxAmount - rl.currentUsed;
    }

    function getRateLimitResetTime(address token) external view returns (uint256) {
        RateLimit storage rl = _rateLimits[token];
        if (rl.period == 0) return 0;
        return rl.lastReset + rl.period;
    }
}
