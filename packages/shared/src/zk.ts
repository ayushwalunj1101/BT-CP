/**
 * Units, commitments and circuit inputs for the zero-knowledge auction (circuits/clearing/clearing.circom).
 *
 * The circuit works in small integers so it never divides:
 *   amounts in lots of 0.001 TKN, prices in ticks of 0.01 mUSD per TKN,
 *   and f lots at p ticks cost exactly f × p × 10^13 wei of mUSD.
 */
import { randomBytes } from "node:crypto";
import { poseidon6 } from "poseidon-lite";

/** Orders per ZK batch: the circuit has a fixed size. */
export const ZK_SLOTS = 16;
/** 1 lot = 0.001 TKN, in wei. */
export const LOT = 10n ** 15n;
/** 1 tick = 0.01 mUSD per TKN, in the contracts' 1e18 price scale. */
export const TICK = 10n ** 16n;
/** mUSD wei for 1 lot at 1 tick. */
export const QUOTE_UNIT = 10n ** 13n;
/** Sell fills are published shifted left by 64 bits; buy fills as is. */
export const SELL_SHIFT = 1n << 64n;
/** The BN254 scalar field: every circuit value lives below it. */
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type ZkOrder = { isBuy: boolean; limitTicks: bigint; amountLots: bigint; salt: bigint };

/** The sealed form of a ZK order: Poseidon(trader, epoch, side, limit, amount, salt), as in the circuit. */
export function zkCommitment(trader: string, epoch: bigint, order: ZkOrder): bigint {
  return poseidon6([
    BigInt(trader),
    epoch,
    order.isBuy ? 1n : 0n,
    order.limitTicks,
    order.amountLots,
    order.salt,
  ]);
}

/** A random salt below the field size (31 bytes). */
export function randomFieldSalt(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

export function encodeFill(isBuy: boolean, lots: bigint): bigint {
  return isBuy ? lots : lots * SELL_SHIFT;
}

export function decodeFill(encoded: bigint): { isBuy: boolean; lots: bigint } {
  return encoded < SELL_SHIFT ? { isBuy: true, lots: encoded } : { isBuy: false, lots: encoded / SELL_SHIFT };
}

/** Does `lock` cover the order in full at its limit? Same rule as the circuit's "funded". */
export function isFunded(order: ZkOrder, lockBase: bigint, lockQuote: bigint): boolean {
  return order.isBuy
    ? order.amountLots * order.limitTicks * QUOTE_UNIT <= lockQuote
    : order.amountLots * LOT <= lockBase;
}

/** What the contract publishes about each slot of a batch. */
export type ZkSlot = { trader: string; commitment: bigint; lockBase: bigint; lockQuote: bigint };

/**
 * The witness input for one batch. `openings[i]` is the order behind slot i if the solver has it (and it
 * is included), or null. Slots beyond those committed are empty.
 */
export function circuitInput(
  epoch: bigint,
  priceTicks: bigint,
  slots: ZkSlot[],
  openings: (ZkOrder | null)[],
  fillsLots: bigint[],
): Record<string, string | string[]> {
  const pad = <T>(xs: T[], empty: T) => Array.from({ length: ZK_SLOTS }, (_, i) => xs[i] ?? empty);
  const s = pad<ZkSlot | null>(slots, null);
  const o = pad<ZkOrder | null>(openings, null);
  const f = pad(fillsLots, 0n);
  const str = (xs: bigint[]) => xs.map((x) => x.toString());
  return {
    epoch: epoch.toString(),
    price: priceTicks.toString(),
    commitment: str(s.map((x) => x?.commitment ?? 0n)),
    trader: str(s.map((x) => (x ? BigInt(x.trader) : 0n))),
    lockBase: str(s.map((x) => x?.lockBase ?? 0n)),
    lockQuote: str(s.map((x) => x?.lockQuote ?? 0n)),
    included: str(o.map((x) => (x ? 1n : 0n))),
    fillEnc: str(o.map((x, i) => (x ? encodeFill(x.isBuy, f[i]!) : 0n))),
    isBuy: str(o.map((x) => (x?.isBuy ? 1n : 0n))),
    limit: str(o.map((x) => x?.limitTicks ?? 0n)),
    amount: str(o.map((x) => x?.amountLots ?? 0n)),
    salt: str(o.map((x) => x?.salt ?? 0n)),
    fill: str(o.map((x, i) => (x ? f[i]! : 0n))),
  };
}
