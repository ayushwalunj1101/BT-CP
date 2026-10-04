/**
 * The solver's zero-knowledge mode (task 4.8): clear a batch from privately received orders, and prove it.
 * The proving key and witness generator come from `npm run zk:setup` (circuits/keys/).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import {
  REPO_ROOT,
  ZK_SLOTS,
  type ZkOrder,
  type ZkSlot,
  circuitInput,
  encodeFill,
  isFunded,
} from "@obscura/shared";
import { clearBatch } from "./clearing.ts";

export const ZK_WASM = join(REPO_ROOT, "circuits", "keys", "clearing.wasm");
export const ZK_ZKEY = join(REPO_ROOT, "circuits", "keys", "clearing.zkey");
export const ZK_VKEY = join(REPO_ROOT, "circuits", "keys", "clearing_vkey.json");

/** Used when nothing in the batch can trade: any price is a valid clearing of zero volume. */
const IDLE_PRICE_TICKS = 10_000n;

export type ZkClearing = {
  priceTicks: bigint;
  /** One per slot, in lots. */
  fillsLots: bigint[];
  /** One per slot, as the contract and circuit expect them. */
  fillEnc: bigint[];
  included: bigint[];
  volumeLots: bigint;
  input: Record<string, string | string[]>;
};

/**
 * Clear a batch. `openings[i]` is the order the solver received for slot i, already checked against the
 * slot's commitment, or null. Opened orders the locked funds cannot cover are included but do not trade,
 * exactly as the circuit treats them.
 */
export function solveZkBatch(epoch: bigint, slots: ZkSlot[], openings: (ZkOrder | null)[]): ZkClearing {
  const active = slots.map((s, i) => {
    const o = openings[i];
    return o && isFunded(o, s.lockBase, s.lockQuote) ? o : null;
  });
  const book = active.flatMap((o, i) => (o ? [{ slot: i, order: o }] : []));
  const clearing = clearBatch(
    book.map(({ order }) => ({ isBuy: order.isBuy, limitPrice: order.limitTicks, amount: order.amountLots })),
  );

  const priceTicks = clearing?.price ?? IDLE_PRICE_TICKS;
  const fillsLots = Array.from({ length: ZK_SLOTS }, () => 0n);
  book.forEach(({ slot }, k) => (fillsLots[slot] = clearing?.fills[k] ?? 0n));

  const fillEnc = fillsLots.map((f, i) => (openings[i] ? encodeFill(openings[i]!.isBuy, f) : 0n));
  const included = Array.from({ length: ZK_SLOTS }, (_, i) => (openings[i] ? 1n : 0n));
  return {
    priceTicks,
    fillsLots,
    fillEnc,
    included,
    volumeLots: clearing?.volume ?? 0n,
    input: circuitInput(epoch, priceTicks, slots, openings, fillsLots),
  };
}

export type SolidityProof = {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  publicSignals: bigint[];
  /** How long proving took. */
  ms: number;
};

type RawProof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };

/** Generate a Groth16 proof for `input`, formatted for the Solidity verifier. Throws if a rule is broken. */
export async function proveClearing(input: Record<string, string | string[]>): Promise<SolidityProof> {
  const started = performance.now();
  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(input, ZK_WASM, ZK_ZKEY)) as {
    proof: RawProof;
    publicSignals: string[];
  };
  const n = (x: string | undefined) => BigInt(x!);
  return {
    a: [n(proof.pi_a[0]), n(proof.pi_a[1])],
    // The verifier expects each pair of B in reverse order.
    b: [
      [n(proof.pi_b[0]![1]), n(proof.pi_b[0]![0])],
      [n(proof.pi_b[1]![1]), n(proof.pi_b[1]![0])],
    ],
    c: [n(proof.pi_c[0]), n(proof.pi_c[1])],
    publicSignals: publicSignals.map(BigInt),
    ms: Math.round(performance.now() - started),
  };
}

/** Check a proof off-chain with the verification key, as the contract would. */
export async function verifyClearing(proof: SolidityProof): Promise<boolean> {
  const vkey = JSON.parse(readFileSync(ZK_VKEY, "utf8")) as unknown;
  const raw = {
    pi_a: [proof.a[0].toString(), proof.a[1].toString(), "1"],
    pi_b: [
      [proof.b[0][1].toString(), proof.b[0][0].toString()],
      [proof.b[1][1].toString(), proof.b[1][0].toString()],
      ["1", "0"],
    ],
    pi_c: [proof.c[0].toString(), proof.c[1].toString(), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
  return (await snarkjs.groth16.verify(vkey, proof.publicSignals.map(String), raw)) as boolean;
}

/** Throws if `input` breaks any circuit rule, without the cost of a full proof. */
export async function checkWitness(input: Record<string, string | string[]>): Promise<void> {
  await snarkjs.wtns.calculate(input, ZK_WASM, { type: "mem" });
}

/** snarkjs keeps worker threads alive; call this before a script exits. */
export async function shutdownProver(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await curve?.terminate();
}
