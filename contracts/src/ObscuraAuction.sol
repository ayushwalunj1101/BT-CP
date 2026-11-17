// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ObscuraBase} from "./ObscuraBase.sol";
import {IObscuraInvariants} from "./interfaces/IObscuraInvariants.sol";
import {Clearing, Fill, Order} from "./libraries/Clearing.sol";

/// @title ObscuraAuction
/// @notice The Obscura dark pool: sealed orders, revealed only after the commit window closes, then filled
///         together at one uniform price that an outside solver computes and this contract checks.
///
///         1. Commit  a hash of the order and a small ETH bond. The mempool sees 32 unreadable bytes.
///         2. Reveal  the order. Its funds lock, and the bond comes back. Silence forfeits the bond.
///         3. Solve   solvers submit a clearing price and fills, each with a bond.
///         4. Settle  anyone calls settle(): every solution is checked, invalid ones are slashed, and the
///                    valid one that matches the most volume executes, everyone at the same price.
///
///         Because every fill in a batch gets the same price, being first in the batch is worth nothing:
///         the queue a sandwich attack needs no longer exists.
contract ObscuraAuction is ObscuraBase, IObscuraInvariants {
    struct Commitment {
        address trader;
        bytes32 hash;
        bool revealed;
    }

    struct Solution {
        address solver;
        uint256 price;
        uint128[] fills; // one per revealed order, in reveal order
    }

    struct EpochResult {
        uint256 price;
        uint256 volume;
        address solver;
        uint256 reward;
        /// @dev Change in the winning solver's ledger value across settlement, valued at `price` and scaled by
        ///      1e18 (Δ mUSD × 1e18 + Δ TKN × price). Invariant I4 compares it with the declared reward.
        int256 solverValueChange;
    }

    mapping(uint256 epoch => Commitment[]) internal _commitments;
    mapping(uint256 epoch => Order[]) internal _orders;
    mapping(uint256 epoch => Solution[]) internal _solutions;
    mapping(uint256 epoch => Fill[]) internal _fills;
    mapping(uint256 epoch => EpochResult) public results;

    event Committed(uint256 indexed epoch, uint256 index, address indexed trader, bytes32 commitment);
    event Revealed(
        uint256 indexed epoch,
        uint256 orderId,
        address indexed trader,
        bool isBuy,
        uint128 limitPrice,
        uint128 amount
    );
    event BondForfeited(uint256 indexed epoch, address indexed trader);
    event SolutionSubmitted(uint256 indexed epoch, uint256 solutionId, address indexed solver, uint256 price);
    event SolverSlashed(uint256 indexed epoch, address indexed solver, address indexed caller, uint256 bond);
    event Filled(
        uint256 indexed epoch, address indexed trader, bool isBuy, uint256 baseAmount, uint256 quoteAmount
    );
    event Settled(
        uint256 indexed epoch, uint256 price, uint256 volume, address indexed solver, uint256 reward
    );
    event EpochVoided(uint256 indexed epoch);

    error WrongBond(uint256 sent, uint256 required);
    error BatchFull(uint256 epoch);
    error UnknownCommitment(uint256 epoch, uint256 index);
    error NotYourCommitment();
    error AlreadyRevealed();
    error CommitmentMismatch();
    error InvalidOrder();
    error TooManySolutions(uint256 epoch);
    error WrongFillCount(uint256 got, uint256 expected);

    constructor(IERC20 base_, IERC20 quote_, Config memory config) ObscuraBase(base_, quote_, config) {}

    // ------------------------------------------------------------------ trading

    /// @notice The sealed form of an order. The trader and epoch are inside, so a copied commitment
    ///         cannot be revealed by anyone else or in any other batch.
    function commitmentHash(
        address trader,
        uint256 epoch,
        bool isBuy,
        uint128 limitPrice,
        uint128 amount,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(trader, epoch, isBuy, limitPrice, amount, salt));
    }

    /// @notice Post a sealed order into `epoch`, with exactly `revealBond` ETH.
    /// @dev Taking the epoch as an argument means a transaction that lands one block late reverts,
    ///      instead of being filed under the next batch where its reveal would fail.
    function commit(uint256 epoch, bytes32 commitment) external payable returns (uint256 index) {
        _requirePhase(epoch, Phase.Commit);
        if (msg.value != revealBond) revert WrongBond(msg.value, revealBond);
        Commitment[] storage list = _commitments[epoch];
        if (list.length >= maxOrders) revert BatchFull(epoch);
        index = list.length;
        list.push(Commitment({trader: msg.sender, hash: commitment, revealed: false}));
        bondsHeld += msg.value;
        emit Committed(epoch, index, msg.sender, commitment);
    }

    /// @notice Open your sealed order. Its funds lock from your free balance and your bond is returned.
    ///         If your free balance cannot cover the order, deposit more and reveal again before the window ends.
    function reveal(
        uint256 epoch,
        uint256 index,
        bool isBuy,
        uint128 limitPrice,
        uint128 amount,
        bytes32 salt
    ) external nonReentrant {
        _requirePhase(epoch, Phase.Reveal);
        if (index >= _commitments[epoch].length) revert UnknownCommitment(epoch, index);
        Commitment storage c = _commitments[epoch][index];
        if (c.trader != msg.sender) revert NotYourCommitment();
        if (c.revealed) revert AlreadyRevealed();
        if (commitmentHash(msg.sender, epoch, isBuy, limitPrice, amount, salt) != c.hash) {
            revert CommitmentMismatch();
        }
        if (amount == 0 || limitPrice == 0) revert InvalidOrder();

        Order memory order = Order({trader: msg.sender, isBuy: isBuy, limitPrice: limitPrice, amount: amount});
        _lockOrder(order);
        c.revealed = true;
        uint256 orderId = _orders[epoch].length;
        _orders[epoch].push(order);
        bondsHeld -= revealBond;
        emit Revealed(epoch, orderId, msg.sender, isBuy, limitPrice, amount);

        // Return the bond directly; if the trader cannot receive ETH, it waits for them in claimableEth.
        (bool ok,) = msg.sender.call{value: revealBond}("");
        if (!ok) _creditEth(msg.sender, revealBond);
    }

    // ------------------------------------------------------------------ solving

    /// @notice Propose how `epoch` clears: one `price` for everyone, and a fill for each revealed order.
    ///         Costs exactly `solverBond` ETH, returned at settlement if the solution is valid.
    function submitSolution(uint256 epoch, uint256 price, uint128[] calldata fills)
        external
        payable
        returns (uint256 id)
    {
        _requirePhase(epoch, Phase.Solve);
        if (msg.value != solverBond) revert WrongBond(msg.value, solverBond);
        Solution[] storage list = _solutions[epoch];
        if (list.length >= maxSolutions) revert TooManySolutions(epoch);
        uint256 orderCount = _orders[epoch].length;
        if (fills.length != orderCount) revert WrongFillCount(fills.length, orderCount);

        id = list.length;
        Solution storage s = list.push();
        s.solver = msg.sender;
        s.price = price;
        s.fills = fills;
        bondsHeld += msg.value;
        emit SolutionSubmitted(epoch, id, msg.sender, price);
    }

    /// @notice Close `epoch`. Anyone may call this once the solve window has ended.
    ///         1. Bonds of commitments that were never revealed are forfeited.
    ///         2. Every solution is checked; each invalid one is slashed, half to the caller and half burned.
    ///         3. The valid solution with the most matched volume executes (the earliest wins a tie).
    ///         4. If no solution is valid, the batch is voided and every locked fund is returned.
    function settle(uint256 epoch) external nonReentrant {
        _requirePhase(epoch, Phase.Settleable);
        _forfeitUnrevealed(epoch);

        Order[] memory orders = _orders[epoch];
        Solution[] storage solutions = _solutions[epoch];
        uint256 best = type(uint256).max;
        uint256 bestVolume = 0;
        for (uint256 i; i < solutions.length; ++i) {
            (bool ok, uint256 volume) = Clearing.check(orders, solutions[i].price, solutions[i].fills);
            if (!ok) {
                _slash(epoch, solutions[i].solver);
                continue;
            }
            bondsHeld -= solverBond;
            _creditEth(solutions[i].solver, solverBond);
            if (best == type(uint256).max || volume > bestVolume) {
                best = i;
                bestVolume = volume;
            }
        }

        if (best != type(uint256).max) {
            _execute(
                epoch,
                orders,
                solutions[best].price,
                solutions[best].fills,
                bestVolume,
                solutions[best].solver
            );
        } else if (orders.length == 0) {
            epochStatus[epoch] = Status.Settled; // nothing was revealed, so there is nothing to clear
            emit Settled(epoch, 0, 0, address(0), 0);
        } else {
            for (uint256 i; i < orders.length; ++i) {
                _unlockOrder(orders[i]);
            }
            epochStatus[epoch] = Status.Voided;
            emit EpochVoided(epoch);
        }
    }

    /// @notice The exact check settle() runs, so a solver can test a solution before paying a bond.
    function checkClearing(Order[] calldata orders, uint256 price, uint128[] calldata fills)
        external
        pure
        returns (bool ok, uint256 volume)
    {
        return Clearing.check(orders, price, fills);
    }

    // ------------------------------------------------------------------ invariants
    // Each check returns true for a batch that has not settled. The fuzzer asserts them after every call;
    // InvariantBounty pays out to anyone who makes one false.

    /// @inheritdoc ObscuraBase
    function checkI1() public view override(ObscuraBase, IObscuraInvariants) returns (bool) {
        return super.checkI1();
    }

    /// @notice I2, uniform price: every fill in `epoch` moved exactly base × p* in mUSD,
    ///         rounded up for a buyer and down for a seller.
    function checkI2(uint256 epoch) external view returns (bool) {
        if (epochStatus[epoch] != Status.Settled) return true;
        uint256 price = results[epoch].price;
        Fill[] storage list = _fills[epoch];
        for (uint256 i; i < list.length; ++i) {
            Fill storage f = list[i];
            uint256 expected =
                f.isBuy ? Clearing.quoteUp(f.baseAmount, price) : Clearing.quoteDown(f.baseAmount, price);
            if (f.quoteAmount != expected) return false;
        }
        return true;
    }

    /// @notice I3, limit respect: no buyer paid more than their limit allows, no seller received less,
    ///         and no fill exceeded its order.
    function checkI3(uint256 epoch) external view returns (bool) {
        if (epochStatus[epoch] != Status.Settled) return true;
        Fill[] storage list = _fills[epoch];
        Order[] storage orders = _orders[epoch];
        for (uint256 i; i < list.length; ++i) {
            Fill storage f = list[i];
            if (f.orderId >= orders.length) return false;
            Order storage o = orders[f.orderId];
            if (o.trader != f.trader || o.isBuy != f.isBuy || f.baseAmount > o.amount) return false;
            if (f.isBuy && f.quoteAmount > Clearing.quoteUp(f.baseAmount, o.limitPrice)) return false;
            if (!f.isBuy && f.quoteAmount < Clearing.quoteDown(f.baseAmount, o.limitPrice)) return false;
        }
        return true;
    }

    /// @notice I4, solver honesty: across settlement, the winning solver's ledger gained no more than the
    ///         declared reward (its own trades in the batch, valued at p*, net to zero or less).
    function checkI4(uint256 epoch) external view returns (bool) {
        if (epochStatus[epoch] != Status.Settled) return true;
        return results[epoch].solverValueChange <= int256(solverReward * Clearing.PRICE_SCALE);
    }

    // ------------------------------------------------------------------ views

    function getCommitments(uint256 epoch) external view returns (Commitment[] memory) {
        return _commitments[epoch];
    }

    function getOrders(uint256 epoch) external view returns (Order[] memory) {
        return _orders[epoch];
    }

    function solutionCount(uint256 epoch) external view returns (uint256) {
        return _solutions[epoch].length;
    }

    function getSolution(uint256 epoch, uint256 id) external view returns (Solution memory) {
        return _solutions[epoch][id];
    }

    function getFills(uint256 epoch) external view returns (Fill[] memory) {
        return _fills[epoch];
    }

    // ------------------------------------------------------------------ internals

    function _forfeitUnrevealed(uint256 epoch) private {
        Commitment[] storage list = _commitments[epoch];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].revealed) continue;
            bondsHeld -= revealBond;
            treasuryEth += revealBond;
            emit BondForfeited(epoch, list[i].trader);
        }
    }

    /// @dev Half to whoever exposed the bad solution, half burned into the treasury. If the caller got the
    ///      whole bond, a cheating solver could call settle() itself and lose nothing.
    function _slash(uint256 epoch, address solver) private {
        bondsHeld -= solverBond;
        uint256 toCaller = solverBond / 2;
        _creditEth(msg.sender, toCaller);
        treasuryEth += solverBond - toCaller;
        emit SolverSlashed(epoch, solver, msg.sender, solverBond);
    }

    function _execute(
        uint256 epoch,
        Order[] memory orders,
        uint256 price,
        uint128[] memory fills,
        uint256 volume,
        address solver
    ) private {
        int256 solverValueBefore = _ledgerValue(solver, price);
        uint256 quotePaid = 0;
        uint256 quoteReceived = 0;
        Fill[] storage recorded = _fills[epoch];
        for (uint256 i; i < orders.length; ++i) {
            Order memory o = orders[i];
            uint256 fill = fills[i];
            uint256 quoteAmount = _settleOrder(o, fill, price);
            if (fill == 0) continue;
            if (o.isBuy) quotePaid += quoteAmount;
            else quoteReceived += quoteAmount;
            recorded.push(
                Fill({
                    trader: o.trader,
                    isBuy: o.isBuy,
                    orderId: uint32(i), // i < maxOrders, far below 2^32
                    baseAmount: fill,
                    quoteAmount: quoteAmount
                })
            );
            emit Filled(epoch, o.trader, o.isBuy, fill, quoteAmount);
        }
        feePool += quotePaid - quoteReceived; // rounding dust: buyers round up, sellers round down

        uint256 reward = volume > 0 ? _rewardFor(volume) : 0;
        if (reward > 0) {
            feePool -= reward;
            _creditFree(solver, address(quoteToken), reward);
        }
        epochStatus[epoch] = Status.Settled;
        results[epoch] = EpochResult({
            price: price,
            volume: volume,
            solver: solver,
            reward: reward,
            solverValueChange: _ledgerValue(solver, price) - solverValueBefore
        });
        emit Settled(epoch, price, volume, solver, reward);
    }

    /// @dev The solver's reward for a batch with trades: the declared amount, or whatever the fee pool holds.
    function _rewardFor(uint256) internal view virtual returns (uint256) {
        return solverReward < feePool ? solverReward : feePool;
    }

    /// @dev Everything `account` holds in the ledger, valued at `price`, scaled by 1e18.
    function _ledgerValue(address account, uint256 price) private view returns (int256) {
        uint256 quote =
            freeBalance[account][address(quoteToken)] + lockedBalance[account][address(quoteToken)];
        uint256 base = freeBalance[account][address(baseToken)] + lockedBalance[account][address(baseToken)];
        return int256(quote * Clearing.PRICE_SCALE + base * price);
    }
}
