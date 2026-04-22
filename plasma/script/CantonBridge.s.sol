// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/CantonBridge.sol";
import "../src/TokenRegistry.sol";
import "../src/MockERC20.sol";

/// @notice Deploys TokenRegistry, CantonBridge, MockUSDC, registers the token,
///         and whitelists the deployer as relayer.
///
/// Usage:
///   forge script script/CantonBridge.s.sol:DeployCantonBridge \
///     --rpc-url $RPC_URL --broadcast
///
/// Env vars required in .env:
///   PRIVATE_KEY        — deployer / admin key
///   RELAYER_ADDRESS    — (optional) address to grant RELAYER_ROLE
///   CIP56_INSTRUMENT   — (optional) Canton CIP-56 instrument ID for MockUSDC
contract DeployCantonBridge is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // Optional overrides (defaults shown)
        address relayerAddr = vm.envOr("RELAYER_ADDRESS",  deployer);
        string  memory cip56Id = vm.envOr("CIP56_INSTRUMENT", string("MockUSDC::canton"));

        vm.startBroadcast(deployerKey);

        // 1. Token registry (admin = deployer)
        TokenRegistry registry = new TokenRegistry(deployer);
        console.log("TokenRegistry:", address(registry));

        // 2. Main bridge contract
        CantonBridge bridge = new CantonBridge(deployer, address(registry));
        console.log("CantonBridge :", address(bridge));

        // 3. Test token (6 decimals, matching USDC / CIP-56 USDCx)
        MockUSDC usdc = new MockUSDC(deployer);
        console.log("MockUSDC     :", address(usdc));

        // 4. Register MockUSDC in the token registry
        registry.registerTokenWithMetadata(
            address(usdc),
            "mUSDC",
            "Mock USDC",
            6,
            cip56Id
        );
        console.log("MockUSDC registered, cip56Id:", cip56Id);

        // 5. Grant RELAYER_ROLE to the configured relayer address
        bridge.grantRole(bridge.RELAYER_ROLE(), relayerAddr);
        console.log("RELAYER_ROLE granted to:", relayerAddr);

        // 6. Mint 1 000 mUSDC to deployer for testing
        usdc.mint(deployer, 1_000_000_000); // 1 000.000 000 (6 dec)
        console.log("Minted 1000 mUSDC to deployer");

        vm.stopBroadcast();

        // Log summary for local-setup.sh parsing
        console.log("=== DEPLOYMENT SUMMARY ===");
        console.log("CANTON_BRIDGE_ADDRESS=", address(bridge));
        console.log("TOKEN_REGISTRY_ADDRESS=", address(registry));
        console.log("MOCK_USDC_ADDRESS=",      address(usdc));
    }
}
