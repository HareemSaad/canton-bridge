// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {Gateway} from "../src/Gateway.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// @dev Deploys MockERC20, whitelists it + the Canton chain in the Gateway,
///      and mints 1 000 mUSDCx (6 decimals) to the deployer for testing.
contract SetupTest is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address gateway     = vm.envAddress("GATEWAY_ADDRESS");

        vm.startBroadcast(deployerKey);

        // Deploy mock token (6 decimals, like USDC)
        MockERC20 token = new MockERC20("Mock USDCx", "mUSDCx", 6);

        // Mint 1 000 mUSDCx to the deployer (1 000 * 10^6)
        token.mint(deployer, 1_000 * 10 ** 6);

        // Whitelist the token and the Canton destination chain
        Gateway(gateway).whiteListToken(address(token));
        Gateway(gateway).whiteListChain(keccak256("canton"));

        vm.stopBroadcast();

        console.log("MockERC20  :", address(token));
        console.log("Gateway    :", gateway);
        console.log("Token and canton chain whitelisted");
    }
}
