// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {ObscuraBase} from "../../src/ObscuraBase.sol";
import {ObscuraAuctionZK} from "../../src/ObscuraAuctionZK.sol";
import {ClearingVerifier} from "../../src/zk/ClearingVerifier.sol";
import {IClearingVerifier} from "../../src/interfaces/IClearingVerifier.sol";
import {Fill} from "../../src/libraries/Clearing.sol";

/// @notice A 16-order batch settled from a real Groth16 proof (contracts/test/fixtures/zk-batch.json, made by
///         circuits/clearing/fixture.ts). No order is ever revealed. Slot 14 is an unfunded buyer whose order
///         must not trade; slot 15's trader never sent their order to the solver, so it is left out.
contract ObscuraAuctionZKTest is Test {
    uint256 internal constant N = 16;
    uint256 internal constant BOND = 0.01 ether;
    uint256 internal constant REWARD = 10e18;
    uint256 internal constant LOT = 1e15;
    uint256 internal constant QUOTE_UNIT = 1e13;

    MockERC20 internal tkn;
    MockERC20 internal musd;
    ObscuraAuctionZK internal auction;

    address[N] internal traders;
    uint256[N] internal depositBase;
    uint256[N] internal depositQuote;
    uint256[N] internal commitments;
    bool[N] internal isBuy;
    uint256[16] internal fillsLots;
    uint256[16] internal fillEnc;
    uint256[16] internal included;
    uint256 internal priceTicks;
    uint256[2] internal pA;
    uint256[2][2] internal pB;
    uint256[2] internal pC;

    function setUp() public {
        tkn = new MockERC20("Obscura Test Token", "TKN");
        musd = new MockERC20("Mock USD", "mUSD");
        auction = new ObscuraAuctionZK(
            tkn,
            musd,
            ObscuraBase.Config(5, 3, 3, BOND, 1 ether, REWARD, 16, 1),
            IClearingVerifier(address(new ClearingVerifier()))
        );
        musd.mint(address(this), 1_000e18);
        musd.approve(address(auction), 1_000e18);
        auction.fundFeePool(1_000e18);
        _loadFixture();

        for (uint256 i; i < N; ++i) {
            tkn.mint(traders[i], depositBase[i]);
            musd.mint(traders[i], depositQuote[i]);
            vm.deal(traders[i], 1 ether);
            vm.startPrank(traders[i]);
            tkn.approve(address(auction), type(uint256).max);
            musd.approve(address(auction), type(uint256).max);
            auction.deposit(address(tkn), depositBase[i]);
            auction.deposit(address(musd), depositQuote[i]);
            vm.stopPrank();
        }
    }

    function _loadFixture() internal {
        string memory json = vm.readFile("test/fixtures/zk-batch.json");
        string[] memory labels = vm.parseJsonStringArray(json, ".labels");
        uint256[] memory dB = vm.parseJsonUintArray(json, ".depositBase");
        uint256[] memory dQ = vm.parseJsonUintArray(json, ".depositQuote");
        uint256[] memory cm = vm.parseJsonUintArray(json, ".commitments");
        bool[] memory sides = vm.parseJsonBoolArray(json, ".isBuy");
        uint256[] memory fl = vm.parseJsonUintArray(json, ".fillsLots");
        uint256[] memory fe = vm.parseJsonUintArray(json, ".fillEnc");
        uint256[] memory inc = vm.parseJsonUintArray(json, ".included");
        for (uint256 i; i < N; ++i) {
            traders[i] = makeAddr(labels[i]);
            (depositBase[i], depositQuote[i], commitments[i], isBuy[i]) = (dB[i], dQ[i], cm[i], sides[i]);
            (fillsLots[i], fillEnc[i], included[i]) = (fl[i], fe[i], inc[i]);
        }
        priceTicks = vm.parseJsonUint(json, ".priceTicks");
        uint256[] memory a = vm.parseJsonUintArray(json, ".a");
        uint256[] memory b0 = vm.parseJsonUintArray(json, ".b[0]");
        uint256[] memory b1 = vm.parseJsonUintArray(json, ".b[1]");
        uint256[] memory c = vm.parseJsonUintArray(json, ".c");
        pA = [a[0], a[1]];
        pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        pC = [c[0], c[1]];
    }

    function _rollTo(uint256 epoch, uint256 offset) internal {
        vm.roll(auction.epochStartBlock(epoch) + offset);
    }

    function _commitAll(uint256 epoch) internal {
        _rollTo(epoch, 0);
        for (uint256 i; i < N; ++i) {
            vm.prank(traders[i]);
            auction.commit{value: BOND}(epoch, commitments[i]);
        }
    }

    function _submit(uint256 epoch) internal {
        auction.submitProof(epoch, priceTicks, fillEnc, included, pA, pB, pC);
    }

    function _assertConservation() internal view {
        assertTrue(auction.checkI1());
        assertEq(
            tkn.balanceOf(address(auction)),
            auction.totalFree(address(tkn)) + auction.totalLocked(address(tkn))
        );
        assertEq(
            musd.balanceOf(address(auction)),
            auction.totalFree(address(musd)) + auction.totalLocked(address(musd)) + auction.feePool()
        );
        assertEq(
            address(auction).balance,
            auction.bondsHeld() + auction.totalClaimableEth() + auction.treasuryEth()
        );
    }

    // ================================================================ the whole batch, from a proof

    function test_ProofSettlesTheBatchWithoutRevealingAnyOrder() public {
        _commitAll(0);
        // Commit locks each trader's whole balance, so the lock says nothing about the order.
        assertEq(auction.freeBalance(traders[0], address(musd)), 0);
        assertEq(auction.lockedBalance(traders[0], address(musd)), depositQuote[0]);

        _rollTo(0, 8); // solve window; there was no reveal transaction at all
        uint256 gasBefore = gasleft();
        _submit(0);
        emit log_named_uint("submitProof gas (Groth16 verification, 98 public inputs)", gasBefore - gasleft());

        _rollTo(0, 11);
        gasBefore = gasleft();
        auction.settle(0);
        emit log_named_uint("settle gas (16 slots)", gasBefore - gasleft());

        uint256 bought;
        uint256 sold;
        for (uint256 i; i < N; ++i) {
            uint256 base = fillsLots[i] * LOT;
            uint256 quote = fillsLots[i] * priceTicks * QUOTE_UNIT;
            if (isBuy[i]) {
                assertEq(auction.freeBalance(traders[i], address(tkn)), depositBase[i] + base);
                assertEq(auction.freeBalance(traders[i], address(musd)), depositQuote[i] - quote);
                bought += base;
            } else {
                assertEq(auction.freeBalance(traders[i], address(tkn)), depositBase[i] - base);
                assertEq(auction.freeBalance(traders[i], address(musd)), depositQuote[i] + quote);
                sold += base;
            }
            assertEq(auction.lockedBalance(traders[i], address(tkn)), 0);
            assertEq(auction.lockedBalance(traders[i], address(musd)), 0);
        }
        assertEq(bought, sold);
        assertGt(bought, 0);
        assertEq(fillsLots[14], 0, "the unfunded order did not trade");

        // Included traders get their bond back; the one whose order was never sent forfeits it.
        assertEq(auction.claimableEth(traders[0]), BOND);
        assertEq(auction.claimableEth(traders[14]), BOND);
        assertEq(auction.claimableEth(traders[15]), 0);
        assertEq(auction.treasuryEth(), BOND);

        (uint256 price, uint256 volume, address solver,,) = auction.results(0);
        assertEq(price, priceTicks * 1e16);
        assertEq(volume, bought);
        assertEq(solver, address(this));
        assertEq(auction.freeBalance(address(this), address(musd)), REWARD);
        Fill[] memory fills = auction.getFills(0);
        for (uint256 i; i < fills.length; ++i) {
            assertEq(fills[i].quoteAmount, (fills[i].baseAmount / LOT) * priceTicks * QUOTE_UNIT, "one price");
        }
        assertTrue(auction.checkI2(0) && auction.checkI3(0) && auction.checkI4(0));
        _assertConservation();
    }

    // ================================================================ proofs that must be rejected

    function test_RejectsAChangedFill() public {
        _commitAll(0);
        _rollTo(0, 8);
        fillEnc[1] += 1;
        vm.expectRevert(ObscuraAuctionZK.InvalidProof.selector);
        _submit(0);
    }

    function test_RejectsAChangedPrice() public {
        _commitAll(0);
        _rollTo(0, 8);
        priceTicks += 1;
        vm.expectRevert(ObscuraAuctionZK.InvalidProof.selector);
        _submit(0);
    }

    function test_RejectsALeftOutOrderBeingClaimedIncluded() public {
        _commitAll(0);
        _rollTo(0, 8);
        included[15] = 1;
        vm.expectRevert(ObscuraAuctionZK.InvalidProof.selector);
        _submit(0);
    }

    function test_RejectsWhenACommitmentDiffers() public {
        _rollTo(0, 0);
        for (uint256 i; i < N; ++i) {
            uint256 c = i == 3 ? commitments[i] + 1 : commitments[i];
            vm.prank(traders[i]);
            auction.commit{value: BOND}(0, c);
        }
        _rollTo(0, 8);
        vm.expectRevert(ObscuraAuctionZK.InvalidProof.selector);
        _submit(0);
    }

    /// The commitments bind the epoch: the same sealed orders committed to another batch do not match.
    function test_RejectsTheProofInAnotherBatch() public {
        _commitAll(1);
        _rollTo(1, 8);
        vm.expectRevert(ObscuraAuctionZK.InvalidProof.selector);
        _submit(1);
    }

    function test_KeepsOnlyABetterSolution() public {
        _commitAll(0);
        _rollTo(0, 8);
        _submit(0);
        uint256 volume = auction.getBest(0).volumeLots;
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuctionZK.NotBetter.selector, volume, volume));
        _submit(0);
    }

    function test_ProofOnlyInTheSolveWindow() public {
        _commitAll(0);
        _rollTo(0, 5);
        vm.expectRevert(abi.encodeWithSelector(ObscuraBase.WrongPhase.selector, 0, ObscuraBase.Phase.Reveal));
        _submit(0);
        _rollTo(0, 8);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuctionZK.PriceOutOfRange.selector, 0));
        auction.submitProof(0, 0, fillEnc, included, pA, pB, pC);
    }

    // ================================================================ nobody proves

    function test_WithoutAProofEveryoneGetsEverythingBack() public {
        _commitAll(0);
        _rollTo(0, 11);
        auction.settle(0);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Voided));
        for (uint256 i; i < N; ++i) {
            assertEq(auction.freeBalance(traders[i], address(tkn)), depositBase[i]);
            assertEq(auction.freeBalance(traders[i], address(musd)), depositQuote[i]);
            assertEq(auction.claimableEth(traders[i]), BOND);
        }
        _assertConservation();
    }

    function test_EmptyBatchSettlesQuietly() public {
        _rollTo(0, 11);
        auction.settle(0);
        assertEq(uint8(auction.phaseOf(0)), uint8(ObscuraBase.Phase.Settled));
    }

    // ================================================================ commit rules

    function test_CommitRules() public {
        _rollTo(0, 0);
        vm.startPrank(traders[0]);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuctionZK.WrongBond.selector, 0, BOND));
        auction.commit(0, commitments[0]);
        vm.expectRevert(ObscuraAuctionZK.InvalidCommitment.selector);
        auction.commit{value: BOND}(0, 0);
        vm.expectRevert(ObscuraAuctionZK.InvalidCommitment.selector);
        auction.commit{value: BOND}(0, type(uint256).max);
        auction.commit{value: BOND}(0, commitments[0]);
        vm.expectRevert(ObscuraAuctionZK.AlreadyCommitted.selector);
        auction.commit{value: BOND}(0, commitments[0]);
        vm.stopPrank();

        for (uint256 i = 1; i < N; ++i) {
            vm.prank(traders[i]);
            auction.commit{value: BOND}(0, commitments[i]);
        }
        address extra = makeAddr("seventeenth");
        vm.deal(extra, 1 ether);
        vm.prank(extra);
        vm.expectRevert(abi.encodeWithSelector(ObscuraAuctionZK.BatchFull.selector, 0));
        auction.commit{value: BOND}(0, 123);
    }

    function test_ConstructorRejectsMoreOrdersThanSlots() public {
        ObscuraBase.Config memory c = ObscuraBase.Config(5, 3, 3, BOND, 1 ether, REWARD, 17, 1);
        vm.expectRevert(ObscuraBase.InvalidConfig.selector);
        new ObscuraAuctionZK(tkn, musd, c, IClearingVerifier(address(new ClearingVerifier())));
    }
}
