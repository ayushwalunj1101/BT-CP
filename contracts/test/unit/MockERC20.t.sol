// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";

contract MockERC20Test is Test {
    MockERC20 internal token;

    function setUp() public {
        token = new MockERC20("Mock USD", "mUSD");
    }

    function test_Metadata() public view {
        assertEq(token.name(), "Mock USD");
        assertEq(token.symbol(), "mUSD");
        assertEq(token.decimals(), 18);
    }

    function testFuzz_AnyoneCanMint(address minter, address to, uint128 amount) public {
        vm.assume(to != address(0));
        vm.prank(minter);
        token.mint(to, amount);
        assertEq(token.balanceOf(to), amount);
        assertEq(token.totalSupply(), amount);
    }
}
