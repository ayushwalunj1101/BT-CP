/** Swap fee of SimpleAMM, in basis points (30 = 0.3%). */
export const AMM_FEE_BPS = 30n;
export const BPS = 10_000n;

/** Exactly the formula in SimpleAMM._amountOut, in integer maths, so off-chain results match to the wei. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) throw new Error("pool has no liquidity");
  const inWithFee = amountIn * (BPS - AMM_FEE_BPS);
  return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
}

/** The minimum output a trader accepts when they allow `slippageBps` below the quoted amount. */
export function minOutWithSlippage(quote: bigint, slippageBps: bigint): bigint {
  return (quote * (BPS - slippageBps)) / BPS;
}

/** How much worse `actual` is than `fair`, in basis points with two decimals. 87 bps = 0.87%. */
export function shortfallBps(fair: bigint, actual: bigint): number {
  if (fair === 0n) return 0;
  return Number(((fair - actual) * 1_000_000n) / fair) / 100;
}
