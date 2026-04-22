---
name: plasma-bridge
description: Plasma/Solidity side of the canton-bridge — CantonBridge.sol, TokenRegistry, RateLimiter, Foundry tests, and deploy scripts. Use when writing or testing Solidity bridge contracts.
---

# Plasma Bridge (Solidity)

## Contract Layout

```
plasma/src/
  CantonBridge.sol              — Main bridge (depositToCanton, withdrawFromCanton)
  TokenRegistry.sol             — Token whitelist with CIP-56 instrument ID mapping
  MockERC20.sol                 — abstract MockERC20 + concrete MockUSDC (6 dec) + MockWBTC (8 dec)
  interfaces/
    ICantonBridge.sol           — Errors + function signatures
    IBridgeEvents.sol           — All bridge events
  security/
    RateLimiter.sol             — Abstract per-token rate limiter (inherited by CantonBridge)

plasma/script/
  CantonBridge.s.sol            — Deploy TokenRegistry + CantonBridge + MockUSDC
  SetupTest.s.sol               — Legacy Gateway setup (kept for reference)

plasma/test/
  CantonBridge.t.sol            — 30 Foundry tests (all passing)
```

## Key Contract Facts

### Roles
```solidity
RELAYER_ROLE = keccak256("RELAYER_ROLE")   // signs withdrawal proofs
PAUSER_ROLE  = keccak256("PAUSER_ROLE")    // pause/unpause
DEFAULT_ADMIN_ROLE                          // deployer, can grant roles + emergencyWithdraw
```

### depositToCanton signature
```solidity
function depositToCanton(address token, uint256 amount, bytes32 fingerprint) external
```
- `fingerprint` = keccak256 of the user's Canton party hint (e.g. `cast keccak "User1"`)
- Emits `DepositToCanton(token, user, amount, fingerprint, nonce)`
- Per-user nonce auto-increments

### withdrawFromCanton signature
```solidity
function withdrawFromCanton(
    address token,
    uint256 amount,
    address recipient,
    bytes32 withdrawalId,
    bytes calldata proof
) external
```
- `proof` = ECDSA signature over `keccak256(token, amount, recipient, withdrawalId, block.chainid)`
- Signed with `eth_sign` (prefixed hash via `MessageHashUtils.toEthSignedMessageHash`)
- Replay-protected by `executedWithdrawals[withdrawalId]`

## Foundry Commands

```bash
cd plasma

# Run all tests
forge test -vv

# Run a specific test
forge test --match-test test_Deposit_TransfersTokensToBridge -vvv

# Run fuzz test with more runs
forge test --match-test testFuzz_Deposit_AnyAmount --fuzz-runs 1000

# Build contracts
forge build

# Deploy locally (Anvil must be running)
PRIVATE_KEY=0x... \
RELAYER_ADDRESS=0x... \
CIP56_INSTRUMENT="MockUSDC::canton" \
forge script script/CantonBridge.s.sol:DeployCantonBridge \
  --rpc-url http://localhost:8545 --broadcast

# Check contract events
cast logs --rpc-url http://localhost:8545 \
  --address <CANTON_BRIDGE_ADDRESS> \
  "DepositToCanton(address,address,uint256,bytes32,uint256)"
```

## Test Patterns — Important Pitfalls

### Pre-cache role bytes32 before vm.expectRevert
Calling `bridge.RELAYER_ROLE()` in argument position after `vm.expectRevert()` will consume the expectRevert cheat code, causing false failures:

```solidity
// WRONG — bridge.RELAYER_ROLE() staticcall consumes expectRevert
vm.expectRevert(...);
bridge.grantRole(bridge.RELAYER_ROLE(), addr);

// CORRECT — cache first, use cached value after expectRevert
bytes32 RELAYER_ROLE;
function setUp() public {
    RELAYER_ROLE = bridge.RELAYER_ROLE();
}
// then in test:
vm.expectRevert(...);
bridge.grantRole(RELAYER_ROLE, addr);
```

### Withdrawal proof signing
```solidity
bytes32 msgHash = keccak256(abi.encodePacked(token, amount, recipient, withdrawalId, block.chainid));
bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(relayerKey, ethHash);
bytes memory proof = abi.encodePacked(r, s, v);
```

## Rate Limiter

`RateLimiter.sol` is abstract. Inherited by CantonBridge.

```solidity
_setRateLimit(token, maxAmount, period)         // set limit per window
_checkAndUpdateRateLimit(token, amount)          // auto-resets on period expiry, reverts TokenRateLimitExceeded
getRateLimit(token) → (maxAmount, period, ...)
getRemainingRateLimit(token) → uint256
```

## TokenRegistry

```solidity
registry.registerToken(address token, string cip56Id)
    // auto-fetches name/symbol/decimals via ERC20Metadata

registry.registerTokenWithMetadata(address, symbol, name, decimals, cip56Id)
    // manual (for tokens without full ERC20Metadata)

registry.isRegistered(address) → bool
registry.getCip56Id(address) → string
registry.getActiveTokens() → address[]
```

## Emergency Procedures

```solidity
// Pause all deposits and withdrawals (PAUSER_ROLE)
bridge.pause();

// Emergency token recovery — only when paused (DEFAULT_ADMIN_ROLE)
bridge.emergencyWithdraw(token, to);

// Unpause
bridge.unpause();
```

## Reading Events On-Chain

```bash
# Check if deposit was indexed
cast logs \
  --rpc-url http://localhost:8545 \
  --address 0x59acb2967cc50c25b9d12b4b329e4da94054a897 \
  --from-block 21066379 \
  "DepositToCanton(address indexed,address indexed,uint256,bytes32 indexed,uint256)"

# Check token balance locked in bridge
cast call 0x8b9e96d678808ef4f01ca03b6935c56cabecf1ad \
  "balanceOf(address)(uint256)" \
  0x59acb2967cc50c25b9d12b4b329e4da94054a897 \
  --rpc-url http://localhost:8545
```
