// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {Gateway} from "../src/Gateway.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Balance: ", deployer.balance);

        vm.startBroadcast(deployerKey);

        Gateway gateway = new Gateway();

        vm.stopBroadcast();

        console.log("Gateway deployed at:", address(gateway));
    }
}
