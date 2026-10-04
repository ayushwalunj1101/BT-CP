// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SimpleAMM
/// @notice A minimal constant-product exchange (x * y = k) with a 0.3% fee.
///         This is the "normal DEX" from the brief: trades execute one at a time, and each trade moves
///         the price for the next one. That is exactly what makes a sandwich attack possible.
/// @dev Liquidity is added once to seed the experiment. LP shares and withdrawals are out of scope.
contract SimpleAMM {
    using SafeERC20 for IERC20;

    /// @notice Swap fee in basis points (30 = 0.3%), the same as Uniswap v2.
    uint256 public constant FEE_BPS = 30;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1);
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        address indexed to
    );

    error IdenticalTokens();
    error UnknownToken(address token);
    error ZeroAmount();
    error NoLiquidity();
    error SlippageExceeded(uint256 amountOut, uint256 minOut);

    constructor(IERC20 token0_, IERC20 token1_) {
        if (address(token0_) == address(token1_)) revert IdenticalTokens();
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Add both tokens to the pool. Used once to seed the experiment.
    function addLiquidity(uint256 amount0, uint256 amount1) external {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        reserve0 += amount0;
        reserve1 += amount1;
        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);
        emit LiquidityAdded(msg.sender, amount0, amount1);
    }

    /// @notice How much of the other token `amountIn` of `tokenIn` would buy at the current reserves.
    function getAmountOut(address tokenIn, uint256 amountIn) external view returns (uint256) {
        (uint256 reserveIn, uint256 reserveOut) =
            _isToken0(tokenIn) ? (reserve0, reserve1) : (reserve1, reserve0);
        return _amountOut(amountIn, reserveIn, reserveOut);
    }

    /// @notice Sell exactly `amountIn` of `tokenIn` for at least `minOut` of the other token, sent to `to`.
    /// @dev `minOut` is the trader's slippage limit. A sandwich bot pushes the price as far as this limit allows.
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        bool zeroForOne = _isToken0(tokenIn);
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);

        amountOut = _amountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        (IERC20 inToken, IERC20 outToken) = zeroForOne ? (token0, token1) : (token1, token0);
        if (zeroForOne) {
            reserve0 = reserveIn + amountIn;
            reserve1 = reserveOut - amountOut;
        } else {
            reserve1 = reserveIn + amountIn;
            reserve0 = reserveOut - amountOut;
        }

        inToken.safeTransferFrom(msg.sender, address(this), amountIn);
        outToken.safeTransfer(to, amountOut);
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, to);
    }

    function _isToken0(address token) private view returns (bool) {
        if (token == address(token0)) return true;
        if (token == address(token1)) return false;
        revert UnknownToken(token);
    }

    /// @dev Constant product with the fee taken from the input: out = in·(1−fee)·Rout / (Rin + in·(1−fee)).
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private
        pure
        returns (uint256)
    {
        if (reserveIn == 0 || reserveOut == 0) revert NoLiquidity();
        uint256 inWithFee = amountIn * (BPS - FEE_BPS);
        return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
    }
}
