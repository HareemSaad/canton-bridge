// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Base mintable/burnable ERC-20 for bridge testing.
///         Decimals are set at construction time (e.g. 6 for USDC, 8 for WBTC).
abstract contract MockERC20 is ERC20, Ownable {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Mint tokens to `to`. Only callable by owner (deployer / test harness).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burn caller's own tokens.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

/// @notice Mock USDC — 6 decimals, matches real USDC / USDCx precision.
contract MockUSDC is MockERC20 {
    constructor(address owner_) MockERC20("Mock USDC", "mUSDC", 6, owner_) {}
}

/// @notice Mock WBTC — 8 decimals.
contract MockWBTC is MockERC20 {
    constructor(address owner_) MockERC20("Mock WBTC", "mWBTC", 8, owner_) {}
}
