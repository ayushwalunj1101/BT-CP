// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {ObscuraBase} from "../../src/ObscuraBase.sol";
import {ObscuraAuction} from "../../src/ObscuraAuction.sol";
import {ObscuraHandler} from "./ObscuraHandler.sol";

/// @title Invariant campaign (feature F11)
/// @notice The fuzzer calls random handler actions in random order. After every single call, each
///         invariant_* function below must still hold. I1 to I4 are the same checks the bounty vault pays on;
///         the ghost_* invariants compare the contract with bookkeeping it cannot influence.
contract ObscuraInvariantsTest is Test {
    uint256 internal constant FEE_POOL_SEED = 1_000_000e18;

    MockERC20 internal tkn;
    MockERC20 internal musd;
    ObscuraAuction internal auction;
    ObscuraHandler internal handler;

    function setUp() public {
        tkn = new MockERC20("Obscura Test Token", "TKN");
        musd = new MockERC20("Mock USD", "mUSD");
        // Short windows (commit 3, reveal 2, solve 2 blocks) so random runs reach settlement often.
        auction =
            new ObscuraAuction(tkn, musd, ObscuraBase.Config(3, 2, 2, 0.01 ether, 1 ether, 10e18, 16, 3));
        musd.mint(address(this), FEE_POOL_SEED);
        musd.approve(address(auction), FEE_POOL_SEED);
        auction.fundFeePool(FEE_POOL_SEED);

        handler = new ObscuraHandler(auction, tkn, musd);
        bytes4[] memory actions = new bytes4[](13);
        actions[0] = ObscuraHandler.deposit.selector;
        actions[1] = ObscuraHandler.withdraw.selector;
        actions[2] = ObscuraHandler.commit.selector;
        actions[3] = ObscuraHandler.reveal.selector;
        actions[4] = ObscuraHandler.submitHonest.selector;
        actions[5] = ObscuraHandler.submitCorrupt.selector;
        actions[6] = ObscuraHandler.settle.selector;
        actions[7] = ObscuraHandler.withdrawEth.selector;
        actions[8] = ObscuraHandler.advance.selector;
        actions[9] = ObscuraHandler.donate.selector;
        actions[10] = ObscuraHandler.nextPhase.selector;
        actions[11] = ObscuraHandler.revealAll.selector;
        actions[12] = ObscuraHandler.fullBatch.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: actions}));
        targetContract(address(handler));
    }

    // ================================================================ the four rules

    function invariant_I1_conservation() public view {
        assertTrue(auction.checkI1(), "I1: contract holds less than its ledger owes");
    }

    function invariant_I2_uniformPrice() public view {
        uint256 n = handler.settledCount();
        for (uint256 i; i < n; ++i) {
            assertTrue(auction.checkI2(handler.settledEpochs(i)), "I2: a fill used a different price");
        }
    }

    function invariant_I3_limitRespect() public view {
        uint256 n = handler.settledCount();
        for (uint256 i; i < n; ++i) {
            assertTrue(auction.checkI3(handler.settledEpochs(i)), "I3: a fill was worse than its limit");
        }
    }

    function invariant_I4_solverHonesty() public view {
        uint256 n = handler.settledCount();
        for (uint256 i; i < n; ++i) {
            assertTrue(auction.checkI4(handler.settledEpochs(i)), "I4: a solver took more than its reward");
        }
    }

    // ================================================================ independent bookkeeping

    /// Every token the contract holds is explained by deposits, withdrawals, donations and the fee seed.
    function invariant_ghost_tokensMatchTheHistory() public view {
        assertEq(
            tkn.balanceOf(address(auction)),
            handler.ghostDeposited(address(tkn)) - handler.ghostWithdrawn(address(tkn))
                + handler.ghostDonated(address(tkn))
        );
        assertEq(
            musd.balanceOf(address(auction)),
            FEE_POOL_SEED + handler.ghostDeposited(address(musd)) - handler.ghostWithdrawn(address(musd))
                + handler.ghostDonated(address(musd))
        );
        assertEq(
            address(auction).balance, handler.ghostEthIn() - handler.ghostEthOut() + handler.ghostEthDonated()
        );
    }

    /// Stronger than I1: leaving donations aside, the ledger owes exactly what came in minus what went out.
    function invariant_ghost_ledgerIsExact() public view {
        address t = address(tkn);
        address m = address(musd);
        assertEq(
            auction.totalFree(t) + auction.totalLocked(t),
            handler.ghostDeposited(t) - handler.ghostWithdrawn(t)
        );
        assertEq(
            auction.totalFree(m) + auction.totalLocked(m) + auction.feePool(),
            FEE_POOL_SEED + handler.ghostDeposited(m) - handler.ghostWithdrawn(m)
        );
        assertEq(
            auction.bondsHeld() + auction.totalClaimableEth() + auction.treasuryEth(),
            handler.ghostEthIn() - handler.ghostEthOut()
        );
    }

    /// The per-person balances add up to the contract's totals, so no balance exists outside the totals.
    function invariant_ghost_balancesAddUpToTotals() public view {
        address[] memory everyone = handler.actors();
        address[2] memory tokens = [address(tkn), address(musd)];
        for (uint256 k; k < 2; ++k) {
            uint256 free;
            uint256 locked;
            for (uint256 i; i < everyone.length; ++i) {
                free += auction.freeBalance(everyone[i], tokens[k]);
                locked += auction.lockedBalance(everyone[i], tokens[k]);
            }
            assertEq(free, auction.totalFree(tokens[k]));
            assertEq(locked, auction.totalLocked(tokens[k]));
        }
        uint256 claimable;
        for (uint256 i; i < everyone.length; ++i) {
            claimable += auction.claimableEth(everyone[i]);
        }
        assertEq(claimable, auction.totalClaimableEth());
    }

    // ================================================================ the handler can reach settlement

    /// @notice A scripted path through the handler: a crossing buy and sell, revealed, solved honestly and
    ///         settled. Shows the fuzzer's actions can reach a real trade, so passing invariants mean something.
    function test_HandlerReachesASettledTrade() public {
        handler.commit(0, true, 20, 10e18 + 1); // buy, limit 106, 11 TKN... amounts are bounded inside
        handler.commit(1, false, 4, 10e18 + 1); // sell, limit 92
        handler.nextPhase();
        handler.revealAll(10);
        handler.reveal(0);
        handler.reveal(1);
        handler.nextPhase();
        handler.submitHonest(0);
        handler.nextPhase();
        handler.settle();

        assertEq(handler.calls("settledWithTrades"), 1, "one batch settled with a trade");
        uint256 epoch = handler.settledEpochs(0);
        (uint256 price, uint256 volume,,,) = auction.results(epoch);
        assertGt(volume, 0);
        assertTrue(price >= 92e18 && price <= 106e18);
        assertTrue(auction.checkI2(epoch) && auction.checkI3(epoch) && auction.checkI4(epoch));
    }

    // ================================================================ campaign statistics

    /// @dev After each run, optionally append how far the run got, for the fuzz report (FUZZ_STATS=true).
    function afterInvariant() external {
        if (!vm.envOr("FUZZ_STATS", false)) return;
        string memory line = string.concat(
            vm.toString(handler.calls("commit")),
            ",",
            vm.toString(handler.calls("reveal")),
            ",",
            vm.toString(handler.calls("submitHonest")),
            ",",
            vm.toString(handler.calls("submitCorrupt")),
            ",",
            vm.toString(handler.calls("settle")),
            ",",
            vm.toString(handler.calls("settledWithTrades")),
            ",",
            vm.toString(handler.calls("voided")),
            ",",
            vm.toString(
                handler.calls("deposit") + handler.calls("withdraw") + handler.calls("withdrawEth")
                    + handler.calls("advance") + handler.calls("donate")
            )
        );
        vm.writeLine(vm.envString("FUZZ_STATS_FILE"), line);
    }
}
