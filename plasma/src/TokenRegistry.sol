// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title TokenRegistry
/// @notice Maintains the whitelist of ERC-20 tokens that may be bridged and
///         their associated Canton CIP-56 instrument IDs.
contract TokenRegistry is AccessControl {
    struct TokenMetadata {
        string symbol;
        string name;
        uint8  decimals;
        string cip56Id;  // Canton CIP-56 instrument identifier
        bool   active;
    }

    mapping(address => TokenMetadata) private _tokens;
    address[] private _tokenList;
    mapping(string => bool) private _usedCip56Ids;

    // ─── errors ───────────────────────────────────────────────────────────────
    error TokenAlreadyRegistered(address token);
    error TokenNotRegistered(address token);
    error EmptyCip56Id();
    error Cip56IdAlreadyUsed(string cip56Id);

    // ─── events ───────────────────────────────────────────────────────────────
    event TokenRegistered(address indexed token, string symbol, string cip56Id);
    event TokenDeregistered(address indexed token);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ─── admin: registration ──────────────────────────────────────────────────

    /// @notice Register a token by auto-fetching its ERC-20 metadata.
    function registerToken(address token, string calldata cip56Id)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _requireNotRegistered(token);
        _requireValidCip56Id(cip56Id);

        IERC20Metadata erc20 = IERC20Metadata(token);
        _store(token, erc20.symbol(), erc20.name(), erc20.decimals(), cip56Id);
    }

    /// @notice Register a token with explicit metadata (useful for non-standard ERC-20s).
    function registerTokenWithMetadata(
        address token,
        string calldata symbol,
        string calldata name,
        uint8  decimals,
        string calldata cip56Id
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireNotRegistered(token);
        _requireValidCip56Id(cip56Id);
        _store(token, symbol, name, decimals, cip56Id);
    }

    /// @notice De-list a token from the bridge (does not affect locked balances).
    function deregisterToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_tokens[token].active) revert TokenNotRegistered(token);
        _tokens[token].active = false;
        emit TokenDeregistered(token);
    }

    // ─── views ────────────────────────────────────────────────────────────────

    function isRegistered(address token) external view returns (bool) {
        return _tokens[token].active;
    }

    function getMetadata(address token) external view returns (TokenMetadata memory) {
        if (!_tokens[token].active) revert TokenNotRegistered(token);
        return _tokens[token];
    }

    function getCip56Id(address token) external view returns (string memory) {
        return _tokens[token].cip56Id;
    }

    /// @notice Returns all currently active (whitelisted) token addresses.
    function getActiveTokens() external view returns (address[] memory active) {
        uint256 count;
        for (uint256 i; i < _tokenList.length; ++i) {
            if (_tokens[_tokenList[i]].active) ++count;
        }
        active = new address[](count);
        uint256 idx;
        for (uint256 i; i < _tokenList.length; ++i) {
            if (_tokens[_tokenList[i]].active) active[idx++] = _tokenList[i];
        }
    }

    // ─── internal ─────────────────────────────────────────────────────────────

    function _store(
        address token,
        string memory symbol,
        string memory name,
        uint8  decimals,
        string memory cip56Id
    ) internal {
        _tokens[token] = TokenMetadata({
            symbol: symbol,
            name: name,
            decimals: decimals,
            cip56Id: cip56Id,
            active: true
        });
        _usedCip56Ids[cip56Id] = true;
        _tokenList.push(token);
        emit TokenRegistered(token, symbol, cip56Id);
    }

    function _requireNotRegistered(address token) internal view {
        if (_tokens[token].active) revert TokenAlreadyRegistered(token);
    }

    function _requireValidCip56Id(string calldata cip56Id) internal view {
        if (bytes(cip56Id).length == 0) revert EmptyCip56Id();
        if (_usedCip56Ids[cip56Id]) revert Cip56IdAlreadyUsed(cip56Id);
    }
}
