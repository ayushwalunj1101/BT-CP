/**
 * The clearing circuit (tasks 4.3 and 4.4): a valid batch proves and verifies; every way of cheating fails.
 * Witness generation is enough to show a rule holds: it throws as soon as any constraint is broken.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { ZK_SLOTS, type ZkOrder, type ZkSlot, decodeFill, zkCommitment } from "@obscura/shared";
import { checkWitness, proveClearing, shutdownProver, solveZkBatch, verifyClearing } from "@obscura/solver";

const EPOCH = 7n;
const traders = Array.from({ length: ZK_SLOTS }, (_, i) =>
  getAddress("0x" + keccak256(toUtf8Bytes(`trader-${i}`)).slice(26)),
);

/** 8 buyers and 8 sellers around 100.00 mUSD (10,000 ticks), 1 to 20 TKN each, all well funded. */
const orders: ZkOrder[] = traders.map((_, i) => ({
  isBuy: i % 2 === 0,
  limitTicks: i % 2 === 0 ? 9_950n + BigInt(i) * 20n : 9_900n + BigInt(i) * 15n,
  amountLots: 1_000n + BigInt(i) * 1_200n,
  salt: BigInt(keccak256(toUtf8Bytes(`salt-${i}`))) >> 8n,
}));
const slots: ZkSlot[] = traders.map((trader, i) => ({
  trader,
  commitment: zkCommitment(trader, EPOCH, orders[i]!),
  lockBase: 10n ** 24n,
  lockQuote: 10n ** 28n,
}));

type Input = Record<string, string | string[]>;
const valid = solveZkBatch(EPOCH, slots, orders);
/** A copy of the valid input with some fields replaced. */
const tamper = (changes: (input: Input) => void): Input => {
  const copy = JSON.parse(JSON.stringify(valid.input)) as Input;
  changes(copy);
  return copy;
};
const at = (input: Input, key: string) => input[key] as string[];

afterAll(async () => {
  await shutdownProver();
});

describe("clearing circuit: a valid batch", () => {
  let proof: Awaited<ReturnType<typeof proveClearing>>;
  beforeAll(async () => {
    proof = await proveClearing(valid.input);
  }, 120_000);

  it("trades something, at one price, inside the range of limits", () => {
    expect(valid.volumeLots).toBeGreaterThan(0n);
    expect(valid.priceTicks).toBeGreaterThanOrEqual(9_900n);
    expect(valid.priceTicks).toBeLessThanOrEqual(10_250n);
  });

  it("proves, and the proof verifies", async () => {
    expect(await verifyClearing(proof)).toBe(true);
    console.log(`proving time for a 16-order batch: ${proof.ms} ms`);
  });

  it("publishes 98 values, none of them a limit price or an unfilled order's side", () => {
    expect(proof.publicSignals).toHaveLength(98);
    const limits = new Set(orders.map((o) => o.limitTicks));
    const published = proof.publicSignals.slice(2); // after epoch and price
    // A coincidence with a lock or count is possible in general; here no published value is a limit.
    expect(published.some((v) => limits.has(v))).toBe(false);
    const unfilled = valid.fillsLots.flatMap((f, i) => (f === 0n ? [i] : []));
    for (const i of unfilled) expect(proof.publicSignals[82 + i]).toBe(0n); // 0 for a buy or a sell alike
  });

  it("rejects a proof whose public values were changed afterwards", async () => {
    const bumped = [...proof.publicSignals];
    bumped[82] = bumped[82]! + 1n; // one more lot for slot 0
    expect(await verifyClearing({ ...proof, publicSignals: bumped })).toBe(false);
  });
});

describe("clearing circuit: every way to cheat fails", () => {
  it("accepts the untouched input", async () => {
    await expect(checkWitness(valid.input)).resolves.toBeUndefined();
  });

  it("an order that is not the one sealed in the slot", async () => {
    const input = tamper((x) => (at(x, "limit")[0] = String(orders[0]!.limitTicks + 1n)));
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("the same order claimed for another trader's slot (copy-cat, A8)", async () => {
    const input = tamper((x) => (at(x, "trader")[0] = BigInt(traders[1]!).toString()));
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("a crossing order left unfilled (censorship)", async () => {
    // Slot 14 is a buy at 10,230 ticks, far above the price: it must fill completely.
    const i = 14;
    expect(orders[i]!.isBuy && orders[i]!.limitTicks > valid.priceTicks).toBe(true);
    const input = tamper((x) => {
      at(x, "fill")[i] = "0";
      at(x, "fillEnc")[i] = "0";
    });
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("a buyer filled above their limit", async () => {
    // Raise the price above the lowest filled buyer's limit, keeping every fill as it was.
    const lowestFilledBuy = orders
      .map((o, i) => ({ o, i }))
      .filter(({ o, i }) => o.isBuy && valid.fillsLots[i]! > 0n)
      .sort((a, b) => Number(a.o.limitTicks - b.o.limitTicks))[0]!;
    const input = tamper((x) => (x.price = String(lowestFilledBuy.o.limitTicks + 1n)));
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("more TKN bought than sold", async () => {
    const i = valid.fillsLots.findIndex((f, k) => orders[k]!.isBuy && f > 0n && f < orders[k]!.amountLots);
    const buy = i >= 0 ? i : valid.fillsLots.findIndex((f, k) => orders[k]!.isBuy && f > 1n);
    const input = tamper((x) => {
      const f = BigInt(at(x, "fill")[buy]!) - 1n;
      at(x, "fill")[buy] = String(f);
      at(x, "fillEnc")[buy] = String(f);
    });
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("a fill larger than the order", async () => {
    const i = 0;
    const input = tamper((x) => {
      const f = orders[i]!.amountLots + 1n;
      at(x, "fill")[i] = String(f);
      at(x, "fillEnc")[i] = String(f);
    });
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("an unfunded order cannot trade, but cannot block the batch either", async () => {
    // Slot 14's buyer locked only 1 mUSD: their order does not count.
    const poor = slots.map((s, i) => (i === 14 ? { ...s, lockQuote: 10n ** 18n } : s));
    const cleared = solveZkBatch(EPOCH, poor, orders);
    expect(cleared.fillsLots[14]).toBe(0n);
    await expect(checkWitness(cleared.input)).resolves.toBeUndefined();

    // Forcing it to trade anyway fails.
    const forced = JSON.parse(JSON.stringify(cleared.input)) as Input;
    at(forced, "fill")[14] = "100";
    at(forced, "fillEnc")[14] = "100";
    await expect(checkWitness(forced)).rejects.toThrow();
  });

  it("an empty slot cannot be filled with an invented order", async () => {
    const partial = solveZkBatch(EPOCH, slots.slice(0, 15), orders.slice(0, 15));
    const input = JSON.parse(JSON.stringify(partial.input)) as Input;
    at(input, "included")[15] = "1";
    at(input, "isBuy")[15] = "1";
    at(input, "limit")[15] = "10000";
    at(input, "amount")[15] = "5";
    await expect(checkWitness(input)).rejects.toThrow();
  });

  it("decodes fills back to the right sides", () => {
    valid.fillEnc.forEach((enc, i) => {
      if (valid.fillsLots[i] === 0n) return;
      expect(decodeFill(enc)).toEqual({ isBuy: orders[i]!.isBuy, lots: valid.fillsLots[i] });
    });
  });
});
