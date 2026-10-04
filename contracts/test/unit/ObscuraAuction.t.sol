// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {ObscuraBase} from "../../src/ObscuraBase.sol";
import {ObscuraAuction} from "../../src/ObscuraAuction.sol";
import {Clearing, Fill, Order} from "../../src/libraries/Clearing.sol";

contract ObscuraAuctionTest is Test {
    uint64 internal constant COMMIT = 5;
    uint64 internal constant REVEAL = 3;
    uint64 internal constant SOLVE = 3;
    uint256 internal constant REVEAL_BOND = 0.01 ether;
    uint256 internal constant SOLVER_BOND = 1 ether;
    uint256 internal constant REWARD = 10e18;

    MockERC20 internal tkn;
    MockERC20 internal musd;
    ObscuraAuction internal auction;

    address internal alice = makeAddr("alice"); // buys 10 at 105
    address internal bob = makeAddr("bob"); // buys 10 at 100
    address internal carol = makeAddr("carol"); // sells 10 at 95
    address internal dave = makeAddr("dave"); // sells 10 at 103
    address internal solver = makeAddr("solver");
    address internal keeper = makeAddr("keeper"); // calls settle()
    address internal mallory = makeAddr("mallory");

    uint256 internal saltNonce;

    struct Placed {
        address trader;
        uint256 index;
        bool isBuy;
        uint128 limit;
        uint128 amount;
        bytes32 salt;
    }

    function setUp() public {
        tkn = new MockERC20("Obscura Test Token", "TKN");
        musd = new MockERC20("Mock USD", "mUSD");
        auction = _deploy(8, 2);

        address[6] memory everyone = [alice, bob, carol, dave, solver, mallory];
        for (uint256 i; i < everyone.length; ++i) {
            _fund(everyone[i], 1_000e18, 100_000e18);
        }
        vm.deal(keeper, 1 ether);

        musd.mint(address(this), 1_000e18);
        musd.approve(address(auction), type(uint256).max);
        auction.fundFeePool(1_000e18);
    }

    // ================================================================ helpers

    function _deploy(uint256 maxOrders, uint256 maxSolutions) internal returns (ObscuraAuction) {
        return new ObscuraAuction(
            tkn,
            musd,
            ObscuraBase.Config({
                commitBlocks: COMMIT,
                revealBlocks: REVEAL,
                solveBlocks: SOLVE,
                revealBond: REVEAL_BOND,
                solverBond: SOLVER_BOND,
                solverReward: REWARD,
                maxOrders: maxOrders,
                maxSolutions: maxSolutions
            })
        );
    }

    /// Mints tokens, approves the auction, deposits them all, and gives some ETH for bonds.
    function _fund(address who, uint256 tknAmount, uint256 musdAmount) internal {
        tkn.mint(who, tknAmount);
        musd.mint(who, musdAmount);
        vm.deal(who, 10 ether);
        vm.startPrank(who);
        tkn.approve(address(auction), type(uint256).max);
        musd.approve(address(auction), type(uint256).max);
        if (tknAmount > 0) auction.deposit(address(tkn), tknAmount);
        if (musdAmount > 0) auction.deposit(address(musd), musdAmount);
        vm.stopPrank();
    }

    function _rollTo(uint256 epoch, ObscuraBase.Phase phase) internal {
        uint256 start = auction.epochStartBlock(epoch);
        if (phase == ObscuraBase.Phase.Commit) vm.roll(start);
        else if (phase == ObscuraBase.Phase.Reveal) vm.roll(start + COMMIT);
        else if (phase == ObscuraBase.Phase.Solve) vm.roll(start + COMMIT + REVEAL);
        else vm.roll(start + COMMIT + REVEAL + SOLVE);
    }

    function _commit(address trader, bool isBuy, uint128 limit, uint128 amount)
        internal
        returns (Placed memory p)
    {
        uint256 epoch = auction.currentEpoch();
        bytes32 salt = keccak256(abi.encode(trader, ++saltNonce));
        bytes32 hash = auction.commitmentHash(trader, epoch, isBuy, limit, amount, salt);
        vm.prank(trader);
        uint256 index = auction.commit{value: REVEAL_BOND}(epoch, hash);
        p = Placed(trader, index, isBuy, limit, amount, salt);
    }

    function _reveal(uint256 epoch, Placed memory p) internal {
        vm.prank(p.trader);
        auction.reveal(epoch, p.index, p.isBuy, p.limit, p.amount, p.salt);
    }

    /// The four-order book from Clearing.t.sol, committed and revealed in epoch 0 (in that order).
    function _standardBook() internal returns (Placed[4] memory book) {
        _rollTo(0, ObscuraBase.Phase.Commit);
        book[0] = _commit(alice, true, 105e18, 10e18);
        book[1] = _commit(bob, true, 100e18, 10e18);
        book[2] = _commit(carol, false, 95e18, 10e18);
        book[3] = _commit(dave, false, 103e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        for (uint256 i; i < 4; ++i) {
            _reveal(0, book[i]);
        }
    }

    function _fills(uint128 a, uint128 b, uint128 c, uint128 d) internal pure returns (uint128[] memory f) {
        f = new uint128[](4);
        (f[0], f[1], f[2], f[3]) = (a, b, c, d);
    }

    function _submit(address who, uint256 epoch, uint256 price, uint128[] memory fills) internal {
        vm.prank(who);
        auction.submitSolution{value: SOLVER_BOND}(epoch, price, fills);
    }

    function _settle(uint256 epoch) internal {
        vm.prank(keeper);
        auction.settle(epoch);
    }

    function _free(address who, MockERC20 token) internal view returns (uint256) {
        return auction.freeBalance(who, address(token));
    }

    /// No token or ETH is created or lost: what the contract holds equals everything it owes.
    function _assertConservation() internal view {
        assertEq(
            tkn.balanceOf(address(auction)),
            auction.totalFree(address(tkn)) + auction.totalLocked(address(tkn)),
            "TKN conservation"
        );
        assertEq(
            musd.balanceOf(address(auction)),
            auction.totalFree(address(musd)) + auction.totalLocked(address(musd)) + auction.feePool(),
            "mUSD conservation"
        );
        assertEq(
            address(auction).balance,
            auction.bondsHeld() + auction.totalClaimableEth() + auction.treasuryEth(),
            "ETH conservation"
        );
    }

    // ================================================================ config and ledger

    function test_Constructor_RejectsBadConfig() public {
        vm.expectRevert(ObscuraBase.InvalidConfig.selector);
        new ObscuraAuction(
            tkn, tkn, ObscuraBase.Config(COMMIT, REVEAL, SOLVE, REVEAL_BOND, SOLVER_BOND, REWARD, 8, 2)
        );
        vm.expectRevert(ObscuraBase.InvalidConfig.selector);
        new ObscuraAuction(
            tkn, musd, ObscuraBase.Config(0, REVEAL, SOLVE, REVEAL_BOND, SOLVER_BOND, REWARD, 8, 2)
        );
    }

    function test_Deposit_CreditsFreeBalance() public view {
        assertEq(_free(alice, tkn), 1_000e18);
        assertEq(_free(alice, musd), 100_000e18);
        _assertConservation();
    }

    function test_Withdraw_ReturnsFreeTokens() public {
        vm.prank(alice);
        auction.withdraw(address(musd), 40_000e18);
        assertEq(musd.balanceOf(alice), 40_000e18);
        assertEq(_free(alice, musd), 60_000e18);
        _assertConservation();
    }

    function test_Withdraw_RevertsBeyondFreeBalance() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.InsufficientBalance.selector, 1_000e18, 1_001e18));
        auction.withdraw(address(tkn), 1_001e18);
    }

    function test_Ledger_RejectsUnknownTokenAndZero() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.UnknownToken.selector, address(0xBEEF)));
        auction.deposit(address(0xBEEF), 1);
        vm.expectRevert(ObscuraBase.ZeroAmount.selector);
        auction.deposit(address(tkn), 0);
        vm.expectRevert(ObscuraBase.ZeroAmount.selector);
        auction.withdraw(address(tkn), 0);
        vm.expectRevert(ObscuraBase.ZeroAmount.selector);
        auction.fundFeePool(0);
        vm.stopPrank();
    }

    function test_Withdraw_CannotTouchLockedFunds() public {
        _standardBook(); // alice locked 1,050 mUSD behind her buy
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ObscuraBase.InsufficientBalance.selector, 98_950e18, 100_000e18)
        );
        auction.withdraw(address(musd), 100_000e18);
    }

    // ================================================================ epoch clock

    function test_PhasesFollowTheBlockWindows() public {
        uint256 start = auction.epochStartBlock(0);
        vm.roll(start);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Commit));
        assertEq(uint8(auction.phaseOf(1)), uint8(ObscuraBase.Phase.NotStarted));
        vm.roll(start + COMMIT - 1);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Commit));
        vm.roll(start + COMMIT);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Reveal));
        vm.roll(start + COMMIT + REVEAL);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Solve));
        vm.roll(start + COMMIT + REVEAL + SOLVE);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Settleable));
        assertEq(uint8(auction.phaseOf(1)), uint8(ObscuraBase.Phase.Commit)); // batches run back to back
        assertEq(auction.currentEpoch(), 1);
    }

    // ================================================================ commit

    function test_Commit_StoresOnlyTheHash() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        ObscuraAuction.Commitment[] memory list = auction.getCommitments(0);
        assertEq(list.length, 1);
        assertEq(list[0].trader, alice);
        assertEq(list[0].hash, auction.commitmentHash(alice, 0, true, 105e18, 10e18, p.salt));
        assertFalse(list[0].revealed);
        assertEq(auction.bondsHeld(), REVEAL_BOND);
        assertEq(_free(alice, musd), 100_000e18); // nothing locked yet: the commit moves no trading funds
        _assertConservation();
    }

    function test_Commit_RevertsOutsideTheCommitWindow() public {
        _rollTo(0, ObscuraBase.Phase.Reveal);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 0, ObscuraBase.Phase.Reveal));
        auction.commit{value: REVEAL_BOND}(0, bytes32(0));
    }

    function test_Commit_RevertsForAnotherEpoch() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 1, ObscuraBase.Phase.NotStarted)
        );
        auction.commit{value: REVEAL_BOND}(1, bytes32(0));
    }

    function test_Commit_RevertsWithTheWrongBond() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuction.WrongBond.selector, 0, REVEAL_BOND));
        auction.commit(0, bytes32(0));
    }

    function test_Commit_RevertsWhenTheBatchIsFull() public {
        for (uint256 i; i < 8; ++i) {
            _commit(alice, true, 100e18, 1e18);
        }
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuction.BatchFull.selector, 0));
        auction.commit{value: REVEAL_BOND}(0, bytes32(0));
    }

    // ================================================================ reveal

    function test_Reveal_LocksFundsAndReturnsTheBond() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        uint256 ethBefore = alice.balance;
        _reveal(0, p);

        assertEq(auction.lockedBalance(alice, address(musd)), 1_050e18);
        assertEq(_free(alice, musd), 98_950e18);
        assertEq(alice.balance, ethBefore + REVEAL_BOND);
        Order[] memory orders = auction.getOrders(0);
        assertEq(orders.length, 1);
        assertEq(orders[0].limitPrice, 105e18);
        _assertConservation();
    }

    function test_Reveal_RevertsOnTheWrongSalt() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        vm.prank(alice);
        vm.expectRevert(ObscuraAuction.CommitmentMismatch.selector);
        auction.reveal(0, p.index, true, 105e18, 10e18, bytes32(uint256(p.salt) + 1));
    }

    function test_Reveal_RevertsOnADifferentOrder() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        vm.prank(alice);
        vm.expectRevert(ObscuraAuction.CommitmentMismatch.selector);
        auction.reveal(0, p.index, true, 104e18, 10e18, p.salt); // tries to change the limit after seeing others
    }

    function test_Reveal_RevertsForSomeoneElsesCommitment() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        vm.prank(mallory);
        vm.expectRevert(ObscuraAuction.NotYourCommitment.selector);
        auction.reveal(0, p.index, true, 105e18, 10e18, p.salt);
    }

    /// @notice Attack A8: Mallory copies Alice's commitment into her own slot, then replays Alice's
    ///         reveal. The trader's address is inside the hash, so the copy can never be opened.
    function test_CopiedCommitmentCannotBeRevealed() public {
        Placed memory original = _commit(alice, true, 105e18, 10e18);
        bytes32 aliceHash = auction.getCommitments(0)[0].hash;
        vm.prank(mallory);
        uint256 copyIndex = auction.commit{value: REVEAL_BOND}(0, aliceHash);

        _rollTo(0, ObscuraBase.Phase.Reveal);
        _reveal(0, original);
        vm.prank(mallory);
        vm.expectRevert(ObscuraAuction.CommitmentMismatch.selector);
        auction.reveal(0, copyIndex, true, 105e18, 10e18, original.salt);
    }

    function test_Reveal_RevertsTwice() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        _reveal(0, p);
        vm.prank(alice);
        vm.expectRevert(ObscuraAuction.AlreadyRevealed.selector);
        auction.reveal(0, p.index, true, 105e18, 10e18, p.salt);
    }

    function test_Reveal_RevertsForAnUnknownIndex() public {
        _rollTo(0, ObscuraBase.Phase.Reveal);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuction.UnknownCommitment.selector, 0, 3));
        auction.reveal(0, 3, true, 105e18, 10e18, bytes32(0));
    }

    function test_Reveal_RevertsOutsideTheRevealWindow() public {
        Placed memory p = _commit(alice, true, 105e18, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 0, ObscuraBase.Phase.Commit));
        auction.reveal(0, p.index, true, 105e18, 10e18, p.salt);
    }

    function test_Reveal_RejectsAnEmptyOrder() public {
        Placed memory p = _commit(alice, true, 105e18, 0);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        vm.expectRevert(ObscuraAuction.InvalidOrder.selector);
        _reveal(0, p);
    }

    function test_Reveal_NeedsEnoughFreeBalanceButCanRetry() public {
        address poor = makeAddr("poor");
        _fund(poor, 0, 100e18);
        Placed memory p = _commit(poor, true, 105e18, 10e18); // needs 1,050 mUSD
        _rollTo(0, ObscuraBase.Phase.Reveal);

        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.InsufficientBalance.selector, 100e18, 1_050e18));
        _reveal(0, p);

        musd.mint(poor, 950e18);
        vm.prank(poor);
        auction.deposit(address(musd), 950e18);
        _reveal(0, p); // still inside the reveal window, so it works now
        assertEq(auction.lockedBalance(poor, address(musd)), 1_050e18);
    }

    // ================================================================ solve

    function test_Submit_RevertsOutsideTheSolveWindow() public {
        _standardBook();
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 0, ObscuraBase.Phase.Reveal));
        auction.submitSolution{value: SOLVER_BOND}(0, 101e18, _fills(10e18, 0, 10e18, 0));
    }

    function test_Submit_ChecksBondFillCountAndCapacity() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        vm.startPrank(solver);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuction.WrongBond.selector, 0, SOLVER_BOND));
        auction.submitSolution(0, 101e18, _fills(10e18, 0, 10e18, 0));
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuction.WrongFillCount.selector, 3, 4));
        auction.submitSolution{value: SOLVER_BOND}(0, 101e18, new uint128[](3));
        auction.submitSolution{value: SOLVER_BOND}(0, 101e18, _fills(10e18, 0, 10e18, 0));
        auction.submitSolution{value: SOLVER_BOND}(0, 102e18, _fills(10e18, 0, 10e18, 0));
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuction.TooManySolutions.selector, 0));
        auction.submitSolution{value: SOLVER_BOND}(0, 101e18, _fills(10e18, 0, 10e18, 0));
        vm.stopPrank();
        assertEq(auction.solutionCount(0), 2);
        assertEq(auction.getSolution(0, 1).price, 102e18);
    }

    // ================================================================ settle

    function test_Settle_EveryoneTradesAtOnePrice() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(solver, 0, 101e18, _fills(10e18, 0, 10e18, 0));
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        // Alice bought 10 TKN for 1,010 mUSD; the rest of her locked 1,050 came back.
        assertEq(_free(alice, tkn), 1_010e18);
        assertEq(_free(alice, musd), 100_000e18 - 1_010e18);
        // Carol sold 10 TKN and received 1,010 mUSD.
        assertEq(_free(carol, tkn), 990e18);
        assertEq(_free(carol, musd), 100_000e18 + 1_010e18);
        // Bob and Dave did not trade; everything they locked is free again.
        assertEq(_free(bob, musd), 100_000e18);
        assertEq(_free(dave, tkn), 1_000e18);
        assertEq(auction.totalLocked(address(musd)), 0);
        assertEq(auction.totalLocked(address(tkn)), 0);

        // The solver earned its reward and gets its bond back.
        assertEq(_free(solver, musd), 100_000e18 + REWARD);
        assertEq(auction.claimableEth(solver), SOLVER_BOND);

        (uint256 price, uint256 volume, address winner) = auction.results(0);
        assertEq(price, 101e18);
        assertEq(volume, 10e18);
        assertEq(winner, solver);
        Fill[] memory fills = auction.getFills(0);
        assertEq(fills.length, 2);
        assertEq(fills[0].quoteAmount, fills[1].quoteAmount); // same price for both sides
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Settled));
        _assertConservation();
    }

    function test_Settle_SlashesAnInvalidSolution() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(mallory, 0, 101e18, _fills(0, 0, 0, 0)); // leaves out Alice and Carol: censorship
        _submit(solver, 0, 101e18, _fills(10e18, 0, 10e18, 0));
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        assertEq(auction.claimableEth(keeper), SOLVER_BOND / 2, "half to whoever exposed it");
        assertEq(auction.treasuryEth(), SOLVER_BOND / 2, "half burned");
        assertEq(auction.claimableEth(mallory), 0);
        (,, address winner) = auction.results(0);
        assertEq(winner, solver);
        _assertConservation();
    }

    /// @notice A cheating solver that calls settle() itself still loses half its bond.
    function test_Settle_SelfSlashingStillCostsHalf() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(mallory, 0, 101e18, _fills(0, 0, 0, 0));
        _rollTo(0, ObscuraBase.Phase.Settleable);
        vm.prank(mallory);
        auction.settle(0);
        assertEq(auction.claimableEth(mallory), SOLVER_BOND / 2);
        assertEq(auction.treasuryEth(), SOLVER_BOND / 2);
    }

    function test_Settle_PicksTheSolutionWithTheMostVolume() public {
        // A buyer and a seller both exactly at 100: any volume from 0 to 10 is valid, so solvers can differ.
        _rollTo(0, ObscuraBase.Phase.Commit);
        Placed memory buy = _commit(alice, true, 100e18, 10e18);
        Placed memory sell = _commit(carol, false, 100e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        _reveal(0, buy);
        _reveal(0, sell);
        _rollTo(0, ObscuraBase.Phase.Solve);
        uint128[] memory small = new uint128[](2);
        (small[0], small[1]) = (4e18, 4e18);
        uint128[] memory full = new uint128[](2);
        (full[0], full[1]) = (10e18, 10e18);
        _submit(mallory, 0, 100e18, small);
        _submit(solver, 0, 100e18, full);
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        (, uint256 volume, address winner) = auction.results(0);
        assertEq(volume, 10e18);
        assertEq(winner, solver);
        assertEq(
            auction.claimableEth(mallory),
            SOLVER_BOND,
            "a valid but smaller solution is refunded, not slashed"
        );
        _assertConservation();
    }

    function test_Settle_VoidsTheBatchWhenNoSolutionIsValid() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(mallory, 0, 106e18, _fills(10e18, 0, 10e18, 0)); // Alice above her limit
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Voided));
        assertEq(auction.totalLocked(address(musd)), 0);
        assertEq(auction.totalLocked(address(tkn)), 0);
        assertEq(_free(alice, musd), 100_000e18);
        _assertConservation();
    }

    function test_Settle_VoidsTheBatchWhenNobodySolves() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Voided));
        assertEq(_free(carol, tkn), 1_000e18);
        _assertConservation();
    }

    function test_Settle_ForfeitsTheBondOfAnUnrevealedOrder() public {
        _rollTo(0, ObscuraBase.Phase.Commit);
        _commit(alice, true, 105e18, 10e18); // Alice never reveals: the free-option attack (A1)
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);
        assertEq(auction.treasuryEth(), REVEAL_BOND);
        assertEq(auction.bondsHeld(), 0);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Settled)); // nothing revealed, nothing to clear
        _assertConservation();
    }

    function test_Settle_RevertsBeforeTheSolveWindowEndsAndTwice() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 0, ObscuraBase.Phase.Solve));
        auction.settle(0);
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 0, ObscuraBase.Phase.Voided));
        auction.settle(0);
    }

    function test_Settle_NoTradesMeansNoReward() public {
        _rollTo(0, ObscuraBase.Phase.Commit);
        Placed memory buy = _commit(alice, true, 90e18, 10e18);
        Placed memory sell = _commit(carol, false, 110e18, 10e18);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        _reveal(0, buy);
        _reveal(0, sell);
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(solver, 0, 100e18, new uint128[](2));
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Settled));
        assertEq(_free(solver, musd), 100_000e18, "no reward for an empty batch");
        assertEq(_free(alice, musd), 100_000e18);
        _assertConservation();
    }

    function test_Settle_RoundingDustGoesToTheFeePool() public {
        // 1 wei of TKN at 1.5 mUSD: the buyer pays 2 wei, the seller receives 1 wei, 1 wei of dust remains.
        _rollTo(0, ObscuraBase.Phase.Commit);
        Placed memory buy = _commit(alice, true, 2e18, 1);
        Placed memory sell = _commit(carol, false, 1e18, 1);
        _rollTo(0, ObscuraBase.Phase.Reveal);
        _reveal(0, buy);
        _reveal(0, sell);
        _rollTo(0, ObscuraBase.Phase.Solve);
        uint128[] memory fills = new uint128[](2);
        (fills[0], fills[1]) = (1, 1);
        _submit(solver, 0, 1.5e18, fills);
        uint256 poolBefore = auction.feePool();
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        assertEq(_free(alice, musd), 100_000e18 - 2);
        assertEq(_free(carol, musd), 100_000e18 + 1);
        assertEq(auction.feePool(), poolBefore + 1 - REWARD);
        _assertConservation();
    }

    function test_WithdrawEth_PaysWhatIsOwed() public {
        _standardBook();
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(solver, 0, 101e18, _fills(10e18, 0, 10e18, 0));
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);

        uint256 before = solver.balance;
        vm.prank(solver);
        auction.withdrawEth();
        assertEq(solver.balance, before + SOLVER_BOND);
        vm.prank(solver);
        vm.expectRevert(ObscuraBase.NothingToWithdraw.selector);
        auction.withdrawEth();
        _assertConservation();
    }

    // ================================================================ the property that defeats sandwiches

    /// @notice The same orders, revealed in opposite orders in two batches, give every trader exactly the
    ///         same result. Position in the batch is worth nothing, so there is nothing to front-run.
    function test_RevealOrderChangesNobodysResult() public {
        Placed[4] memory first = _standardBook(); // revealed alice, bob, carol, dave
        _rollTo(0, ObscuraBase.Phase.Solve);
        _submit(solver, 0, 101e18, _fills(10e18, 0, 10e18, 0));
        _rollTo(0, ObscuraBase.Phase.Settleable);
        _settle(0);
        int256[4] memory deltaFirst = _musdDeltas(first, 100_000e18);

        // Epoch 1: identical orders, revealed in reverse.
        Placed[4] memory second;
        _rollTo(1, ObscuraBase.Phase.Commit);
        second[0] = _commit(alice, true, 105e18, 10e18);
        second[1] = _commit(bob, true, 100e18, 10e18);
        second[2] = _commit(carol, false, 95e18, 10e18);
        second[3] = _commit(dave, false, 103e18, 10e18);
        uint256[4] memory before;
        for (uint256 i; i < 4; ++i) {
            before[i] = _free(second[i].trader, musd);
        }
        _rollTo(1, ObscuraBase.Phase.Reveal);
        for (uint256 i = 4; i > 0; --i) {
            _reveal(1, second[i - 1]);
        }
        _rollTo(1, ObscuraBase.Phase.Solve);
        _submit(solver, 1, 101e18, _fills(0, 10e18, 0, 10e18)); // fills follow reveal order: dave, carol, bob, alice
        _rollTo(1, ObscuraBase.Phase.Settleable);
        _settle(1);

        for (uint256 i; i < 4; ++i) {
            int256 deltaSecond = int256(_free(second[i].trader, musd)) - int256(before[i]);
            assertEq(deltaSecond, deltaFirst[i], "same trader, same result, whatever the order");
        }
        _assertConservation();
    }

    function _musdDeltas(Placed[4] memory book, uint256 start)
        internal
        view
        returns (int256[4] memory deltas)
    {
        for (uint256 i; i < 4; ++i) {
            deltas[i] = int256(_free(book[i].trader, musd)) - int256(start);
        }
    }

    // ================================================================ gas

    /// @notice Settlement cost against batch size, for the report. Every order crosses and fills.
    function test_Gas_SettleScalesLinearly() public {
        uint256[4] memory sizes = [uint256(8), 16, 32, 64];
        for (uint256 s; s < sizes.length; ++s) {
            uint256 n = sizes[s];
            auction = _deploy(64, 4);
            vm.roll(auction.epochStartBlock(0));
            Placed[] memory placed = new Placed[](n);
            for (uint256 i; i < n; ++i) {
                address trader = makeAddr(string(abi.encodePacked("trader", vm.toString(i))));
                _fund(trader, 10e18, 1_000e18);
                bool isBuy = i % 2 == 0;
                placed[i] = _commit(trader, isBuy, isBuy ? 101e18 : 99e18, 1e18);
            }
            _rollTo(0, ObscuraBase.Phase.Reveal);
            for (uint256 i; i < n; ++i) {
                _reveal(0, placed[i]);
            }
            _rollTo(0, ObscuraBase.Phase.Solve);
            uint128[] memory fills = new uint128[](n);
            for (uint256 i; i < n; ++i) {
                fills[i] = 1e18;
            }
            _submit(solver, 0, 100e18, fills);
            _rollTo(0, ObscuraBase.Phase.Settleable);

            uint256 gasBefore = gasleft();
            _settle(0);
            uint256 used = gasBefore - gasleft();
            emit log_named_uint(string(abi.encodePacked("settle gas, orders = ", vm.toString(n))), used);
            assertLt(used, 15_000_000, "fits comfortably in a block");
        }
    }
}
