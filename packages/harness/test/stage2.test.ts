/**
 * Stage 2 end to end: sealed batches on a live chain, with the solver, six simulated traders, a victim,
 * and the bot watching. Blocks are mined by hand so each test controls every phase.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOYMENTS_DIR, PRICE_SCALE, ROLE, type SealedOrder, anvilWallet, read } from "@obscura/shared";
import { type BookOrder, clearBatch } from "@obscura/solver";
import { type BatchPlan, runManualBatch } from "../src/batch.ts";
import { type LocalEnv, startLocalEnv } from "../src/env.ts";
import { runObscuraMeasurement } from "../src/obscuraMeasurement.ts";
import { mulberry32 } from "../src/random.ts";
import { TRADER_ACCOUNTS, randomOrders, seededSalt } from "../src/traders.ts";

const PORT = 8581;
const e18 = 10n ** 18n;
let env: LocalEnv;

type FillView = { trader: string; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint };

beforeAll(async () => {
  env = await startLocalEnv({
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

/** Six traders around 100 mUSD, plus a victim buying 300 TKN at up to 101. */
function plan(seed: number): BatchPlan {
  const random = mulberry32(seed);
  const victim: SealedOrder = {
    isBuy: true,
    amount: 300n * e18,
    limitPrice: 101n * e18,
    salt: seededSalt(random),
  };
  return { traders: randomOrders(random, 100n * e18, TRADER_ACCOUNTS.length), victim };
}

async function assertConservation() {
  const [tknHeld, musdHeld, freeT, lockedT, freeM, lockedM, feePool] = await Promise.all([
    read<bigint>(env.tkn, "balanceOf", env.deployment.auction),
    read<bigint>(env.musd, "balanceOf", env.deployment.auction),
    read<bigint>(env.auction, "totalFree", env.deployment.tkn),
    read<bigint>(env.auction, "totalLocked", env.deployment.tkn),
    read<bigint>(env.auction, "totalFree", env.deployment.musd),
    read<bigint>(env.auction, "totalLocked", env.deployment.musd),
    read<bigint>(env.auction, "feePool"),
  ]);
  expect(tknHeld).toBe(freeT + lockedT);
  expect(musdHeld).toBe(freeM + lockedM + feePool);
}

describe("Stage 2 on a live chain", () => {
  it("a full batch clears at one price, and no token is created or lost", async () => {
    const outcome = await runManualBatch(env, plan(1), false);
    const fills = await read<FillView[]>(env.auction, "getFills", outcome.epoch);

    expect(fills.length).toBeGreaterThan(1);
    for (const f of fills) {
      // Every fill at the same p*. Buyers round up and sellers round down, by at most 1 wei.
      const exact = (f.baseAmount * outcome.price) / PRICE_SCALE;
      expect(f.quoteAmount >= exact && f.quoteAmount - exact <= 1n).toBe(true);
    }
    const bought = fills.filter((f) => f.isBuy).reduce((s, f) => s + f.baseAmount, 0n);
    const sold = fills.filter((f) => !f.isBuy).reduce((s, f) => s + f.baseAmount, 0n);
    expect(bought).toBe(sold);
    expect(outcome.price).toBeLessThanOrEqual(101n * e18); // never above the victim's limit
    await assertConservation();
  });

  it("the bot sees only a sealed hash, and sends nothing", async () => {
    const outcome = await runManualBatch(env, plan(2), true);
    expect(outcome.decision).toMatchObject({ action: "skip", reason: "sealed order" });

    const bot = anvilWallet(ROLE.bot).address.toLowerCase();
    const latest = await env.provider.getBlockNumber();
    for (let b = latest - 12; b <= latest; b++) {
      const block = await env.provider.getBlock(b, true);
      expect(block!.prefetchedTransactions.some((t) => t.from.toLowerCase() === bot)).toBe(false);
    }
  });

  it("the solver's clearing passes the contract's own check on 1,000 random books", async () => {
    const random = mulberry32(99);
    const randomBook = (): BookOrder[] =>
      Array.from({ length: 1 + Math.floor(random() * 20) }, () => ({
        isBuy: random() < 0.5,
        // Prices on a 0.5 grid between 90 and 110, so many orders share a price and must be rationed.
        limitPrice: BigInt(180 + Math.floor(random() * 41)) * (e18 / 2n),
        // Mostly whole amounts, sometimes odd wei amounts to exercise rounding.
        amount:
          random() < 0.8
            ? BigInt(1 + Math.floor(random() * 1000)) * (e18 / 10n)
            : BigInt(1 + Math.floor(random() * 1e9)),
      }));

    let checked = 0;
    let tampered = 0;
    const books = Array.from({ length: 1000 }, randomBook);
    for (let i = 0; i < books.length; i += 50) {
      await Promise.all(
        books.slice(i, i + 50).map(async (book) => {
          const clearing = clearBatch(book)!;
          const orders = book.map((o) => ({ trader: env.deployment.tkn, ...o }));
          const [ok, volume] = await read<[boolean, bigint]>(
            env.auction,
            "checkClearing",
            orders,
            clearing.price,
            clearing.fills,
          );
          expect(ok).toBe(true);
          expect(volume).toBe(clearing.volume);
          checked++;

          // One extra wei on any order with room breaks the balance, and the contract must notice.
          const room = clearing.fills.findIndex((f, j) => f < book[j]!.amount);
          if (room >= 0) {
            const bad = [...clearing.fills];
            bad[room] = bad[room]! + 1n;
            const [badOk] = await read<[boolean, bigint]>(
              env.auction,
              "checkClearing",
              orders,
              clearing.price,
              bad,
            );
            expect(badOk).toBe(false);
            tampered++;
          }
        }),
      );
    }
    expect(checked).toBe(1000);
    expect(tampered).toBeGreaterThan(900);
  }, 120_000);
});

describe("Obscura measurement", () => {
  it("the bot extracts nothing from batched trades", async () => {
    const { rows } = await runObscuraMeasurement({
      trades: 3,
      seed: 5,
      slippageBps: 100n,
      minSizeBps: 50,
      maxSizeBps: 500,
      port: PORT + 1,
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.attacked).toBe(false);
      expect(r.extractionBps).toBe(0);
      expect(r.botProfitMusd).toBe(0n);
      expect(r.actualOut).toBe(r.fairOut);
    }
  }, 180_000);
});
