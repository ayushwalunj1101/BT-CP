/**
 * The website seals orders itself (viem in the browser). This test pins it to the contract: the same keccak
 * commitments as the shared vectors that the Solidity tests check too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "@obscura/shared";
import { commitmentHash } from "./orders";

type Vectors = {
  traders: `0x${string}`[];
  epochs: string[];
  isBuys: boolean[];
  limitPrices: string[];
  amounts: string[];
  salts: `0x${string}`[];
  hashes: string[];
};

describe("browser order sealing", () => {
  it("matches every commitment-hash vector the contract checks", () => {
    const v = JSON.parse(
      readFileSync(join(CONTRACTS_DIR, "test", "vectors", "commitments.json"), "utf8"),
    ) as Vectors;
    v.hashes.forEach((expected, i) => {
      const hash = commitmentHash(
        v.traders[i]!,
        BigInt(v.epochs[i]!),
        v.isBuys[i]!,
        BigInt(v.limitPrices[i]!),
        BigInt(v.amounts[i]!),
        v.salts[i]!,
      );
      expect(hash.toLowerCase(), `vector ${i}`).toBe(expected.toLowerCase());
    });
  });
});
