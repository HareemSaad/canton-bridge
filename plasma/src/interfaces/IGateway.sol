// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

interface IGateway {
    error NotWhitelistedToken();
    error NotWhitelistedChain();

    event locked(
        uint256 indexed nonce,
        address indexed token,
        uint256 amount,
        string recipient,
        bytes32 indexed toChain
    );

    /**
     * @notice locks the tokens in the gateway contract and emits an event to be listened by the off-chain relayer
     * @param token token address to be locked
     * @param amount amount of tokens to be locked
     * @param recipient recipient of the locked tokens on the other chain
     * @param toChain keccak256 identifier of the destination chain (e.g. keccak256("CANTON"))
     */
    function lock(
        address token,
        uint256 amount,
        string memory recipient,
        bytes32 toChain
    ) external;

    function nonce() external view returns (uint256);

    function whitelistedTokens(address token) external view returns (bool);

    function whitelistedChains(bytes32 chain) external view returns (bool);

    function whiteListChain(bytes32 chain) external;
}
