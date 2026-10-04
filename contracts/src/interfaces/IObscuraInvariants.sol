// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The four rules that must always hold. Each returns false only if the rule is broken.
interface IObscuraInvariants {
    /// @notice I1, conservation: the contract holds at least what its ledger owes, in every asset.
    function checkI1() external view returns (bool);

    /// @notice I2, uniform price: every fill in `epoch` used the batch's single clearing price.
    function checkI2(uint256 epoch) external view returns (bool);

    /// @notice I3, limit respect: no fill in `epoch` was worse for its trader than their limit.
    function checkI3(uint256 epoch) external view returns (bool);

    /// @notice I4, solver honesty: the winning solver of `epoch` gained no more than the declared reward.
    function checkI4(uint256 epoch) external view returns (bool);
}
