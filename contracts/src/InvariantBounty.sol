// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IObscuraInvariants} from "./interfaces/IObscuraInvariants.sol";

/// @title InvariantBounty
/// @notice A vault of test funds that pays out, automatically and in full, to the first person who proves
///         one of Obscura's four rules (I1 to I4) broken. Nobody approves the payout and nobody can stop it:
///         the contract checks the rule itself, in the same transaction.
///
///         Claims are commit-reveal (attack A6 in the brief). Otherwise a bot could copy a pending claim
///         and take the payout. First commit a hash that includes your own address; after `claimDelay`
///         blocks, claim with the details. A copied claim comes from a different address, so its hash
///         matches no commitment.
/// @dev There is no owner and no way to withdraw except a valid claim.
contract InvariantBounty {
    using SafeERC20 for IERC20;

    IObscuraInvariants public immutable target;
    IERC20 public immutable rewardToken;
    uint256 public immutable claimDelay;

    /// @notice Block in which each claim hash was first committed.
    mapping(bytes32 claimHash => uint256 blockNumber) public committedAt;
    bool public paid;

    event Funded(address indexed funder, uint256 amount);
    event ClaimCommitted(bytes32 indexed claimHash, uint256 blockNumber);
    event BountyPaid(address indexed claimant, uint8 indexed invariantId, uint256 epoch, uint256 amount);

    error InvalidDelay();
    error ZeroAmount();
    error AlreadyPaid();
    error NoCommitment();
    error TooEarly(uint256 readyAtBlock);
    error UnknownInvariant(uint8 invariantId);
    error NoViolation(uint8 invariantId, uint256 epoch);

    constructor(IObscuraInvariants target_, IERC20 rewardToken_, uint256 claimDelay_) {
        if (claimDelay_ == 0) revert InvalidDelay();
        target = target_;
        rewardToken = rewardToken_;
        claimDelay = claimDelay_;
    }

    /// @notice Add test funds to the vault.
    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        emit Funded(msg.sender, amount);
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function vaultBalance() external view returns (uint256) {
        return rewardToken.balanceOf(address(this));
    }

    /// @notice The sealed form of a claim. `invariantId` is 1 to 4; `epoch` is ignored for I1.
    function claimHash(address claimant, uint8 invariantId, uint256 epoch, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(claimant, invariantId, epoch, salt));
    }

    /// @notice True if rule `invariantId` is broken right now (for I2 to I4, in batch `epoch`).
    function isViolated(uint8 invariantId, uint256 epoch) public view returns (bool) {
        if (invariantId == 1) return !target.checkI1();
        if (invariantId == 2) return !target.checkI2(epoch);
        if (invariantId == 3) return !target.checkI3(epoch);
        if (invariantId == 4) return !target.checkI4(epoch);
        revert UnknownInvariant(invariantId);
    }

    /// @notice Step 1: post the sealed claim. Committing the same hash twice keeps the earlier block.
    function commitClaim(bytes32 hash) external {
        if (paid) revert AlreadyPaid();
        if (committedAt[hash] != 0) return;
        committedAt[hash] = block.number;
        emit ClaimCommitted(hash, block.number);
    }

    /// @notice Step 2, at least `claimDelay` blocks later: prove the rule is broken and receive the whole vault.
    function claim(uint8 invariantId, uint256 epoch, bytes32 salt) external {
        if (paid) revert AlreadyPaid();
        uint256 at = committedAt[claimHash(msg.sender, invariantId, epoch, salt)];
        if (at == 0) revert NoCommitment();
        if (block.number < at + claimDelay) revert TooEarly(at + claimDelay);
        if (!isViolated(invariantId, epoch)) revert NoViolation(invariantId, epoch);

        paid = true;
        uint256 amount = rewardToken.balanceOf(address(this));
        emit BountyPaid(msg.sender, invariantId, epoch, amount);
        rewardToken.safeTransfer(msg.sender, amount);
    }
}
