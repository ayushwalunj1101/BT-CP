/**
 * The sandwich attack as pure maths, with no chain involved.
 *
 * A victim sells `amountIn` of token A for token B and accepts no less than `minOut`.
 * The bot:
 *   1. front-runs: sells `frontIn` of A for B first, which makes B more expensive,
 *   2. lets the victim trade at that worse price,
 *   3. back-runs: sells the B it bought back for A, into the price the victim pushed further.
 * Profit = A received in step 3 − A spent in step 1.
 *
 * The victim's `minOut` caps the attack: front-run too much and the victim's trade reverts.
 */
import { getAmountOut } from "@obscura/shared";

export type Reserves = { reserveIn: bigint; reserveOut: bigint };
export type VictimSwap = { amountIn: bigint; minOut: bigint };

export type SandwichPlan = {
  /** Token A the bot spends in the front-run. */
  frontIn: bigint;
  /** Token B the bot receives in the front-run, and sells again in the back-run. */
  frontOut: bigint;
  /** Token B the victim receives, after the front-run. */
  victimOut: bigint;
  /** Token A the bot receives in the back-run. */
  backOut: bigint;
  /** backOut − frontIn, in token A. Can be negative. */
  profit: bigint;
};

/** Play out front-run → victim → back-run on a copy of the pool's reserves. */
export function simulateSandwich(frontIn: bigint, pool: Reserves, victim: VictimSwap): SandwichPlan {
  let reserveA = pool.reserveIn;
  let reserveB = pool.reserveOut;

  const frontOut = getAmountOut(frontIn, reserveA, reserveB);
  reserveA += frontIn;
  reserveB -= frontOut;

  const victimOut = getAmountOut(victim.amountIn, reserveA, reserveB);
  reserveA += victim.amountIn;
  reserveB -= victimOut;

  const backOut = getAmountOut(frontOut, reserveB, reserveA);
  return { frontIn, frontOut, victimOut, backOut, profit: backOut - frontIn };
}

/**
 * The largest front-run, up to `budget`, that still leaves the victim at or above `minOut`.
 * The victim's output only falls as the front-run grows, so a binary search finds the edge.
 */
export function maxFrontrun(pool: Reserves, victim: VictimSwap, budget: bigint): bigint {
  const victimSucceeds = (frontIn: bigint) =>
    simulateSandwich(frontIn, pool, victim).victimOut >= victim.minOut;
  if (budget <= 0n || !victimSucceeds(0n)) return 0n;
  if (victimSucceeds(budget)) return budget;

  let ok = 0n;
  let tooBig = budget;
  while (tooBig - ok > 1n) {
    const mid = (ok + tooBig) / 2n;
    if (victimSucceeds(mid)) ok = mid;
    else tooBig = mid;
  }
  return ok;
}

/** How finely planSandwich samples front-run sizes between zero and the maximum. */
const SAMPLES = 64n;

/**
 * Profits at or below 0.01 of a token are ignored. Integer rounding in the AMM lets dust-sized
 * front-runs "earn" a few wei even against a victim who allows no slippage; that never pays for gas.
 */
export const DUST_PROFIT = 10n ** 16n;

/**
 * The most profitable sandwich within the victim's slippage limit, or null if none clears `minProfit`.
 * Profit usually peaks at the largest allowed front-run, but the 0.3% fee on both bot trades can make
 * a smaller one better, so we sample the whole allowed range.
 */
export function planSandwich(
  pool: Reserves,
  victim: VictimSwap,
  budget: bigint,
  minProfit = 0n,
): SandwichPlan | null {
  const largest = maxFrontrun(pool, victim, budget);
  if (largest === 0n) return null;

  let best: SandwichPlan | null = null;
  for (let k = 1n; k <= SAMPLES; k++) {
    const plan = simulateSandwich((largest * k) / SAMPLES, pool, victim);
    if (!best || plan.profit > best.profit) best = plan;
  }
  return best && best.profit > minProfit ? best : null;
}
