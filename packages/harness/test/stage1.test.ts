/**
 * Stage 1 end to end: a fresh Anvil chain, the deployed contracts, the live bot, a real victim trade.
 * Blocks are mined by hand so each test controls exactly what lands in a block.
 */
import { join } from "node:path";
import { parseUnits } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOYMENTS_DIR, ROLE, anvilWallet, getAmountOut, read } from "@obscura/shared";
import { type Stage1Env, startStage1 } from "../src/env.ts";
import { runMeasurement } from "../src/measurement.ts";
import { sendVictimSwap, swapOutput } from "../src/victim.ts";

const PORT = 8571;
let env: Stage1Env;

beforeAll(async () => {
  env = await startStage1({
    port: PORT,
    mining: { mode: "manual" },
    deploymentFile: join(DEPLOYMENTS_DIR, `test-${PORT}.json`),
    removeDeploymentOnStop: true,
    botLog: () => {},
  });
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

const reserves = () => Promise.all([read<bigint>(env.amm, "reserve0"), read<bigint>(env.amm, "reserve1")]);
const musdBalance = (who: string) => read<bigint>(env.musd, "balanceOf", who);
const quoteOnChain = (tokenIn: string, amountIn: bigint) =>
  read<bigint>(env.amm, "getAmountOut", tokenIn, amountIn);

describe("Stage 1 on a live chain", () => {
  it("the off-chain AMM maths matches the deployed contract to the wei", async () => {
    const [tkn, musd] = await reserves();
    for (const amount of ["1", "123.456", "50000", "999999"]) {
      const amountIn = parseUnits(amount, 18);
      expect(await quoteOnChain(env.deployment.musd, amountIn)).toBe(getAmountOut(amountIn, musd, tkn));
      expect(await quoteOnChain(env.deployment.tkn, amountIn)).toBe(getAmountOut(amountIn, tkn, musd));
    }
  });

  it("sandwiches a victim: front-run, victim, back-run in one block", async () => {
    const victim = anvilWallet(ROLE.victim, env.provider);
    const botMusdBefore = await musdBalance(env.bot.address);

    const sent = await sendVictimSwap(env.deployment, victim, {
      side: "buy",
      amountIn: parseUnits("50000", 18),
      slippageBps: 100n,
    });
    const decision = await env.bot.waitForDecision(sent.tx.hash);
    expect(decision.action).toBe("attack");
    if (decision.action !== "attack") return;

    await env.provider.send("evm_mine", []);
    const block = await env.provider.getBlock("latest");
    expect(block?.transactions).toEqual([decision.frontHash, sent.tx.hash, decision.backHash]);

    const receipt = await env.provider.getTransactionReceipt(sent.tx.hash);
    const victimOut = swapOutput(receipt!, env.deployment.amm)!;
    expect(victimOut).toBeGreaterThanOrEqual(sent.minOut); // the victim's trade still went through…
    expect(victimOut).toBeLessThan(sent.quote); // …but at a worse price than quoted

    const botMusdAfter = await musdBalance(env.bot.address);
    expect(botMusdAfter - botMusdBefore).toBe(decision.plan.profit); // exactly what the bot planned
  });

  it("leaves a trade alone when it is too small to profit from", async () => {
    const victim = anvilWallet(ROLE.victim, env.provider);
    const sent = await sendVictimSwap(env.deployment, victim, {
      side: "sell",
      amountIn: parseUnits("1", 18),
      slippageBps: 100n,
    });
    const decision = await env.bot.waitForDecision(sent.tx.hash);
    expect(decision.action).toBe("skip");

    await env.provider.send("evm_mine", []);
    const block = await env.provider.getBlock("latest");
    expect(block?.transactions).toEqual([sent.tx.hash]);
  });
});

describe("measurement harness", () => {
  it("measures extraction, and never more than the victim's slippage allowance", async () => {
    const { rows, summary } = await runMeasurement({
      trades: 6,
      seed: 7,
      slippageBps: 100n,
      minSizeBps: 50,
      maxSizeBps: 500,
      port: PORT + 1,
    });

    expect(rows).toHaveLength(6);
    expect(summary.attacked).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.attacked) {
        expect(row.extractionBps).toBeGreaterThan(0);
        expect(row.botProfitMusd).toBeGreaterThan(0n);
      } else {
        expect(row.extractionBps).toBe(0); // no bot, no difference between the two runs
      }
      expect(row.extractionBps).toBeLessThanOrEqual(100); // capped by the victim's 1% limit
    }
  }, 120_000);
});
