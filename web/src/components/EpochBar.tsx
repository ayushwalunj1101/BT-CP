"use client";

import type { Address } from "viem";
import { useChainId } from "wagmi";
import { epochStart, length } from "@/lib/clock";
import { useBatchNow } from "@/lib/hooks";
import { blockSeconds } from "@/lib/wagmi";

const WHAT: Record<string, string> = {
  Commit: "Commit window: seal orders now",
  Reveal: "Reveal window: open your sealed orders",
  Solve: "Solve window: solvers compute the price",
  Settleable: "Settling",
  NotStarted: "Not started",
};

/** Where the current batch is: which window, and how long until it closes. */
export function EpochBar({ auction }: { auction: Address | undefined }) {
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
          {WHAT[phase]} · closes in {blocksLeft.toString()} block
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
        <span>reveal {clock.reveal.toString()}</span>
        <span>solve {clock.solve.toString()}</span>
        <span>then settle</span>
      </div>
    </div>
  );
}
