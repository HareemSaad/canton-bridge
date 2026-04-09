// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {Gateway} from "../src/Gateway.sol";
import {IGateway} from "../src/interfaces/IGateway.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock Token", "MCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract GatewayTest is Test {
    Gateway public gateway;
    MockERC20 public token;

    address owner = address(this);
    address user = makeAddr("user");

    bytes32 constant CANTON = keccak256("CANTON");
    bytes32 constant PLASMA = keccak256("PLASMA");

    function setUp() public {
        gateway = new Gateway();
        token = new MockERC20();
        // whitelist token and chains for happy-path tests
        gateway.whiteListToken(address(token));
        gateway.whiteListChain(CANTON);
        gateway.whiteListChain(PLASMA);
    }

    // ── lock ────────────────────────────────────────────────────────────────

    function test_Lock_TransfersTokensToGateway() public {
        token.mint(user, 100e18);

        vm.startPrank(user);
        token.approve(address(gateway), 100e18);
        gateway.lock(address(token), 100e18, "recipient-on-canton", CANTON);
        vm.stopPrank();

        assertEq(token.balanceOf(address(gateway)), 100e18);
        assertEq(token.balanceOf(user), 0);
    }

    function test_Lock_EmitsLockedEvent() public {
        token.mint(user, 50e18);

        vm.startPrank(user);
        token.approve(address(gateway), 50e18);

        vm.expectEmit(true, true, true, true);
        emit IGateway.locked(0, address(token), 50e18, "recipient-on-canton", CANTON);

        gateway.lock(address(token), 50e18, "recipient-on-canton", CANTON);
        vm.stopPrank();
    }

    function test_Lock_IncrementsNonce() public {
        token.mint(user, 300e18);

        vm.startPrank(user);
        token.approve(address(gateway), 300e18);

        assertEq(gateway.nonce(), 0);
        gateway.lock(address(token), 100e18, "r1", CANTON);
        assertEq(gateway.nonce(), 1);
        gateway.lock(address(token), 100e18, "r2", CANTON);
        assertEq(gateway.nonce(), 2);
        gateway.lock(address(token), 100e18, "r3", PLASMA);
        assertEq(gateway.nonce(), 3);
        vm.stopPrank();
    }

    function test_Lock_RevertsForNotWhitelistedToken() public {
        MockERC20 unlisted = new MockERC20();
        unlisted.mint(user, 100e18);

        vm.startPrank(user);
        unlisted.approve(address(gateway), 100e18);
        vm.expectRevert(IGateway.NotWhitelistedToken.selector);
        gateway.lock(address(unlisted), 100e18, "recipient", CANTON);
        vm.stopPrank();
    }

    function test_Lock_RevertsForNotWhitelistedChain() public {
        bytes32 unknownChain = keccak256("ETHEREUM");
        token.mint(user, 100e18);

        vm.startPrank(user);
        token.approve(address(gateway), 100e18);
        vm.expectRevert(IGateway.NotWhitelistedChain.selector);
        gateway.lock(address(token), 100e18, "recipient", unknownChain);
        vm.stopPrank();
    }

    function test_Lock_RevertsWithoutApproval() public {
        token.mint(user, 100e18);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(gateway), // spender
                0,                // current allowance
                100e18            // needed
            )
        );
        gateway.lock(address(token), 100e18, "recipient", CANTON);
    }

    function test_Lock_RevertsIfInsufficientBalance() public {
        token.mint(user, 10e18);

        vm.startPrank(user);
        token.approve(address(gateway), 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector,
                user,   // sender
                10e18,  // current balance
                100e18  // needed
            )
        );
        gateway.lock(address(token), 100e18, "recipient", CANTON);
        vm.stopPrank();
    }

    function testFuzz_Lock_AnyAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(gateway), amount);
        gateway.lock(address(token), amount, "recipient", CANTON);
        vm.stopPrank();

        assertEq(token.balanceOf(address(gateway)), amount);
    }

    // ── whiteListToken ───────────────────────────────────────────────────────

    function test_WhiteListToken_OwnerCanWhitelist() public {
        MockERC20 newToken = new MockERC20();
        assertFalse(gateway.whitelistedTokens(address(newToken)));
        gateway.whiteListToken(address(newToken));
        assertTrue(gateway.whitelistedTokens(address(newToken)));
    }

    function test_WhiteListToken_RevertsForNonOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user)
        );
        gateway.whiteListToken(address(token));
    }

    // ── whiteListChain ───────────────────────────────────────────────────────

    function test_WhiteListChain_OwnerCanWhitelist() public {
        bytes32 newChain = keccak256("ETHEREUM");
        assertFalse(gateway.whitelistedChains(newChain));
        gateway.whiteListChain(newChain);
        assertTrue(gateway.whitelistedChains(newChain));
    }

    function test_WhiteListChain_RevertsForNonOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user)
        );
        gateway.whiteListChain(keccak256("ETHEREUM"));
    }

    // ── ownership ────────────────────────────────────────────────────────────

    function test_Owner_IsDeployer() public view {
        assertEq(gateway.owner(), owner);
    }
}
