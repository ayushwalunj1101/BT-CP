"use client";

import { useQuery } from "@tanstack/react-query";
import { ObscuraAuctionAbi } from "@obscura/shared/abis";
import type { Abi, Address } from "viem";
import { useChainId } from "wagmi";
import { getBlockNumber } from "wagmi/actions";
import { type Clock, type Phase, epochAt, phaseAt, phaseStart } from "./clock";
import { read } from "./tx";
import { config } from "./wagmi";

/** The latest block, refreshed every second. */
export function useBlock() {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["block", chainId],
    queryFn: () => getBlockNumber(config, { chainId }),
    refetchInterval: 1_000,
  }).data;
}

/** An auction's batch clock (it never changes after deployment). Both auctions share the same getters. */
export function useClock(auction: Address | undefined) {
  return useQuery({
    queryKey: ["clock", auction],
    enabled: !!auction,
    staleTime: Infinity,
    queryFn: async (): Promise<Clock> => {
      const get = (functionName: string) =>
        read<bigint>({ address: auction!, abi: ObscuraAuctionAbi as Abi, functionName });
      const [genesis, commit, reveal, solve] = await Promise.all([
        get("genesisBlock"),
        get("commitBlocks"),
        get("revealBlocks"),
        get("solveBlocks"),
      ]);
      return { genesis, commit, reveal, solve };
    },
  }).data;
}

export type BatchNow = {
  clock: Clock;
  /** The block a transaction sent now would land in. */
  next: bigint;
  epoch: bigint;
  phase: Phase;
  /** Blocks until the current window ends. */
  blocksLeft: bigint;
};

/** Where the auction's current batch is, as seen by a transaction sent right now. */
export function useBatchNow(auction: Address | undefined): BatchNow | undefined {
  const block = useBlock();
  const clock = useClock(auction);
  if (block === undefined || !clock) return undefined;
  const next = block + 1n;
  const epoch = epochAt(clock, next);
  const phase = phaseAt(clock, epoch, next);
  const ends =
    phase === "Commit"
      ? phaseStart(clock, epoch, "Reveal")
      : phase === "Reveal"
        ? phaseStart(clock, epoch, "Solve")
        : phaseStart(clock, epoch, "Settleable");
  return { clock, next, epoch, phase, blocksLeft: ends - next };
}

/** Poll a read every couple of seconds. */
export function usePoll<T>(key: unknown[], fn: () => Promise<T>, enabled = true, ms = 2_000) {
  return useQuery({ queryKey: key, queryFn: fn, enabled, refetchInterval: ms });
}
