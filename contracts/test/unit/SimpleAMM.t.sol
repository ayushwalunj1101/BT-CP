// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {SimpleAMM} from "../../src/amm/SimpleAMM.sol";

contract SimpleAMMTest is Test {
    MockERC20 internal tkn;
    MockERC20 internal musd;
    SimpleAMM internal amm;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bot = makeAddr("bot");

    // Pool seeded at 100 mUSD per TKN.
    uint256 internal constant POOL_TKN = 100_000e18;
    uint256 internal constant POOL_MUSD = 10_000_000e18;

    function setUp() public {
        tkn = new MockERC20("Obscura Test Token", "TKN");
        musd = new MockERC20("Mock USD", "mUSD");
        amm = new SimpleAMM(tkn, musd);

        _fundAndApprove(lp, POOL_TKN, POOL_MUSD);
        vm.prank(lp);
        amm.addLiquidity(POOL_TKN, POOL_MUSD);

        _fundAndApprove(alice, 10_000e18, 1_000_000e18);
        _fundAndApprove(bot, 50_000e18, 5_000_000e18);
    }

    function _fundAndApprove(address who, uint256 tknAmount, uint256 musdAmount) internal {
        tkn.mint(who, tknAmount);
        musd.mint(who, musdAmount);
        vm.startPrank(who);
        tkn.approve(address(amm), type(uint256).max);
        musd.approve(address(amm), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- liquidity

    function test_AddLiquidity_UpdatesReserves() public view {
        assertEq(amm.reserve0(), POOL_TKN);
        assertEq(amm.reserve1(), POOL_MUSD);
        assertEq(tkn.balanceOf(address(amm)), POOL_TKN);
        assertEq(musd.balanceOf(address(amm)), POOL_MUSD);
    }

    function test_AddLiquidity_RevertsOnZero() public {
        vm.expectRevert(SimpleAMM.ZeroAmount.selector);
        amm.addLiquidity(0, 1);
    }

    function test_Constructor_RevertsOnIdenticalTokens() public {
        vm.expectRevert(SimpleAMM.IdenticalTokens.selector);
        new SimpleAMM(tkn, tkn);
    }

    // ---------------------------------------------------------------- swaps

    function test_Swap_BuyTknMatchesQuote() public {
        uint256 amountIn = 50_000e18;
        uint256 quoted = amm.getAmountOut(address(musd), amountIn);

        vm.prank(alice);
        uint256 out = amm.swapExactIn(address(musd), amountIn, quoted, alice);

        assertEq(out, quoted);
        assertEq(tkn.balanceOf(alice), 10_000e18 + out);
        assertEq(amm.reserve1(), POOL_MUSD + amountIn);
        assertEq(amm.reserve0(), POOL_TKN - out);
    }

    function test_Swap_SellTknMatchesQuote() public {
        uint256 amountIn = 500e18;
        uint256 quoted = amm.getAmountOut(address(tkn), amountIn);

        vm.prank(alice);
        uint256 out = amm.swapExactIn(address(tkn), amountIn, quoted, alice);

        assertEq(out, quoted);
        assertEq(musd.balanceOf(alice), 1_000_000e18 + out);
    }

    function test_Swap_ChargesFee() public view {
        // 1 TKN at a 100 mUSD price, with no price impact, would be 100 mUSD. The 0.3% fee keeps it below 99.7.
        uint256 out = amm.getAmountOut(address(tkn), 1e18);
        assertLt(out, 99.7e18);
        assertGt(out, 99.6e18);
    }

    function test_Swap_RevertsBelowMinOut() public {
        uint256 amountIn = 50_000e18;
        uint256 quoted = amm.getAmountOut(address(musd), amountIn);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SimpleAMM.SlippageExceeded.selector, quoted, quoted + 1));
        amm.swapExactIn(address(musd), amountIn, quoted + 1, alice);
    }

    function test_Swap_RevertsOnUnknownToken() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SimpleAMM.UnknownToken.selector, address(0xBEEF)));
        amm.swapExactIn(address(0xBEEF), 1e18, 0, alice);
    }

    function test_Swap_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(SimpleAMM.ZeroAmount.selector);
        amm.swapExactIn(address(tkn), 0, 0, alice);
    }

    function test_Swap_RevertsWithoutLiquidity() public {
        SimpleAMM empty = new SimpleAMM(tkn, musd);
        vm.expectRevert(SimpleAMM.NoLiquidity.selector);
        empty.getAmountOut(address(tkn), 1e18);
    }

    function testFuzz_Swap_KNeverDecreases(uint256 amountIn, bool buyTkn) public {
        address tokenIn = buyTkn ? address(musd) : address(tkn);
        amountIn = bound(amountIn, 1, buyTkn ? 1_000_000e18 : 10_000e18);
        uint256 kBefore = amm.reserve0() * amm.reserve1();

        vm.prank(alice);
        amm.swapExactIn(tokenIn, amountIn, 0, alice);

        assertGe(amm.reserve0() * amm.reserve1(), kBefore);
    }

    function testFuzz_Swap_ReservesMatchBalances(uint256 amountIn, bool buyTkn) public {
        address tokenIn = buyTkn ? address(musd) : address(tkn);
        amountIn = bound(amountIn, 1, buyTkn ? 1_000_000e18 : 10_000e18);

        vm.prank(alice);
        amm.swapExactIn(tokenIn, amountIn, 0, alice);

        assertEq(amm.reserve0(), tkn.balanceOf(address(amm)));
        assertEq(amm.reserve1(), musd.balanceOf(address(amm)));
    }

    // ---------------------------------------------------------------- the attack, on paper

    /// @notice The economics the Stage 1 bot relies on, with no mempool involved:
    ///         front-run, then the victim, then back-run, all in sequence on one pool.
    function test_Sandwich_ProfitsBotAndCostsVictim() public {
        uint256 victimIn = 50_000e18; // victim buys TKN with 50,000 mUSD
        uint256 fairOut = amm.getAmountOut(address(musd), victimIn);
        uint256 minOut = (fairOut * 99) / 100; // victim accepts up to 1% slippage

        uint256 botMusdBefore = musd.balanceOf(bot);

        // 1. Bot buys TKN first, pushing the price up, but not past the victim's 1% limit.
        vm.prank(bot);
        uint256 botTkn = amm.swapExactIn(address(musd), 40_000e18, 0, bot);

        // 2. Victim buys at the worse price, still within their 1% limit.
        vm.prank(alice);
        uint256 victimOut = amm.swapExactIn(address(musd), victimIn, minOut, alice);

        // 3. Bot sells the TKN back into the price the victim pushed up.
        vm.prank(bot);
        amm.swapExactIn(address(tkn), botTkn, 0, bot);

        uint256 botProfit = musd.balanceOf(bot) - botMusdBefore;
        uint256 victimLossBps = ((fairOut - victimOut) * 10_000) / fairOut;

        assertLt(victimOut, fairOut, "victim got less than the fair quote");
        assertGe(victimOut, minOut, "but still within their slippage limit");
        assertGt(botProfit, 0, "bot made money");
        emit log_named_uint("victim loss (bps)", victimLossBps);
        emit log_named_decimal_uint("bot profit (mUSD)", botProfit, 18);
    }

    /// @notice The victim's slippage limit caps the attack: push the price too far and the victim's
    ///         trade reverts, leaving the bot holding TKN with nothing to sell into.
    function test_Sandwich_OversizedFrontrunMakesVictimRevert() public {
        uint256 victimIn = 50_000e18;
        uint256 minOut = (amm.getAmountOut(address(musd), victimIn) * 99) / 100;

        vm.prank(bot);
        amm.swapExactIn(address(musd), 100_000e18, 0, bot);

        vm.prank(alice);
        vm.expectRevert(); // SlippageExceeded
        amm.swapExactIn(address(musd), victimIn, minOut, alice);
    }
}
