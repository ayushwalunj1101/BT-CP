// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clearing, Order} from "../../src/libraries/Clearing.sol";

/// @notice Each test breaks exactly one clearing rule, or shows a case that must be allowed.
contract ClearingTest is Test {
    address internal constant A = address(0xA);
    address internal constant B = address(0xB);
    address internal constant C = address(0xC);
    address internal constant D = address(0xD);

    /// Buyers A (10 at 105) and B (10 at 100); sellers C (10 at 95) and D (10 at 103).
    /// Any price from 100 to 103 clears it: A buys 10 from C, B and D do not trade.
    function _book() internal pure returns (Order[] memory orders) {
        orders = new Order[](4);
        orders[0] = Order(A, true, 105e18, 10e18);
        orders[1] = Order(B, true, 100e18, 10e18);
        orders[2] = Order(C, false, 95e18, 10e18);
        orders[3] = Order(D, false, 103e18, 10e18);
    }

    function _fills(uint128 a, uint128 b, uint128 c, uint128 d) internal pure returns (uint128[] memory f) {
        f = new uint128[](4);
        (f[0], f[1], f[2], f[3]) = (a, b, c, d);
    }

    // ---------------------------------------------------------------- valid

    function test_ValidAtOnePrice() public pure {
        (bool ok, uint256 volume) = Clearing.check(_book(), 101e18, _fills(10e18, 0, 10e18, 0));
        assertTrue(ok);
        assertEq(volume, 10e18);
    }

    function test_ValidAnywhereInTheClearingRange() public pure {
        uint128[] memory fills = _fills(10e18, 0, 10e18, 0);
        (bool atLow,) = Clearing.check(_book(), 100e18, fills); // B sits exactly at the price, unfilled
        (bool atHigh,) = Clearing.check(_book(), 103e18, fills); // D sits exactly at the price, unfilled
        assertTrue(atLow);
        assertTrue(atHigh);
    }

    function test_OrdersExactlyAtThePriceShareWhatIsLeft() public pure {
        // Two buyers at 100 want 20 in total; one seller below them offers 15. They split it.
        Order[] memory orders = new Order[](3);
        orders[0] = Order(A, true, 100e18, 10e18);
        orders[1] = Order(B, true, 100e18, 10e18);
        orders[2] = Order(C, false, 90e18, 15e18);
        uint128[] memory fills = new uint128[](3);
        (fills[0], fills[1], fills[2]) = (7.5e18, 7.5e18, 15e18);

        (bool ok, uint256 volume) = Clearing.check(orders, 100e18, fills);
        assertTrue(ok);
        assertEq(volume, 15e18);
    }

    function test_NoCrossingMeansNoTrades() public pure {
        Order[] memory orders = new Order[](2);
        orders[0] = Order(A, true, 90e18, 10e18);
        orders[1] = Order(C, false, 110e18, 10e18);
        (bool ok, uint256 volume) = Clearing.check(orders, 100e18, new uint128[](2));
        assertTrue(ok);
        assertEq(volume, 0);
    }

    // ---------------------------------------------------------------- invalid

    function test_RejectsBuyerFilledAboveTheirLimit() public pure {
        (bool ok,) = Clearing.check(_book(), 106e18, _fills(10e18, 0, 10e18, 0)); // A's limit is 105
        assertFalse(ok);
    }

    function test_RejectsSellerFilledBelowTheirLimit() public pure {
        (bool ok,) = Clearing.check(_book(), 101e18, _fills(10e18, 0, 0, 10e18)); // D's limit is 103
        assertFalse(ok);
    }

    function test_RejectsLeavingOutACrossingOrder() public pure {
        // At 101, A (limit 105) and C (limit 95) both cross. Filling nobody is censorship.
        (bool ok,) = Clearing.check(_book(), 101e18, _fills(0, 0, 0, 0));
        assertFalse(ok);
    }

    function test_RejectsMoreBoughtThanSold() public pure {
        (bool ok,) = Clearing.check(_book(), 100e18, _fills(10e18, 5e18, 10e18, 0)); // 15 bought, 10 sold
        assertFalse(ok);
    }

    function test_RejectsFillLargerThanTheOrder() public pure {
        (bool ok,) = Clearing.check(_book(), 101e18, _fills(11e18, 0, 11e18, 0));
        assertFalse(ok);
    }

    function test_RejectsZeroPrice() public pure {
        (bool ok,) = Clearing.check(_book(), 0, _fills(0, 0, 0, 0));
        assertFalse(ok);
    }

    function test_RejectsPriceAboveUint128() public pure {
        (bool ok,) = Clearing.check(_book(), uint256(type(uint128).max) + 1, _fills(0, 0, 0, 0));
        assertFalse(ok);
    }

    function test_RejectsWrongNumberOfFills() public pure {
        (bool ok,) = Clearing.check(_book(), 101e18, new uint128[](3));
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- rounding

    function test_QuoteRounding() public pure {
        // 1 wei of TKN at 1.5 mUSD: a buyer pays 2 wei, a seller receives 1 wei.
        assertEq(Clearing.quoteUp(1, 1.5e18), 2);
        assertEq(Clearing.quoteDown(1, 1.5e18), 1);
        assertEq(Clearing.quoteUp(10e18, 101e18), 1010e18); // exact amounts are not rounded
        assertEq(Clearing.quoteDown(10e18, 101e18), 1010e18);
    }
}
