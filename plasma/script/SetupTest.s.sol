// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Gateway} from "../src/Gateway.sol";
import {MockUSDC} from "../src/MockERC20.sol";

/// @dev Legacy helper: deploys MockUSDC (6 dec), whitelists it + Canton chain
///      in the original Gateway contract, and mints 1 000 mUSDC to the deployer.
///      Used by local-setup.sh for the old Gateway-based POC flow.
contract SetupTest is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address gateway     = vm.envAddress("GATEWAY_ADDRESS");

        vm.startBroadcast(deployerKey);

        MockUSDC token = new MockUSDC(deployer);
        token.mint(deployer, 1_000 * 10 ** 6);

        Gateway(gateway).whiteListToken(address(token));
        Gateway(gateway).whiteListChain(keccak256("canton"));

        vm.stopBroadcast();

        console.log("MockUSDC   :", address(token));
        console.log("Gateway    :", gateway);
        console.log("Token and canton chain whitelisted");
    }
}
