// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {ObscuraBase} from "../../src/ObscuraBase.sol";
import {ObscuraAuction} from "../../src/ObscuraAuction.sol";
import {Clearing, Order} from "../../src/libraries/Clearing.sol";
import {ReferenceSolver} from "./ReferenceSolver.sol";

/// @notice What the fuzzer is allowed to do. Each function is one realistic action by a random actor;
///         the fuzzer calls them in random order with random arguments, and after every call the
///         invariant tests check I1 to I4 plus independent "ghost" bookkeeping kept here.
contract ObscuraHandler is CommonBase, StdCheats, StdUtils {
    ObscuraAuction public immutable auction;
    MockERC20 public immutable tkn;
    MockERC20 public immutable musd;

    address[] public traders;
    address[] public solvers;
    address public immutable keeper = address(0xBEEF);

    struct Sealed {
        address trader;
        uint256 epoch;
        uint256 index;
        bool isBuy;
        uint128 limit;
        uint128 amount;
        bytes32 salt;
        bool revealed;
    }

    Sealed[] public sealedOrders;
    uint256[] public settledEpochs;
    uint256 internal nonce;

    // Ghost bookkeeping: everything that ever went in or out, counted independently of the contract.
    mapping(address token => uint256) public ghostDeposited;
    mapping(address token => uint256) public ghostWithdrawn;
    mapping(address token => uint256) public ghostDonated;
    uint256 public ghostEthIn;
    uint256 public ghostEthOut;
    uint256 public ghostEthDonated;

    // How far the fuzzer got, for the report.
    mapping(bytes32 action => uint256) public calls;

    constructor(ObscuraAuction auction_, MockERC20 tkn_, MockERC20 musd_) {
        auction = auction_;
        tkn = tkn_;
        musd = musd_;
        for (uint256 i; i < 4; ++i) {
            traders.push(address(uint160(0x7000 + i)));
        }
        for (uint256 i; i < 2; ++i) {
            solvers.push(address(uint160(0x5000 + i)));
        }
        for (uint256 i; i < 4; ++i) {
            _onboard(traders[i]);
        }
        for (uint256 i; i < 2; ++i) {
            _onboard(solvers[i]);
        }
        vm.deal(keeper, 1 ether);
    }

    function _onboard(address who) internal {
        tkn.mint(who, 1_000_000e18);
        musd.mint(who, 100_000_000e18);
        vm.deal(who, 1_000 ether);
        vm.startPrank(who);
        tkn.approve(address(auction), type(uint256).max);
        musd.approve(address(auction), type(uint256).max);
        vm.stopPrank();
    }

    function actors() external view returns (address[] memory all) {
        all = new address[](traders.length + solvers.length + 1);
        for (uint256 i; i < traders.length; ++i) {
            all[i] = traders[i];
        }
        for (uint256 i; i < solvers.length; ++i) {
            all[traders.length + i] = solvers[i];
        }
        all[all.length - 1] = keeper;
    }

    function settledCount() external view returns (uint256) {
        return settledEpochs.length;
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        return seed % 2 == 0 ? tkn : musd;
    }

    // ================================================================ actions

    function deposit(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address who = traders[actorSeed % traders.length];
        MockERC20 token = _token(tokenSeed);
        amount = bound(amount, 1, token.balanceOf(who));
        vm.prank(who);
        auction.deposit(address(token), amount);
        ghostDeposited[address(token)] += amount;
        calls["deposit"]++;
    }

    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address who =
            actorSeed % 3 == 0 ? solvers[actorSeed % solvers.length] : traders[actorSeed % traders.length];
        MockERC20 token = _token(tokenSeed);
        uint256 free = auction.freeBalance(who, address(token));
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(who);
        auction.withdraw(address(token), amount);
        ghostWithdrawn[address(token)] += amount;
        calls["withdraw"]++;
    }

    function commit(uint256 actorSeed, bool isBuy, uint256 priceSeed, uint256 amountSeed) external {
        uint256 epoch = auction.currentEpoch();
        if (auction.phaseOf(epoch) != ObscuraBase.Phase.Commit) return;
        if (auction.getCommitments(epoch).length >= auction.maxOrders()) return;
        _commit(_order(traders[actorSeed % traders.length], epoch, isBuy, priceSeed, amountSeed));
    }

    function _order(address trader, uint256 epoch, bool isBuy, uint256 priceSeed, uint256 amountSeed)
        internal
        returns (Sealed memory s)
    {
        s.trader = trader;
        s.epoch = epoch;
        s.isBuy = isBuy;
        // Limits on a 0.5 grid, so orders often share a price and must be rationed. Buys between 96 and 110,
        // sells between 90 and 104, so most batches have orders that cross and actually trade.
        s.limit = uint128(((isBuy ? 192 : 180) + (priceSeed % 29)) * 0.5e18);
        // Mostly whole amounts; sometimes odd wei amounts, to exercise rounding.
        s.amount = amountSeed % 4 == 0
            ? uint128(bound(amountSeed, 1, 1e12))
            : uint128(bound(amountSeed, 1, 200) * 1e18);
        s.salt = keccak256(abi.encode(++nonce));
    }

    /// One whole batch in a single action: 2 to 6 orders on both sides, every one revealed except
    /// sometimes one (its bond is forfeited), an honest solution, sometimes a corrupted one too, then settle.
    /// The fuzzer mixes this with the single-step actions, so odd orderings still get explored.
    function fullBatch(uint256 seed) external {
        uint256 epoch = auction.currentEpoch();
        if (auction.phaseOf(epoch) != ObscuraBase.Phase.Commit) epoch += 1;
        uint256 start = auction.epochStartBlock(epoch);
        if (block.number < start) vm.roll(start);

        uint256 orders = 2 + (seed % 5);
        for (uint256 i; i < orders; ++i) {
            if (auction.getCommitments(epoch).length >= auction.maxOrders()) break;
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            _commit(_order(traders[r % traders.length], epoch, i % 2 == 0, r >> 8, r >> 128));
        }

        vm.roll(start + auction.commitBlocks());
        uint256 skip = seed % 3 == 0 ? (seed >> 4) % orders : type(uint256).max;
        uint256 seen;
        for (uint256 i; i < sealedOrders.length; ++i) {
            Sealed storage s = sealedOrders[i];
            if (s.epoch != epoch || s.revealed) continue;
            if (seen++ == skip) continue;
            _reveal(s);
        }

        vm.roll(start + auction.commitBlocks() + auction.revealBlocks());
        _submit(seed, false, 0);
        if (seed % 4 == 0) _submit(seed + 1, true, seed >> 8);

        vm.roll(start + auction.epochLength());
        _settleReady();
        calls["fullBatch"]++;
    }

    function _commit(Sealed memory s) internal {
        bytes32 hash = auction.commitmentHash(s.trader, s.epoch, s.isBuy, s.limit, s.amount, s.salt);
        uint256 bond = auction.revealBond();
        vm.prank(s.trader);
        s.index = auction.commit{value: bond}(s.epoch, hash);
        ghostEthIn += bond;
        sealedOrders.push(s);
        calls["commit"]++;
    }

    /// Reveal a random sealed order of the current batch, topping up the trader's deposit if needed.
    /// Orders the fuzzer never reveals test the forfeited-bond path.
    function reveal(uint256 sealedSeed) external {
        // Choose among the orders that can be revealed right now (unrevealed, batch in its reveal window).
        uint256[] memory eligible = new uint256[](sealedOrders.length);
        uint256 count;
        for (uint256 i; i < sealedOrders.length; ++i) {
            Sealed storage c = sealedOrders[i];
            if (!c.revealed && auction.phaseOf(c.epoch) == ObscuraBase.Phase.Reveal) eligible[count++] = i;
        }
        if (count == 0) return;
        _reveal(sealedOrders[eligible[sealedSeed % count]]);
    }

    /// Reveal every order that can be revealed right now, except one in `skipEvery` (left to forfeit).
    function revealAll(uint256 skipEvery) external {
        skipEvery = bound(skipEvery, 2, 10);
        for (uint256 i; i < sealedOrders.length; ++i) {
            Sealed storage s = sealedOrders[i];
            if (s.revealed || auction.phaseOf(s.epoch) != ObscuraBase.Phase.Reveal) continue;
            if (i % skipEvery == 0) continue;
            _reveal(s);
        }
    }

    function _reveal(Sealed storage s) internal {
        (MockERC20 token, uint256 needed) =
            s.isBuy ? (musd, Clearing.quoteUp(s.amount, s.limit)) : (tkn, uint256(s.amount));
        uint256 free = auction.freeBalance(s.trader, address(token));
        if (free < needed) {
            vm.prank(s.trader);
            auction.deposit(address(token), needed - free);
            ghostDeposited[address(token)] += needed - free;
        }
        uint256 ethBefore = s.trader.balance;
        vm.prank(s.trader);
        auction.reveal(s.epoch, s.index, s.isBuy, s.limit, s.amount, s.salt);
        ghostEthOut += s.trader.balance - ethBefore; // the bond comes straight back
        s.revealed = true;
        calls["reveal"]++;
    }

    function submitHonest(uint256 solverSeed) external {
        _submit(solverSeed, false, 0);
    }

    /// A solution that is usually invalid (and gets slashed), sometimes still valid by luck.
    function submitCorrupt(uint256 solverSeed, uint256 mutation) external {
        _submit(solverSeed, true, mutation);
    }

    function _submit(uint256 solverSeed, bool corrupt, uint256 mutation) internal {
        uint256 epoch = auction.currentEpoch();
        if (auction.phaseOf(epoch) != ObscuraBase.Phase.Solve) return;
        if (auction.solutionCount(epoch) >= auction.maxSolutions()) return;
        Order[] memory orders = auction.getOrders(epoch);
        (bool found, uint256 price, uint128[] memory fills,) = ReferenceSolver.solve(orders);
        if (!found) return;

        if (corrupt) {
            uint256 kind = mutation % 4;
            if (kind == 0) price = price + 1e18; // a different price
            else if (kind == 1 && fills.length > 0) fills[mutation % fills.length] += 1; // one wei too much
            else if (kind == 2) fills = new uint128[](fills.length); // fill nobody: censorship
            else price = price / 2 + 1; // far off
            calls["submitCorrupt"]++;
        } else {
            calls["submitHonest"]++;
        }

        address who = solvers[solverSeed % solvers.length];
        uint256 bond = auction.solverBond();
        vm.prank(who);
        auction.submitSolution{value: bond}(epoch, price, fills);
        ghostEthIn += bond;
    }

    /// Settle every batch that is ready, from a few batches back up to now.
    function settle() external {
        _settleReady();
    }

    function _settleReady() internal {
        uint256 current = auction.currentEpoch();
        uint256 from = current > 5 ? current - 5 : 0;
        for (uint256 e = from; e <= current; ++e) {
            if (auction.phaseOf(e) != ObscuraBase.Phase.Settleable) continue;
            vm.prank(keeper);
            auction.settle(e);
            calls["settle"]++;
            if (auction.phaseOf(e) == ObscuraBase.Phase.Voided) {
                calls["voided"]++;
            } else {
                settledEpochs.push(e);
                (, uint256 volume,,,) = auction.results(e);
                if (volume > 0) calls["settledWithTrades"]++;
            }
        }
    }

    function withdrawEth(uint256 actorSeed) external {
        address[] memory all = this.actors();
        address who = all[actorSeed % all.length];
        uint256 owed = auction.claimableEth(who);
        if (owed == 0) return;
        vm.prank(who);
        auction.withdrawEth();
        ghostEthOut += owed;
        calls["withdrawEth"]++;
    }

    function advance(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 1, 3));
        calls["advance"]++;
    }

    /// Jump to the first block of the current batch's next window (commit → reveal → solve → settleable).
    function nextPhase() external {
        uint256 epoch = auction.currentEpoch();
        uint256 start = auction.epochStartBlock(epoch);
        uint256 revealStart = start + auction.commitBlocks();
        uint256 solveStart = revealStart + auction.revealBlocks();
        uint256 end = start + auction.epochLength();
        if (block.number < revealStart) vm.roll(revealStart);
        else if (block.number < solveStart) vm.roll(solveStart);
        else vm.roll(end);
        calls["advance"]++;
    }

    /// Tokens and ETH sent straight to the contract, outside the ledger. Must never break I1.
    function donate(uint256 tokenSeed, uint256 amount) external {
        amount = bound(amount, 1, 1_000e18);
        if (tokenSeed % 3 == 2) {
            vm.deal(address(auction), address(auction).balance + amount / 1_000);
            ghostEthDonated += amount / 1_000;
        } else {
            MockERC20 token = _token(tokenSeed);
            token.mint(address(auction), amount);
            ghostDonated[address(token)] += amount;
        }
        calls["donate"]++;
    }
}
