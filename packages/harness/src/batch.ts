/**
 * One complete Obscura batch on a manually mined chain: commit → reveal → solve → settle,
 * with the simulated traders and one victim order. Used by the measurement harness and the tests.
 */
import type { BotDecision } from "@obscura/bot";
import {
  ROLE,
  type SealedOrder,
  anvilWallet,
  epochAt,
  mineUntilNext,
  phaseAt,
  phaseStart,
  read,
  readClock,
} from "@obscura/shared";
import type { LocalEnv } from "./env.ts";
import { commitSealed, filledFor, revealSealed } from "./traders.ts";

export type BatchPlan = { traders: SealedOrder[]; victim: SealedOrder };

export type BatchOutcome = {
  epoch: bigint;
  victimCommitHash: string;
  /** What the victim bought or sold, and the mUSD paid or received. */
  victimFill: { base: bigint; quote: bigint };
  price: bigint;
  /** The bot's decision about the victim's commit, when it was active. */
  decision?: BotDecision;
};

export async function runManualBatch(
  env: LocalEnv,
  plan: BatchPlan,
  botActive: boolean,
): Promise<BatchOutcome> {
  const { provider, auction, deployment, bot } = env;
  const clock = await readClock(auction);
  const victim = anvilWallet(ROLE.victim, provider);
  const bond = await read<bigint>(auction, "revealBond");
  const mine = () => provider.send("evm_mine", []);

  // Start at the first block of a commit window, so every commit lands in it.
  const next = BigInt(await provider.getBlockNumber()) + 1n;
  let epoch = epochAt(clock, next);
  if (phaseAt(clock, epoch, next) !== "Commit" || next !== phaseStart(clock, epoch, "Commit")) epoch += 1n;
  await mineUntilNext(provider, phaseStart(clock, epoch, "Commit"));

  await env.traders.commitAll(epoch, plan.traders);
  const victimCommit = await commitSealed(deployment.auction, victim, epoch, plan.victim, bond);
  let decision: BotDecision | undefined;
  if (botActive) decision = await bot.waitForDecision(victimCommit.hash);
  else await bot.waitUntilSeen(victimCommit.hash);
  await mine();

  await mineUntilNext(provider, phaseStart(clock, epoch, "Reveal"));
  await Promise.all([
    env.traders.revealAll(epoch),
    revealSealed(deployment.auction, victim, epoch, plan.victim),
  ]);
  await mine();

  await mineUntilNext(provider, phaseStart(clock, epoch, "Solve"));
  await env.solver.solve(epoch);
  await mine();

  await mineUntilNext(provider, phaseStart(clock, epoch, "Settleable"));
  await env.solver.settle(epoch);
  await mine();

  const result = await read<{ price: bigint }>(auction, "results", epoch);
  return {
    epoch,
    victimCommitHash: victimCommit.hash,
    victimFill: await filledFor(auction, epoch, victim.address),
    price: result.price,
    decision,
  };
}
