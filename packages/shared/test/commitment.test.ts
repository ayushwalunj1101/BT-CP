import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIR, commitmentHash } from "../src/index.ts";

type VectorFile = {
  traders: string[];
  epochs: string[];
  isBuys: boolean[];
  limitPrices: string[];
  amounts: string[];
  salts: string[];
  hashes: string[];
};

describe("commitment hash parity", () => {
  // The same file is checked against the contract in contracts/test/unit/CommitmentVectors.t.sol.
  const file = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, "test", "vectors", "commitments.json"), "utf8"),
  ) as VectorFile;

  it("TypeScript reproduces every vector the contract checks", () => {
    expect(file.hashes.length).toBeGreaterThan(0);
    file.hashes.forEach((expected, i) => {
      const hash = commitmentHash(file.traders[i]!, BigInt(file.epochs[i]!), {
        isBuy: file.isBuys[i]!,
        limitPrice: BigInt(file.limitPrices[i]!),
        amount: BigInt(file.amounts[i]!),
        salt: file.salts[i]!,
      });
      expect(hash, `vector ${i}`).toBe(expected);
    });
  });

  it("changes completely when any part of the order changes", () => {
    const base = {
      isBuy: true,
      limitPrice: 100n * 10n ** 18n,
      amount: 10n ** 18n,
      salt: "0x" + "11".repeat(32),
    };
    const trader = "0x0000000000000000000000000000000000000001";
    const original = commitmentHash(trader, 0n, base);
    expect(commitmentHash(trader, 1n, base)).not.toBe(original); // another batch
    expect(commitmentHash("0x0000000000000000000000000000000000000002", 0n, base)).not.toBe(original); // another trader
    expect(commitmentHash(trader, 0n, { ...base, limitPrice: base.limitPrice + 1n })).not.toBe(original);
    expect(commitmentHash(trader, 0n, { ...base, salt: "0x" + "12".repeat(32) })).not.toBe(original);
  });
});
