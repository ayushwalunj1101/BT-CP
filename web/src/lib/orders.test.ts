/**
 * The website seals orders itself (viem and poseidon-lite in the browser). These tests pin it to the
 * contracts and services: same keccak commitments as the shared vectors, same Poseidon commitments as the
 * circuit's TypeScript helper, and an encrypted order the real solver inbox can read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR, zkCommitment as sharedZkCommitment } from "@obscura/shared";
import { type Opening, OrderInbox } from "@obscura/solver";
import { commitmentHash, randomFieldSalt, randomSalt, sendToSolver, zkCommitment } from "./orders";

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
  const inboxes: OrderInbox[] = [];
  afterAll(async () => {
    for (const inbox of inboxes) await inbox.close();
  });

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

  it("computes the same Poseidon commitment as the circuit helper", () => {
    for (let i = 0; i < 10; i++) {
      const trader = randomSalt().slice(0, 42) as `0x${string}`;
      const order = {
        isBuy: i % 2 === 0,
        limitTicks: 9_000n + BigInt(i),
        amountLots: 1_000n * BigInt(i + 1),
        salt: randomFieldSalt(),
      };
      expect(zkCommitment(trader, BigInt(i), order)).toBe(sharedZkCommitment(trader, BigInt(i), order));
    }
  });

  it("sends an order the real solver inbox can decrypt", async () => {
    let received: Opening | null = null;
    const solverKey = randomSalt();
    const inbox = new OrderInbox(solverKey, (o) => (received = o));
    inboxes.push(inbox);
    const url = await inbox.listen(0);

    const trader = "0x00000000000000000000000000000000000000a1";
    const order = { isBuy: false, limitTicks: 10_050n, amountLots: 12_345n, salt: randomFieldSalt() };
    await sendToSolver(url, 7n, trader, order);

    expect(received).toEqual({ epoch: 7n, trader, order });
  });
});
