import { describe, expect, it } from "vitest";
import { getAmountOut, minOutWithSlippage } from "@obscura/shared";
import { DUST_PROFIT, maxFrontrun, planSandwich, simulateSandwich } from "../src/sandwich.ts";

const e18 = 10n ** 18n;
// Same pool as the Solidity tests: 10,000,000 mUSD and 100,000 TKN (100 mUSD per TKN).
// The victim buys TKN with mUSD, so mUSD is "in" and TKN is "out".
const POOL = { reserveIn: 10_000_000n * e18, reserveOut: 100_000n * e18 };
const BUDGET = 5_000_000n * e18;

function victimBuying(amountMusd: bigint, slippageBps: bigint) {
  const amountIn = amountMusd * e18;
  const fair = getAmountOut(amountIn, POOL.reserveIn, POOL.reserveOut);
  return { amountIn, minOut: minOutWithSlippage(fair, slippageBps), fair };
}

describe("simulateSandwich", () => {
  it("matches the Solidity sandwich test to the wei", () => {
    // contracts/test/unit/SimpleAMM.t.sol: test_Sandwich_ProfitsBotAndCostsVictim
    const victim = victimBuying(50_000n, 100n);
    const plan = simulateSandwich(40_000n * e18, POOL, victim);
    expect(plan.profit).toBe(156_937522897291873389n);
    expect(plan.victimOut).toBeGreaterThanOrEqual(victim.minOut);
    expect(plan.victimOut).toBeLessThan(victim.fair);
  });

  it("with no front-run, the victim gets exactly the fair quote", () => {
    const victim = victimBuying(50_000n, 100n);
    expect(simulateSandwich(0n, POOL, victim).victimOut).toBe(victim.fair);
  });
});

describe("maxFrontrun", () => {
  it("finds the exact edge of the victim's slippage limit", () => {
    const victim = victimBuying(50_000n, 100n);
    const largest = maxFrontrun(POOL, victim, BUDGET);
    expect(simulateSandwich(largest, POOL, victim).victimOut).toBeGreaterThanOrEqual(victim.minOut);
    expect(simulateSandwich(largest + 1n, POOL, victim).victimOut).toBeLessThan(victim.minOut);
  });

  it("allows only a dust-sized front-run when the victim allows no slippage", () => {
    // Integer rounding in the AMM lets a few thousand wei slip through without changing the victim's output.
    expect(maxFrontrun(POOL, victimBuying(50_000n, 0n), BUDGET)).toBeLessThan(1_000_000n);
  });

  it("never exceeds the bot's budget", () => {
    expect(maxFrontrun(POOL, victimBuying(500_000n, 300n), 1_000n * e18)).toBe(1_000n * e18);
  });
});

describe("planSandwich", () => {
  it("attacks a mid-sized trade and keeps the victim inside their limit", () => {
    const victim = victimBuying(50_000n, 100n);
    const plan = planSandwich(POOL, victim, BUDGET);
    expect(plan).not.toBeNull();
    expect(plan!.profit).toBeGreaterThan(0n);
    expect(plan!.victimOut).toBeGreaterThanOrEqual(victim.minOut);
  });

  it("takes more from victims who allow more slippage", () => {
    const tight = planSandwich(POOL, victimBuying(100_000n, 50n), BUDGET)!;
    const loose = planSandwich(POOL, victimBuying(100_000n, 200n), BUDGET)!;
    expect(loose.profit).toBeGreaterThan(tight.profit);
  });

  it("skips a trade too small to pay for the bot's own fees", () => {
    // A 100 mUSD trade barely moves a 10M pool; the 0.3% fee on each bot trade outweighs the gain.
    expect(planSandwich(POOL, victimBuying(100n, 100n), BUDGET)).toBeNull();
  });

  it("skips when the victim allows no slippage, once dust profits are ignored", () => {
    const victim = victimBuying(50_000n, 0n);
    // Without a threshold, rounding yields a sandwich worth a few wei, far less than its gas.
    expect(planSandwich(POOL, victim, BUDGET)!.profit).toBeLessThan(1_000n);
    expect(planSandwich(POOL, victim, BUDGET, DUST_PROFIT)).toBeNull();
  });
});
