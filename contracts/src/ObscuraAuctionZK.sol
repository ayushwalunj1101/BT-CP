// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ObscuraBase} from "./ObscuraBase.sol";
import {IClearingVerifier} from "./interfaces/IClearingVerifier.sol";
import {IObscuraInvariants} from "./interfaces/IObscuraInvariants.sol";
import {Clearing, Fill} from "./libraries/Clearing.sol";

/// @title ObscuraAuctionZK
/// @notice The zero-knowledge dark pool (feature F12). Orders are never revealed on-chain, not even after
///         settlement: only fills are, because tokens move.
///
///         1. Commit   Poseidon(trader, epoch, side, limit, amount, salt), with a bond. The trader's whole free
///                     balance locks for the batch, so the lock reveals nothing about the order's size.
///                     The order itself goes to the solver privately, encrypted, never on-chain.
///         2. Prove    in the solve window, a solver submits one price, the fills, and a Groth16 proof that they
///                     are a valid clearing of exactly the committed orders. The proof is checked right away,
///                     in the solver's own transaction; a better one (more volume) replaces it.
///         3. Settle   anyone settles the best proven solution, everyone at the same price.
///
///         Units are integers so the circuit never divides: amounts in lots of 0.001 TKN, prices in ticks of
///         0.01 mUSD per TKN, and f lots at p ticks cost exactly f × p × 10^13 wei of mUSD. No rounding.
/// @dev No solver bond: an invalid proof cannot be accepted at all. The trader's bond is returned if the
///      solver included their order (or nobody proved anything), and forfeited if their order was left out,
///      which is what happens to a trader who never sends their order to a solver.
contract ObscuraAuctionZK is ObscuraBase, IObscuraInvariants {
    uint256 public constant SLOTS = 16;
    uint256 public constant LOT = 1e15;
    uint256 public constant TICK = 1e16;
    uint256 public constant QUOTE_UNIT = 1e13;
    uint256 internal constant SELL_SHIFT = 1 << 64;
    uint256 internal constant MAX_TICKS = 1 << 32;
    uint256 internal constant MAX_LOCK = type(uint128).max;
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct Slot {
        address trader;
        uint256 commitment;
        uint256 lockBase;
        uint256 lockQuote;
    }

    struct ProvenSolution {
        address solver;
        uint256 priceTicks;
        uint256 volumeLots;
        uint256 includedMask; // bit i set: the solver opened slot i's order
        uint256[16] fillEnc; // buy fills in lots; sell fills in lots, shifted left by 64 bits
    }

    struct EpochResult {
        uint256 price; // 1e18 scale, like ObscuraAuction
        uint256 volume; // TKN wei
        address solver;
        uint256 reward;
        int256 solverValueChange;
    }

    IClearingVerifier public immutable verifier;

    mapping(uint256 epoch => Slot[]) internal _slots;
    mapping(uint256 epoch => mapping(address trader => bool)) public hasCommitted;
    mapping(uint256 epoch => ProvenSolution) internal _best;
    mapping(uint256 epoch => Fill[]) internal _fills;
    mapping(uint256 epoch => EpochResult) public results;

    event Committed(uint256 indexed epoch, uint256 slot, address indexed trader, uint256 commitment);
    event ProofAccepted(
        uint256 indexed epoch, address indexed solver, uint256 priceTicks, uint256 volumeLots
    );
    event BondForfeited(uint256 indexed epoch, address indexed trader);
    event Filled(
        uint256 indexed epoch, address indexed trader, bool isBuy, uint256 baseAmount, uint256 quoteAmount
    );
    event Settled(
        uint256 indexed epoch, uint256 price, uint256 volume, address indexed solver, uint256 reward
    );
    event EpochVoided(uint256 indexed epoch);

    error WrongBond(uint256 sent, uint256 required);
    error BatchFull(uint256 epoch);
    error AlreadyCommitted();
    error InvalidCommitment();
    error PriceOutOfRange(uint256 priceTicks);
    error InvalidProof();
    error NotBetter(uint256 volumeLots, uint256 bestVolumeLots);

    constructor(IERC20 base_, IERC20 quote_, Config memory config, IClearingVerifier verifier_)
        ObscuraBase(base_, quote_, config)
    {
        if (config.maxOrders > SLOTS) revert InvalidConfig();
        verifier = verifier_;
    }

    // ------------------------------------------------------------------ trading

    /// @notice Seal an order into `epoch`. One order per trader per batch. Locks your whole free balance.
    function commit(uint256 epoch, uint256 commitment) external payable returns (uint256 slot) {
        _requirePhase(epoch, Phase.Commit);
        if (msg.value != revealBond) revert WrongBond(msg.value, revealBond);
        if (commitment == 0 || commitment >= SNARK_FIELD) revert InvalidCommitment();
        if (hasCommitted[epoch][msg.sender]) revert AlreadyCommitted();
        Slot[] storage list = _slots[epoch];
        if (list.length >= maxOrders) revert BatchFull(epoch);

        uint256 lockBase = _min(freeBalance[msg.sender][address(baseToken)], MAX_LOCK);
        uint256 lockQuote = _min(freeBalance[msg.sender][address(quoteToken)], MAX_LOCK);
        _lock(msg.sender, address(baseToken), lockBase);
        _lock(msg.sender, address(quoteToken), lockQuote);

        slot = list.length;
        list.push(
            Slot({trader: msg.sender, commitment: commitment, lockBase: lockBase, lockQuote: lockQuote})
        );
        hasCommitted[epoch][msg.sender] = true;
        bondsHeld += msg.value;
        emit Committed(epoch, slot, msg.sender, commitment);
    }

    // ------------------------------------------------------------------ proving

    /// @notice Submit a clearing of `epoch` with its proof. Reverts unless the proof is valid and the
    ///         solution matches more TKN than the best one so far.
    function submitProof(
        uint256 epoch,
        uint256 priceTicks,
        uint256[16] calldata fillEnc,
        uint256[16] calldata included,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external {
        _requirePhase(epoch, Phase.Solve);
        if (priceTicks == 0 || priceTicks >= MAX_TICKS) revert PriceOutOfRange(priceTicks);
        if (!verifier.verifyProof(pA, pB, pC, publicInputs(epoch, priceTicks, fillEnc, included))) {
            revert InvalidProof();
        }

        uint256 volumeLots = 0;
        uint256 mask = 0;
        for (uint256 i; i < SLOTS; ++i) {
            if (fillEnc[i] < SELL_SHIFT) volumeLots += fillEnc[i]; // buys; sells balance them (proven)
            if (included[i] == 1) mask |= 1 << i;
        }
        ProvenSolution storage best = _best[epoch];
        if (best.solver != address(0) && volumeLots <= best.volumeLots) {
            revert NotBetter(volumeLots, best.volumeLots);
        }

        best.solver = msg.sender;
        best.priceTicks = priceTicks;
        best.volumeLots = volumeLots;
        best.includedMask = mask;
        best.fillEnc = fillEnc;
        emit ProofAccepted(epoch, msg.sender, priceTicks, volumeLots);
    }

    /// @notice The 98 public inputs of the circuit, in its order: epoch, price, then per slot the
    ///         commitments, traders, base locks, quote locks, inclusion flags and encoded fills.
    function publicInputs(
        uint256 epoch,
        uint256 priceTicks,
        uint256[16] calldata fillEnc,
        uint256[16] calldata included
    ) public view returns (uint256[98] memory pub) {
        pub[0] = epoch;
        pub[1] = priceTicks;
        Slot[] storage list = _slots[epoch];
        for (uint256 i; i < list.length; ++i) {
            pub[2 + i] = list[i].commitment;
            pub[18 + i] = uint256(uint160(list[i].trader));
            pub[34 + i] = list[i].lockBase;
            pub[50 + i] = list[i].lockQuote;
        }
        for (uint256 i; i < SLOTS; ++i) {
            pub[66 + i] = included[i];
            pub[82 + i] = fillEnc[i];
        }
    }

    // ------------------------------------------------------------------ settling

    /// @notice Close `epoch`. With a proven solution, every fill executes at its one price; without one,
    ///         every lock and every bond is returned.
    function settle(uint256 epoch) external nonReentrant {
        _requirePhase(epoch, Phase.Settleable);
        Slot[] storage list = _slots[epoch];
        ProvenSolution storage best = _best[epoch];

        if (best.solver == address(0)) {
            for (uint256 i; i < list.length; ++i) {
                _unlock(list[i].trader, address(baseToken), list[i].lockBase);
                _unlock(list[i].trader, address(quoteToken), list[i].lockQuote);
                _returnBond(list[i].trader);
            }
            epochStatus[epoch] = list.length == 0 ? Status.Settled : Status.Voided;
            if (list.length > 0) emit EpochVoided(epoch);
            else emit Settled(epoch, 0, 0, address(0), 0);
            return;
        }

        uint256 price = best.priceTicks * TICK;
        int256 solverValueBefore = _ledgerValue(best.solver, price);
        for (uint256 i; i < list.length; ++i) {
            Slot storage s = list[i];
            if (best.includedMask & (1 << i) != 0) {
                _returnBond(s.trader);
            } else {
                bondsHeld -= revealBond;
                treasuryEth += revealBond;
                emit BondForfeited(epoch, s.trader);
            }
            _settleSlot(epoch, i, s, best.fillEnc[i], best.priceTicks);
        }

        uint256 reward = best.volumeLots > 0 ? _min(solverReward, feePool) : 0;
        if (reward > 0) {
            feePool -= reward;
            _creditFree(best.solver, address(quoteToken), reward);
        }
        epochStatus[epoch] = Status.Settled;
        results[epoch] = EpochResult({
            price: price,
            volume: best.volumeLots * LOT,
            solver: best.solver,
            reward: reward,
            solverValueChange: _ledgerValue(best.solver, price) - solverValueBefore
        });
        emit Settled(epoch, price, best.volumeLots * LOT, best.solver, reward);
    }

    /// @dev Moves one slot's fill at the batch price and unlocks everything else. Amounts are exact: the proof
    ///      guarantees the fill fits inside the locks and that TKN bought equals TKN sold.
    function _settleSlot(uint256 epoch, uint256 i, Slot storage s, uint256 encoded, uint256 priceTicks)
        private
    {
        _releaseLocked(s.trader, address(baseToken), s.lockBase);
        _releaseLocked(s.trader, address(quoteToken), s.lockQuote);
        bool isBuy = encoded < SELL_SHIFT;
        uint256 lots = isBuy ? encoded : encoded / SELL_SHIFT;
        uint256 baseAmount = lots * LOT;
        uint256 quoteAmount = lots * priceTicks * QUOTE_UNIT;

        if (isBuy) {
            _creditFree(s.trader, address(baseToken), s.lockBase + baseAmount);
            _creditFree(s.trader, address(quoteToken), s.lockQuote - quoteAmount);
        } else {
            _creditFree(s.trader, address(baseToken), s.lockBase - baseAmount);
            _creditFree(s.trader, address(quoteToken), s.lockQuote + quoteAmount);
        }
        if (lots == 0) return;
        _fills[epoch].push(
            Fill({
                trader: s.trader,
                isBuy: isBuy,
                orderId: uint32(i),
                baseAmount: baseAmount,
                quoteAmount: quoteAmount
            })
        );
        emit Filled(epoch, s.trader, isBuy, baseAmount, quoteAmount);
    }

    function _returnBond(address trader) private {
        bondsHeld -= revealBond;
        _creditEth(trader, revealBond);
    }

    // ------------------------------------------------------------------ invariants

    /// @inheritdoc ObscuraBase
    function checkI1() public view override(ObscuraBase, IObscuraInvariants) returns (bool) {
        return super.checkI1();
    }

    /// @notice I2: every fill moved exactly lots × price in mUSD (no rounding on this path).
    function checkI2(uint256 epoch) external view returns (bool) {
        if (epochStatus[epoch] != Status.Settled) return true;
        uint256 price = results[epoch].price;
        Fill[] storage list = _fills[epoch];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].quoteAmount != Clearing.quoteDown(list[i].baseAmount, price)) return false;
            if (list[i].baseAmount % LOT != 0) return false;
        }
        return true;
    }

    /// @notice I3: limit prices never appear on-chain on this path, so the contract cannot check them.
    ///         The circuit enforces I3 inside every accepted proof (Slot rule 6 in clearing.circom).
    function checkI3(uint256) external pure returns (bool) {
        return true;
    }

    /// @notice I4: the winning solver's ledger gained no more than the declared reward.
    function checkI4(uint256 epoch) external view returns (bool) {
        if (epochStatus[epoch] != Status.Settled) return true;
        return results[epoch].solverValueChange <= int256(solverReward * Clearing.PRICE_SCALE);
    }

    // ------------------------------------------------------------------ views

    function getSlots(uint256 epoch) external view returns (Slot[] memory) {
        return _slots[epoch];
    }

    function getBest(uint256 epoch) external view returns (ProvenSolution memory) {
        return _best[epoch];
    }

    function getFills(uint256 epoch) external view returns (Fill[] memory) {
        return _fills[epoch];
    }

    // ------------------------------------------------------------------ helpers

    function _ledgerValue(address account, uint256 price) private view returns (int256) {
        uint256 quote =
            freeBalance[account][address(quoteToken)] + lockedBalance[account][address(quoteToken)];
        uint256 base = freeBalance[account][address(baseToken)] + lockedBalance[account][address(baseToken)];
        return int256(quote * Clearing.PRICE_SCALE + base * price);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
