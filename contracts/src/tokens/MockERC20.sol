// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Test token used for TKN (base) and mUSD (quote). 18 decimals.
/// @dev Anyone can mint. These tokens exist only on local chains and testnets and have no value.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Mint `amount` tokens to `to`. Open to everyone, by design.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
