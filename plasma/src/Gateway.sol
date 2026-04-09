// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "./interfaces/IGateway.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * TODO: add security measure
 * re-entrancy
 * pausable
 * access control
 */

contract Gateway is IGateway, Ownable {
    uint256 public nonce;

    mapping(address => bool) public whitelistedTokens;
    mapping(bytes32 => bool) public whitelistedChains;

    constructor() Ownable(msg.sender) {}

    function lock(
        address token,
        uint256 amount,
        string memory recipient,
        bytes32 toChain
    ) external {
        // check if the token is whitelisted
        if (!whitelistedTokens[token]) {
            revert NotWhitelistedToken();
        }

        // check if the destination chain is whitelisted
        if (!whitelistedChains[toChain]) {
            revert NotWhitelistedChain();
        }

        // transfer the tokens to the gateway contract
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        // emit the event to be listened by the off-chain relayer
        emit locked(nonce, token, amount, recipient, toChain);

        // increment the nonce for the next lock
        nonce++;
    }

    function whiteListToken(address token) external onlyOwner {
        whitelistedTokens[token] = true;
    }

    function whiteListChain(bytes32 chain) external onlyOwner {
        whitelistedChains[chain] = true;
    }
}
