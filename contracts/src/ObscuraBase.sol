// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clearing, Order} from "./libraries/Clearing.sol";

/// @title ObscuraBase
/// @notice Shared core of the Obscura auctions: the deposit ledger, the epoch clock, ETH bonds, and the
///         maths that moves funds when a batch settles at one price. The v1 commit-reveal auction and the
///         Stage 4 zero-knowledge auction both build on it.
/// @dev There is no owner and no admin function. Forfeited and slashed ETH stays in the treasury for good.
///      ETH owed to people is credited and then withdrawn by them ("pull"), so nobody can block a settlement
///      by refusing a payment.
abstract contract ObscuraBase is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        NotStarted,
        Commit,
        Reveal,
        Solve,
        Settleable,
        Settled,
        Voided
    }

    enum Status {
        Open,
        Settled,
        Voided
    }

    struct Config {
        uint64 commitBlocks;
        uint64 revealBlocks;
        uint64 solveBlocks;
        uint256 revealBond; // ETH a trader posts with a commitment, returned on reveal
        uint256 solverBond; // ETH a solver posts with a solution, slashed if the solution is invalid
        uint256 solverReward; // mUSD paid from the fee pool for each settled batch with trades
        uint256 maxOrders; // commitments per batch, which caps settlement gas
        uint256 maxSolutions; // solutions per batch
    }

    IERC20 public immutable baseToken; // TKN
    IERC20 public immutable quoteToken; // mUSD
    uint256 public immutable genesisBlock;
    uint64 public immutable commitBlocks;
    uint64 public immutable revealBlocks;
    uint64 public immutable solveBlocks;
    uint256 public immutable revealBond;
    uint256 public immutable solverBond;
    uint256 public immutable solverReward;
    uint256 public immutable maxOrders;
    uint256 public immutable maxSolutions;

    /// @notice Deposited funds a trader can withdraw or trade with.
    mapping(address trader => mapping(address token => uint256)) public freeBalance;
    /// @notice Funds locked behind revealed orders until their batch settles.
    mapping(address trader => mapping(address token => uint256)) public lockedBalance;
    mapping(address token => uint256) public totalFree;
    mapping(address token => uint256) public totalLocked;
    /// @notice mUSD that pays solver rewards: funded by anyone, topped up by settlement rounding dust.
    uint256 public feePool;

    /// @notice ETH owed to an account (refunded or won bonds), collected with withdrawEth().
    mapping(address account => uint256) public claimableEth;
    uint256 public totalClaimableEth;
    /// @notice ETH bonds currently held for open commitments and solutions.
    uint256 public bondsHeld;
    /// @notice Forfeited and slashed ETH. Nobody can withdraw it.
    uint256 public treasuryEth;

    mapping(uint256 epoch => Status) public epochStatus;

    event Deposited(address indexed trader, address indexed token, uint256 amount);
    event Withdrawn(address indexed trader, address indexed token, uint256 amount);
    event FeePoolFunded(address indexed funder, uint256 amount);
    event EthWithdrawn(address indexed account, uint256 amount);

    error InvalidConfig();
    error UnknownToken(address token);
    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 required);
    error WrongPhase(uint256 epoch, Phase phase);
    error NothingToWithdraw();
    error EthTransferFailed();

    constructor(IERC20 base_, IERC20 quote_, Config memory config) {
        if (
            address(base_) == address(quote_) || config.commitBlocks == 0 || config.revealBlocks == 0
                || config.solveBlocks == 0 || config.revealBond == 0 || config.solverBond == 0
                || config.maxOrders == 0 || config.maxSolutions == 0
        ) revert InvalidConfig();
        baseToken = base_;
        quoteToken = quote_;
        genesisBlock = block.number;
        commitBlocks = config.commitBlocks;
        revealBlocks = config.revealBlocks;
        solveBlocks = config.solveBlocks;
        revealBond = config.revealBond;
        solverBond = config.solverBond;
        solverReward = config.solverReward;
        maxOrders = config.maxOrders;
        maxSolutions = config.maxSolutions;
    }

    // ------------------------------------------------------------------ epoch clock

    /// @notice Blocks in one batch: commit, then reveal, then solve.
    function epochLength() public view returns (uint256) {
        return uint256(commitBlocks) + revealBlocks + solveBlocks;
    }

    /// @notice The batch whose window contains the current block.
    function currentEpoch() public view returns (uint256) {
        return (block.number - genesisBlock) / epochLength();
    }

    function epochStartBlock(uint256 epoch) public view returns (uint256) {
        return genesisBlock + epoch * epochLength();
    }

    /// @notice Where `epoch` is in its life. Batches run back to back; after its solve window a batch
    ///         stays Settleable until someone calls settle().
    function phaseOf(uint256 epoch) public view returns (Phase) {
        Status status = epochStatus[epoch];
        if (status == Status.Settled) return Phase.Settled;
        if (status == Status.Voided) return Phase.Voided;
        uint256 start = epochStartBlock(epoch);
        if (block.number < start) return Phase.NotStarted;
        uint256 offset = block.number - start;
        if (offset < commitBlocks) return Phase.Commit;
        if (offset < uint256(commitBlocks) + revealBlocks) return Phase.Reveal;
        if (offset < epochLength()) return Phase.Solve;
        return Phase.Settleable;
    }

    // ------------------------------------------------------------------ ledger

    /// @notice Move tokens into Obscura. A deposit is not tied to any order, so it reveals nothing about one.
    function deposit(address token, uint256 amount) external nonReentrant {
        _requireKnownToken(token);
        if (amount == 0) revert ZeroAmount();
        _creditFree(msg.sender, token, amount);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Take free (unlocked) tokens back out.
    function withdraw(address token, uint256 amount) external nonReentrant {
        _requireKnownToken(token);
        if (amount == 0) revert ZeroAmount();
        _debitFree(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice Add mUSD to the pool that pays solver rewards.
    function fundFeePool(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        feePool += amount;
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        emit FeePoolFunded(msg.sender, amount);
    }

    /// @notice Collect ETH owed to you: refunded solver bonds, or your share of a slashed bond.
    function withdrawEth() external nonReentrant {
        uint256 amount = claimableEth[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        claimableEth[msg.sender] = 0;
        totalClaimableEth -= amount;
        emit EthWithdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    // ------------------------------------------------------------------ invariant I1

    /// @notice I1, conservation: the contract really holds at least everything its ledger says it owes,
    ///         in TKN, in mUSD and in ETH. "At least", so tokens sent to the contract by mistake cannot make
    ///         it look broken.
    function checkI1() public view virtual returns (bool) {
        address base = address(baseToken);
        address quote = address(quoteToken);
        return baseToken.balanceOf(address(this)) >= totalFree[base] + totalLocked[base]
            && quoteToken.balanceOf(address(this)) >= totalFree[quote] + totalLocked[quote] + feePool
            && address(this).balance >= bondsHeld + totalClaimableEth + treasuryEth;
    }

    // ------------------------------------------------------------------ internals

    function _requirePhase(uint256 epoch, Phase expected) internal view {
        Phase actual = phaseOf(epoch);
        if (actual != expected) revert WrongPhase(epoch, actual);
    }

    function _requireKnownToken(address token) internal view {
        if (token != address(baseToken) && token != address(quoteToken)) revert UnknownToken(token);
    }

    function _creditFree(address trader, address token, uint256 amount) internal {
        freeBalance[trader][token] += amount;
        totalFree[token] += amount;
    }

    function _debitFree(address trader, address token, uint256 amount) internal {
        uint256 available = freeBalance[trader][token];
        if (available < amount) revert InsufficientBalance(available, amount);
        freeBalance[trader][token] = available - amount;
        totalFree[token] -= amount;
    }

    /// @dev Takes locked funds out of the ledger; the caller must credit them somewhere.
    function _releaseLocked(address trader, address token, uint256 amount) internal {
        lockedBalance[trader][token] -= amount;
        totalLocked[token] -= amount;
    }

    function _creditEth(address account, uint256 amount) internal {
        claimableEth[account] += amount;
        totalClaimableEth += amount;
    }

    /// @dev What an order locks at reveal: a buy locks its worst-case cost in mUSD, a sell locks its TKN.
    function _lockedBy(Order memory o) internal view returns (address token, uint256 amount) {
        return o.isBuy
            ? (address(quoteToken), Clearing.quoteUp(o.amount, o.limitPrice))
            : (address(baseToken), uint256(o.amount));
    }

    /// @dev Moves `amount` of `trader`'s free balance into their locked balance.
    function _lock(address trader, address token, uint256 amount) internal {
        _debitFree(trader, token, amount);
        lockedBalance[trader][token] += amount;
        totalLocked[token] += amount;
    }

    /// @dev Moves `amount` of `trader`'s locked balance back to free.
    function _unlock(address trader, address token, uint256 amount) internal {
        _releaseLocked(trader, token, amount);
        _creditFree(trader, token, amount);
    }

    function _lockOrder(Order memory o) internal {
        (address token, uint256 amount) = _lockedBy(o);
        _lock(o.trader, token, amount);
    }

    function _unlockOrder(Order memory o) internal {
        (address token, uint256 amount) = _lockedBy(o);
        _unlock(o.trader, token, amount);
    }

    /// @dev Settles one order at the batch price and unlocks whatever it did not use.
    ///      A buyer pays fill × price rounded up; a seller receives it rounded down. The caller sends the
    ///      difference (rounding dust) to the fee pool, so no token is created or lost.
    /// @return quoteAmount mUSD paid by a buyer or received by a seller
    function _settleOrder(Order memory o, uint256 fill, uint256 price)
        internal
        virtual
        returns (uint256 quoteAmount)
    {
        if (o.isBuy) {
            uint256 locked = Clearing.quoteUp(o.amount, o.limitPrice);
            quoteAmount = fill == 0 ? 0 : Clearing.quoteUp(fill, price);
            _releaseLocked(o.trader, address(quoteToken), locked);
            _creditFree(o.trader, address(quoteToken), locked - quoteAmount);
            if (fill > 0) _creditFree(o.trader, address(baseToken), fill);
        } else {
            _releaseLocked(o.trader, address(baseToken), o.amount);
            if (o.amount > fill) _creditFree(o.trader, address(baseToken), o.amount - fill);
            quoteAmount = fill == 0 ? 0 : Clearing.quoteDown(fill, price);
            if (quoteAmount > 0) _creditFree(o.trader, address(quoteToken), quoteAmount);
        }
    }
}
