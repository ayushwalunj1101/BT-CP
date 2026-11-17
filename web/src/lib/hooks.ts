"use client";

import { useQuery } from "@tanstack/react-query";
import { ObscuraAuctionAbi } from "@obscura/shared/abis";
import type { Abi, Address } from "viem";
import { useChainId, useConnection } from "wagmi";
import { getBlockNumber } from "wagmi/actions";
import { type Clock, type Phase, epochAt, phaseAt, phaseStart } from "./clock";
import { read } from "./tx";
import { LOCAL_RPC_URL, config } from "./wagmi";

/**
 * Whether the local development chain (Anvil, chain id 31337) is answering, checked every 10 seconds.
 * Undefined until the first check finishes.
 */
export function useLocalChainUp(): boolean | undefined {
  return useQuery({
    queryKey: ["local-chain-up"],
    queryFn: async () => {
      try {
        const res = await fetch(LOCAL_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          signal: AbortSignal.timeout(2_000),
        });
        return ((await res.json()) as { result?: string }).result === "0x7a69";
      } catch {
        return false;
      }
    },
    refetchInterval: 10_000,
  }).data;
}

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

/** How much of `token` the connected account has free (deposited, not locked) in `auction`. */
export function useFreeBalance(auction: Address | undefined, token: Address | undefined): bigint | undefined {
  const { address } = useConnection();
  return usePoll(
    ["free", auction, address, token],
    () =>
      read<bigint>({
        address: auction!,
        abi: ObscuraAuctionAbi as Abi,
        functionName: "freeBalance",
        args: [address, token],
      }),
    !!auction && !!address && !!token,
  ).data;
}

/**
 * Poll a read every couple of seconds. With `keepWhileLastChanges`, the previous result stays on screen
 * while only the key's last part changes (for example the batch number), instead of flashing a loading
 * state every batch. A change in any other part (another chain, contract or account) still clears it.
 */
export function usePoll<T>(
  key: unknown[],
  fn: () => Promise<T>,
  enabled = true,
  ms = 2_000,
  keepWhileLastChanges = false,
) {
  return useQuery({
    queryKey: key,
    queryFn: fn,
    enabled,
    refetchInterval: ms,
    placeholderData: keepWhileLastChanges
      ? (previous, previousQuery) =>
          previousQuery && sameScope(previousQuery.queryKey, key) ? previous : undefined
      : undefined,
  });
}

function sameScope(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.slice(0, -1).every((part, i) => part === b[i]);
}
