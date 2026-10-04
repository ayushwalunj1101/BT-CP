/** The batch clock, computed from the auction's parameters (same rules as ObscuraBase.phaseOf). */
export type Clock = { genesis: bigint; commit: bigint; reveal: bigint; solve: bigint };
export type Phase = "NotStarted" | "Commit" | "Reveal" | "Solve" | "Settleable";

export const length = (c: Clock) => c.commit + c.reveal + c.solve;
export const epochAt = (c: Clock, block: bigint) => (block - c.genesis) / length(c);
export const epochStart = (c: Clock, epoch: bigint) => c.genesis + epoch * length(c);

export function phaseStart(c: Clock, epoch: bigint, phase: Exclude<Phase, "NotStarted">): bigint {
  const start = epochStart(c, epoch);
  if (phase === "Commit") return start;
  if (phase === "Reveal") return start + c.commit;
  if (phase === "Solve") return start + c.commit + c.reveal;
  return start + length(c);
}

export function phaseAt(c: Clock, epoch: bigint, block: bigint): Phase {
  if (block < phaseStart(c, epoch, "Commit")) return "NotStarted";
  if (block < phaseStart(c, epoch, "Reveal")) return "Commit";
  if (block < phaseStart(c, epoch, "Solve")) return "Reveal";
  if (block < phaseStart(c, epoch, "Settleable")) return "Solve";
  return "Settleable";
}

/** Contract Phase enum (ObscuraBase.Phase) by index. */
export const CONTRACT_PHASES = [
  "NotStarted",
  "Commit",
  "Reveal",
  "Solve",
  "Settleable",
  "Settled",
  "Voided",
] as const;
