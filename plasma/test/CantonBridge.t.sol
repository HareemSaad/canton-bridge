// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CantonBridge.sol";
import "../src/TokenRegistry.sol";
import "../src/MockERC20.sol";

/// @title CantonBridgeTest
/// @notice Comprehensive Foundry test suite for the production CantonBridge.
contract CantonBridgeTest is Test {
    // ─── contracts ────────────────────────────────────────────────────────────
    CantonBridge  internal bridge;
    TokenRegistry internal registry;
    MockUSDC      internal usdc;

    // ─── actors ───────────────────────────────────────────────────────────────
    address internal admin   = makeAddr("admin");
    address internal pauser  = makeAddr("pauser");
    address internal user    = makeAddr("user");
    address internal recipient = makeAddr("recipient");

    // relayer key pair (used for withdrawal proofs)
    uint256 internal relayerKey = 0xDEADBEEF;
    address internal relayer    = vm.addr(relayerKey);

    // ─── constants ────────────────────────────────────────────────────────────
    string  internal constant CIP56_ID  = "MockUSDC::canton";
    bytes32 internal constant FINGERPRINT =
        bytes32(uint256(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef));
    uint256 internal constant AMOUNT = 1_000_000; // 1 mUSDC (6 dec)

    // Pre-cached role identifiers (avoids staticcall-consuming-expectRevert pitfall)
    bytes32 internal RELAYER_ROLE;
    bytes32 internal PAUSER_ROLE;
    bytes32 internal ADMIN_ROLE;

    // ─── setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(admin);

        registry = new TokenRegistry(admin);
        bridge   = new CantonBridge(admin, address(registry));
        usdc     = new MockUSDC(admin);

        // Cache roles before any expectRevert usage
        RELAYER_ROLE = bridge.RELAYER_ROLE();
        PAUSER_ROLE  = bridge.PAUSER_ROLE();
        ADMIN_ROLE   = bridge.DEFAULT_ADMIN_ROLE();

        // Grant roles
        bridge.grantRole(RELAYER_ROLE, relayer);
        bridge.grantRole(PAUSER_ROLE,  pauser);

        // Register token
        registry.registerTokenWithMetadata(address(usdc), "mUSDC", "Mock USDC", 6, CIP56_ID);

        // Mint tokens to user
        usdc.mint(user, 100_000_000); // 100 mUSDC

        vm.stopPrank();

        // User approves bridge
        vm.prank(user);
        usdc.approve(address(bridge), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  depositToCanton
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Deposit_TransfersTokensToBridge() public {
        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);

        assertEq(usdc.balanceOf(user),           before - AMOUNT);
        assertEq(usdc.balanceOf(address(bridge)), AMOUNT);
        assertEq(bridge.getLockedBalance(address(usdc)), AMOUNT);
    }

    function test_Deposit_EmitsDepositToCanton() public {
        vm.expectEmit(true, true, true, true);
        emit IBridgeEvents.DepositToCanton(address(usdc), user, AMOUNT, FINGERPRINT, 0);

        vm.prank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);
    }

    function test_Deposit_IncrementsUserNonce() public {
        assertEq(bridge.getUserNonce(user, address(usdc)), 0);

        vm.startPrank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);
        assertEq(bridge.getUserNonce(user, address(usdc)), 1);

        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);
        assertEq(bridge.getUserNonce(user, address(usdc)), 2);
        vm.stopPrank();
    }

    function test_Deposit_RevertsForUnregisteredToken() public {
        address fake = makeAddr("fakeToken");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ICantonBridge.UnregisteredToken.selector, fake));
        bridge.depositToCanton(fake, AMOUNT, FINGERPRINT);
    }

    function test_Deposit_RevertsForZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(ICantonBridge.InvalidAmount.selector);
        bridge.depositToCanton(address(usdc), 0, FINGERPRINT);
    }

    function test_Deposit_RevertsForZeroFingerprint() public {
        vm.prank(user);
        vm.expectRevert(ICantonBridge.InvalidFingerprint.selector);
        bridge.depositToCanton(address(usdc), AMOUNT, bytes32(0));
    }

    function test_Deposit_RevertsWhenPaused() public {
        vm.prank(pauser);
        bridge.pause();

        vm.prank(user);
        vm.expectRevert();
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);
    }

    function test_Deposit_RevertsOnRateLimitExceeded() public {
        // Set rate limit: 5 mUSDC per 1 hour
        uint256 limit = 5_000_000;
        vm.prank(admin);
        bridge.setRateLimit(address(usdc), limit, 3600);

        // First deposit at exactly the limit — succeeds
        vm.prank(user);
        bridge.depositToCanton(address(usdc), limit, FINGERPRINT);

        // Second deposit — limit exceeded
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimiter.TokenRateLimitExceeded.selector, address(usdc), 1, 0)
        );
        bridge.depositToCanton(address(usdc), 1, FINGERPRINT);
    }

    function test_Deposit_RateLimitResetsAfterPeriod() public {
        uint256 limit = 5_000_000;
        vm.prank(admin);
        bridge.setRateLimit(address(usdc), limit, 3600);

        vm.prank(user);
        bridge.depositToCanton(address(usdc), limit, FINGERPRINT);

        // Advance past the window
        skip(3601);

        // Should succeed again
        vm.prank(user);
        bridge.depositToCanton(address(usdc), limit, FINGERPRINT);
    }

    function testFuzz_Deposit_AnyAmount(uint96 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= usdc.balanceOf(user));

        vm.prank(user);
        bridge.depositToCanton(address(usdc), amount, FINGERPRINT);

        assertEq(bridge.getLockedBalance(address(usdc)), amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  withdrawFromCanton
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Helper: deposit AMOUNT then build a valid relayer proof for withdrawal.
    function _depositAndBuildProof(bytes32 withdrawalId)
        internal
        returns (bytes memory proof)
    {
        vm.prank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);

        bytes32 msgHash = keccak256(
            abi.encodePacked(address(usdc), AMOUNT, recipient, withdrawalId, block.chainid)
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(relayerKey, ethHash);
        proof = abi.encodePacked(r, s, v);
    }

    function test_Withdraw_ReleasesTokens() public {
        bytes32 wid = keccak256("withdrawal-1");
        bytes memory proof = _depositAndBuildProof(wid);

        uint256 before = usdc.balanceOf(recipient);
        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);

        assertEq(usdc.balanceOf(recipient),               before + AMOUNT);
        assertEq(bridge.getLockedBalance(address(usdc)),  0);
    }

    function test_Withdraw_EmitsWithdrawalProcessed() public {
        bytes32 wid = keccak256("withdrawal-emit");
        bytes memory proof = _depositAndBuildProof(wid);

        vm.expectEmit(true, true, true, true);
        emit IBridgeEvents.WithdrawalProcessed(address(usdc), recipient, AMOUNT, wid);
        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);
    }

    function test_Withdraw_RevertsOnReplay() public {
        bytes32 wid = keccak256("withdrawal-replay");
        bytes memory proof = _depositAndBuildProof(wid);

        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);

        vm.expectRevert(abi.encodeWithSelector(ICantonBridge.DuplicateWithdrawal.selector, wid));
        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);
    }

    function test_Withdraw_RevertsForInvalidProof() public {
        // Sign with a non-relayer key
        uint256 wrongKey = 0xBAD;
        bytes32 wid = keccak256("withdrawal-bad-proof");

        vm.prank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);

        bytes32 msgHash = keccak256(
            abi.encodePacked(address(usdc), AMOUNT, recipient, wid, block.chainid)
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, ethHash);
        bytes memory proof = abi.encodePacked(r, s, v);

        vm.expectRevert(ICantonBridge.InvalidRelayerProof.selector);
        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);
    }

    function test_Withdraw_RevertsForUnregisteredToken() public {
        address fake = makeAddr("fakeToken");
        vm.expectRevert(abi.encodeWithSelector(ICantonBridge.UnregisteredToken.selector, fake));
        bridge.withdrawFromCanton(fake, AMOUNT, recipient, bytes32("x"), new bytes(65));
    }

    function test_Withdraw_QueuesLargeWithdrawalBehindTimeLock() public {
        uint256 threshold = AMOUNT - 1; // AMOUNT exceeds threshold
        uint256 delay     = 2 days;

        vm.prank(admin);
        bridge.setTimeLock(address(usdc), threshold, delay);

        bytes32 wid = keccak256("tl-withdrawal");
        bytes memory proof = _depositAndBuildProof(wid);

        vm.expectEmit(true, false, false, true);
        emit IBridgeEvents.TimeLockQueued(wid, block.timestamp + delay);
        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);

        // Tokens NOT released yet
        assertEq(usdc.balanceOf(recipient), 0);

        // Execute before delay → reverts
        vm.expectRevert(
            abi.encodeWithSelector(ICantonBridge.TimeLockNotExpired.selector, wid, block.timestamp + delay)
        );
        bridge.executeTimeLocked(wid);

        // Advance past delay
        skip(delay + 1);

        vm.expectEmit(true, false, false, false);
        emit IBridgeEvents.TimeLockExecuted(wid);
        bridge.executeTimeLocked(wid);

        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    function test_Withdraw_ExecuteTimeLocked_RevertsOnReplay() public {
        uint256 threshold = AMOUNT - 1;
        vm.prank(admin);
        bridge.setTimeLock(address(usdc), threshold, 1);

        bytes32 wid = keccak256("tl-replay");
        bytes memory proof = _depositAndBuildProof(wid);
        bridge.withdrawFromCanton(address(usdc), AMOUNT, recipient, wid, proof);

        skip(2);
        bridge.executeTimeLocked(wid);

        vm.expectRevert(abi.encodeWithSelector(ICantonBridge.AlreadyExecuted.selector, wid));
        bridge.executeTimeLocked(wid);
    }

    function test_Withdraw_ExecuteTimeLocked_RevertsIfNotQueued() public {
        bytes32 wid = keccak256("not-queued");
        vm.expectRevert(abi.encodeWithSelector(ICantonBridge.WithdrawalNotQueued.selector, wid));
        bridge.executeTimeLocked(wid);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pause / Unpause
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Pause_OnlyPauser() public {
        vm.prank(user);
        vm.expectRevert();
        bridge.pause();

        vm.prank(pauser);
        bridge.pause();
        assertTrue(bridge.paused());
    }

    function test_Unpause_OnlyPauser() public {
        vm.prank(pauser);
        bridge.pause();

        vm.prank(user);
        vm.expectRevert();
        bridge.unpause();

        vm.prank(pauser);
        bridge.unpause();
        assertFalse(bridge.paused());
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Rate limit admin
    // ═══════════════════════════════════════════════════════════════════════════

    function test_SetRateLimit_OnlyAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        bridge.setRateLimit(address(usdc), 1e18, 3600);

        vm.prank(admin);
        bridge.setRateLimit(address(usdc), 1e18, 3600);

        (uint256 max, uint256 period,,) = bridge.getRateLimit(address(usdc));
        assertEq(max, 1e18);
        assertEq(period, 3600);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Emergency withdrawal
    // ═══════════════════════════════════════════════════════════════════════════

    function test_EmergencyWithdraw_OnlyAdmin() public {
        vm.prank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);

        vm.prank(pauser);
        bridge.pause();

        vm.prank(user);
        vm.expectRevert();
        bridge.emergencyWithdraw(address(usdc), user);

        uint256 before = usdc.balanceOf(admin);
        vm.prank(admin);
        bridge.emergencyWithdraw(address(usdc), admin);

        assertEq(usdc.balanceOf(admin), before + AMOUNT);
        assertEq(bridge.getLockedBalance(address(usdc)), 0);
    }

    function test_EmergencyWithdraw_RevertsWhenNotPaused() public {
        vm.prank(user);
        bridge.depositToCanton(address(usdc), AMOUNT, FINGERPRINT);

        vm.prank(admin);
        vm.expectRevert();
        bridge.emergencyWithdraw(address(usdc), admin);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  TokenRegistry integration
    // ═══════════════════════════════════════════════════════════════════════════

    function test_RegisterToken_StoresMetadata() public {
        MockWBTC wbtc = new MockWBTC(admin);

        vm.prank(admin);
        registry.registerToken(address(wbtc), "MockWBTC::canton");

        assertTrue(registry.isRegistered(address(wbtc)));
        TokenRegistry.TokenMetadata memory meta = registry.getMetadata(address(wbtc));
        assertEq(meta.symbol,   "mWBTC");
        assertEq(meta.decimals, 8);
        assertEq(meta.cip56Id,  "MockWBTC::canton");
    }

    function test_RegisterToken_RevertsDuplicate() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(TokenRegistry.TokenAlreadyRegistered.selector, address(usdc))
        );
        registry.registerToken(address(usdc), "another-id");
    }

    function test_RegisterToken_RevertsDuplicateCip56Id() public {
        MockWBTC wbtc = new MockWBTC(admin);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(TokenRegistry.Cip56IdAlreadyUsed.selector, CIP56_ID)
        );
        registry.registerToken(address(wbtc), CIP56_ID);
    }

    function test_DeregisterToken_OnlyAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        registry.deregisterToken(address(usdc));

        vm.prank(admin);
        registry.deregisterToken(address(usdc));
        assertFalse(registry.isRegistered(address(usdc)));
    }

    function test_GetCip56Id_ReturnsCorrectId() public view {
        assertEq(registry.getCip56Id(address(usdc)), CIP56_ID);
    }

    function test_AddRelayer_OnlyAdmin() public {
        address newRelayer = makeAddr("newRelayer");

        // Non-admin should be rejected (RELAYER_ROLE pre-cached — avoids staticcall pitfall)
        vm.startPrank(user);
        vm.expectRevert();
        bridge.grantRole(RELAYER_ROLE, newRelayer);
        vm.stopPrank();

        // Admin can grant
        vm.startPrank(admin);
        bridge.grantRole(RELAYER_ROLE, newRelayer);
        vm.stopPrank();

        assertTrue(bridge.hasRole(RELAYER_ROLE, newRelayer));
    }

    function test_RemoveRelayer_OnlyAdmin() public {
        vm.startPrank(admin);
        bridge.revokeRole(RELAYER_ROLE, relayer);
        vm.stopPrank();
        assertFalse(bridge.hasRole(RELAYER_ROLE, relayer));
    }
}
