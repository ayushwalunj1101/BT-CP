/**
 * The batch clock, computed off-chain from the auction's parameters, plus helpers to move a local chain
 * to a given block. A transaction sent now lands in the NEXT block, so callers ask about `latest + 1`.
 */
import { type Contract, type JsonRpcProvider, toQuantity } from "ethers";
import { setTimeout as sleep } from "node:timers/promises";
import { read } from "./contracts.ts";

export type EpochClock = {
  genesisBlock: bigint;
  commitBlocks: bigint;
  revealBlocks: bigint;
  solveBlocks: bigint;
};

/** Same order as ObscuraBase.Phase. */
export const PHASES = ["NotStarted", "Commit", "Reveal", "Solve", "Settleable", "Settled", "Voided"] as const;
export type PhaseName = (typeof PHASES)[number];

export async function readClock(auction: Contract): Promise<EpochClock> {
  const [genesisBlock, commitBlocks, revealBlocks, solveBlocks] = await Promise.all([
    read<bigint>(auction, "genesisBlock"),
    read<bigint>(auction, "commitBlocks"),
    read<bigint>(auction, "revealBlocks"),
    read<bigint>(auction, "solveBlocks"),
  ]);
  return { genesisBlock, commitBlocks, revealBlocks, solveBlocks };
}

export function epochLength(clock: EpochClock): bigint {
  return clock.commitBlocks + clock.revealBlocks + clock.solveBlocks;
}

export function epochAt(clock: EpochClock, blockNumber: bigint): bigint {
  return (blockNumber - clock.genesisBlock) / epochLength(clock);
}

export function epochStart(clock: EpochClock, epoch: bigint): bigint {
  return clock.genesisBlock + epoch * epochLength(clock);
}

/** First block of `phase` in `epoch` (Settleable = the first block after the solve window). */
export function phaseStart(
  clock: EpochClock,
  epoch: bigint,
  phase: "Commit" | "Reveal" | "Solve" | "Settleable",
): bigint {
  const start = epochStart(clock, epoch);
  if (phase === "Commit") return start;
  if (phase === "Reveal") return start + clock.commitBlocks;
  if (phase === "Solve") return start + clock.commitBlocks + clock.revealBlocks;
  return start + epochLength(clock);
}

/** Phase of `epoch` at `blockNumber` from the clock alone; Settled and Voided need the contract's status. */
export function phaseAt(clock: EpochClock, epoch: bigint, blockNumber: bigint): PhaseName {
  if (blockNumber < phaseStart(clock, epoch, "Commit")) return "NotStarted";
  if (blockNumber < phaseStart(clock, epoch, "Reveal")) return "Commit";
  if (blockNumber < phaseStart(clock, epoch, "Solve")) return "Reveal";
  if (blockNumber < phaseStart(clock, epoch, "Settleable")) return "Solve";
  return "Settleable";
}

/** Manual mining: mine empty blocks until the next block to be mined is `nextBlock`. */
export async function mineUntilNext(provider: JsonRpcProvider, nextBlock: bigint): Promise<void> {
  const latest = BigInt(await provider.getBlockNumber());
  const count = nextBlock - (latest + 1n);
  if (count > 0n) await provider.send("anvil_mine", [toQuantity(count)]);
}

/** Interval mining: wait until the next block to be mined is at least `nextBlock`. */
export async function waitUntilNext(
  provider: JsonRpcProvider,
  nextBlock: bigint,
  pollMs = 200,
): Promise<void> {
  while (BigInt(await provider.getBlockNumber()) + 1n < nextBlock) await sleep(pollMs);
}

/**
 * Fixed gas limits for auction calls. Setting them skips gas estimation, which would otherwise simulate
 * against the current block instead of the block the transaction lands in, and could see the wrong phase.
 */
export const AUCTION_GAS = {
  commit: 150_000n,
  reveal: 300_000n,
  submit: (orders: number) => 150_000n + 40_000n * BigInt(orders),
  settle: (orders: number) => 600_000n + 150_000n * BigInt(orders),
};
