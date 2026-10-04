"use client";

import type { Address } from "viem";
import { useChainId } from "wagmi";
import { epochStart, length } from "@/lib/clock";
import { useBatchNow } from "@/lib/hooks";
import { blockSeconds } from "@/lib/wagmi";

const WHAT: Record<string, { v1: string; zk: string }> = {
  Commit: { v1: "Commit window: seal orders now", zk: "Commit window: seal orders now" },
  Reveal: {
    v1: "Reveal window: open your sealed orders",
    zk: "Hand-off window: orders travel to the solver privately",
  },
  Solve: {
    v1: "Solve window: solvers compute the price",
    zk: "Solve window: the solver proves the clearing",
  },
  Settleable: { v1: "Settling", zk: "Settling" },
  NotStarted: { v1: "Not started", zk: "Not started" },
};

/** Where the current batch is: which window, and how long until it closes. */
export function EpochBar({ auction, zk = false }: { auction: Address | undefined; zk?: boolean }) {
  const now = useBatchNow(auction);
  const chainId = useChainId();
  if (!now) return <div className="card muted">Reading the batch clock…</div>;

  const { clock, epoch, phase, next, blocksLeft } = now;
  const total = Number(length(clock));
  const offset = Number(next - epochStart(clock, epoch));
  const pct = (n: bigint) => `${(Number(n) / total) * 100}%`;
  const seconds = Number(blocksLeft) * blockSeconds(chainId);

  return (
    <div className="card" aria-live="polite">
      <div className="clock-head">
        <h2>Batch {epoch.toString()}</h2>
        <span className="mono small">
          {WHAT[phase]![zk ? "zk" : "v1"]} · closes in {blocksLeft.toString()} block
          {blocksLeft === 1n ? "" : "s"} (~
          {seconds} s)
        </span>
      </div>
      <div className="clock-bar" role="img" aria-label={`Batch ${epoch}, ${phase} window`}>
        <div className={`commit ${phase === "Commit" ? "on" : ""}`} style={{ width: pct(clock.commit) }} />
        <div className={`reveal ${phase === "Reveal" ? "on" : ""}`} style={{ width: pct(clock.reveal) }} />
        <div className={`solve ${phase === "Solve" ? "on" : ""}`} style={{ width: pct(clock.solve) }} />
        <div className="marker" style={{ left: `calc(${(offset / total) * 100}% - 1px)` }} />
      </div>
      <div className="clock-legend">
        <span>commit {clock.commit.toString()} blocks</span>
        <span>
          {zk ? "hand-off" : "reveal"} {clock.reveal.toString()}
        </span>
        <span>solve {clock.solve.toString()}</span>
        <span>then settle</span>
      </div>
    </div>
  );
}
