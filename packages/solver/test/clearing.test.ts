import { describe, expect, it } from "vitest";
import { type BookOrder, clearBatch } from "../src/clearing.ts";

const e18 = 10n ** 18n;
const buy = (limit: bigint, amount: bigint): BookOrder => ({
  isBuy: true,
  limitPrice: limit * e18,
  amount: amount * e18,
});
const sell = (limit: bigint, amount: bigint): BookOrder => ({
  isBuy: false,
  limitPrice: limit * e18,
  amount: amount * e18,
});

describe("clearBatch", () => {
  it("clears the example book: A buys 10 from C, B and D do not trade", () => {
    // Same book as contracts/test/unit/Clearing.t.sol. Prices 100 and 103 both match 10; the middle tie is 100.
    const result = clearBatch([buy(105n, 10n), buy(100n, 10n), sell(95n, 10n), sell(103n, 10n)])!;
    expect(result.volume).toBe(10n * e18);
    expect(result.price).toBe(100n * e18);
    expect(result.fills).toEqual([10n * e18, 0n, 10n * e18, 0n]);
  });

  it("shares the remainder between orders exactly at the price", () => {
    const result = clearBatch([buy(100n, 10n), buy(100n, 10n), sell(90n, 15n)])!;
    expect(result.price).toBe(100n * e18);
    expect(result.fills).toEqual([75n * 10n ** 17n, 75n * 10n ** 17n, 15n * e18]);
  });

  it("shares in proportion to size, and hands out leftover wei so the sides balance exactly", () => {
    const orders: BookOrder[] = [
      { isBuy: true, limitPrice: 100n, amount: 1n },
      { isBuy: true, limitPrice: 100n, amount: 1n },
      { isBuy: true, limitPrice: 100n, amount: 1n },
      { isBuy: false, limitPrice: 50n, amount: 2n },
    ];
    const result = clearBatch(orders)!;
    const bought = result.fills.slice(0, 3).reduce((a, b) => a + b, 0n);
    expect(bought).toBe(2n);
    expect(result.fills[3]).toBe(2n);
    result.fills.forEach((f, i) => expect(f).toBeLessThanOrEqual(orders[i]!.amount));
  });

  it("matches as much as possible when one side is larger", () => {
    const result = clearBatch([buy(110n, 50n), sell(90n, 20n), sell(95n, 20n)])!;
    expect(result.volume).toBe(40n * e18);
    expect(result.fills).toEqual([40n * e18, 20n * e18, 20n * e18]);
  });

  it("trades nothing when no buyer reaches any seller", () => {
    const result = clearBatch([buy(90n, 10n), sell(110n, 10n)])!;
    expect(result.volume).toBe(0n);
    expect(result.fills).toEqual([0n, 0n]);
  });

  it("handles one-sided and empty batches", () => {
    expect(clearBatch([])).toBeNull();
    expect(clearBatch([buy(100n, 5n), buy(101n, 5n)])!.volume).toBe(0n);
  });

  it("gives the same price and fills whatever order the book arrives in", () => {
    const book = [
      buy(105n, 10n),
      buy(100n, 10n),
      sell(95n, 10n),
      sell(103n, 10n),
      buy(102n, 3n),
      sell(99n, 7n),
    ];
    const forward = clearBatch(book)!;
    const backward = clearBatch([...book].reverse())!;
    expect(backward.price).toBe(forward.price);
    expect(backward.volume).toBe(forward.volume);
    expect([...backward.fills].reverse()).toEqual(forward.fills);
  });
});
