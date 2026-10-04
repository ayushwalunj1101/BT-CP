/**
 * The measurement harness (feature F9): how much value does the bot take from ordinary trades?
 *
 * For each random trade:
 *   1. snapshot the chain
 *   2. run the trade with the bot paused  → fairOut   (what the victim should get)
 *   3. rewind to the snapshot
 *   4. run the identical trade with the bot active → actualOut
 *   5. extraction = (fairOut − actualOut) / fairOut, in basis points
 * Blocks are mined by hand, so every run with the same seed gives the same numbers.
 */
import { join } from "node:path";
import { formatUnits } from "ethers";
import { DEPLOYMENTS_DIR, ROLE, anvilWallet, read, shortfallBps } from "@obscura/shared";
import { startLocalEnv } from "./env.ts";
import { mulberry32 } from "./random.ts";
import { type Side, sendVictimSwap, swapOutput } from "./victim.ts";

const WAD = 10n ** 18n;

export type MeasurementOptions = {
  trades: number;
  seed: number;
  /** The slippage every victim allows. The bot can never take more than this. */
  slippageBps: bigint;
  /** Trade sizes are drawn between these, as basis points of the pool's reserve of the token being sold. */
  minSizeBps: number;
  maxSizeBps: number;
  port: number;
  onTrade?: (row: TradeRow) => void;
};

export type TradeRow = {
  venue: "amm" | "obscura";
  trade: number;
  side: Side;
  /** AMM: the amount the victim pays in (mUSD when buying, TKN when selling). Obscura: the TKN ordered. */
  amountIn: bigint;
  slippageBps: bigint;
  fairOut: bigint;
  actualOut: bigint;
  extractionBps: number;
  attacked: boolean;
  /** Bot's gain on this trade, both tokens valued in mUSD at the pre-trade pool price. */
  botProfitMusd: bigint;
  /** What the victim lost against the fair result, valued in mUSD. */
  victimLossMusd: bigint;
};

export type Summary = {
  trades: number;
  attacked: number;
  meanBps: number;
  meanAttackedBps: number;
  medianBps: number;
  p95Bps: number;
  maxBps: number;
  botProfitMusd: bigint;
  victimLossMusd: bigint;
};

export async function runMeasurement(
  options: MeasurementOptions,
): Promise<{ rows: TradeRow[]; summary: Summary }> {
  const env = await startLocalEnv({
    port: options.port,
    mining: { mode: "manual" },
    deploymentFile: join(DEPLOYMENTS_DIR, `test-${options.port}.json`),
    removeDeploymentOnStop: true,
    botLog: () => {},
  });
  const { provider, deployment, bot } = env;
  const victim = anvilWallet(ROLE.victim, provider);
  const random = mulberry32(options.seed);
  const rows: TradeRow[] = [];

  const reserves = async () => {
    const [tkn, musd] = await Promise.all([
      read<bigint>(env.amm, "reserve0"),
      read<bigint>(env.amm, "reserve1"),
    ]);
    return { tkn, musd }; // token0 is TKN, token1 is mUSD (see DeployLocal.s.sol)
  };
  const botBalances = async () => {
    const [tkn, musd] = await Promise.all([
      read<bigint>(env.tkn, "balanceOf", bot.address),
      read<bigint>(env.musd, "balanceOf", bot.address),
    ]);
    return { tkn, musd };
  };
  const minedOutput = async (hash: string) => {
    const receipt = await provider.getTransactionReceipt(hash);
    return receipt ? swapOutput(receipt, deployment.amm) : null;
  };

  try {
    for (let trade = 1; trade <= options.trades; trade++) {
      const side: Side = random() < 0.5 ? "buy" : "sell";
      const sizeBps = options.minSizeBps + random() * (options.maxSizeBps - options.minSizeBps);
      const pool = await reserves();
      const reserveIn = side === "buy" ? pool.musd : pool.tkn;
      const amountIn = (reserveIn * BigInt(Math.round(sizeBps * 100))) / 1_000_000n;
      const price = (pool.musd * WAD) / pool.tkn; // mUSD per TKN, 18 decimals
      const victimTrade = { side, amountIn, slippageBps: options.slippageBps };

      // Run 1: bot paused. Wait until its stream has delivered the transaction, so it cannot act on it later.
      const snapshot = (await provider.send("evm_snapshot", [])) as string;
      bot.pause();
      const fairRun = await sendVictimSwap(deployment, victim, victimTrade);
      await bot.waitUntilSeen(fairRun.tx.hash);
      await provider.send("evm_mine", []);
      const fairOut = await minedOutput(fairRun.tx.hash);
      await provider.send("evm_revert", [snapshot]);
      bot.resume();

      // Run 2: the identical trade from the identical state, bot active.
      const before = await botBalances();
      const run = await sendVictimSwap(deployment, victim, victimTrade);
      const decision = await bot.waitForDecision(run.tx.hash);
      await provider.send("evm_mine", []);
      const actualOut = await minedOutput(run.tx.hash);
      const after = await botBalances();

      if (fairOut === null || actualOut === null)
        throw new Error(`trade ${trade}: the victim's swap reverted`);
      const lossInTkn = side === "buy"; // the victim receives TKN when buying
      const row: TradeRow = {
        venue: "amm",
        trade,
        side,
        amountIn,
        slippageBps: options.slippageBps,
        fairOut,
        actualOut,
        extractionBps: shortfallBps(fairOut, actualOut),
        attacked: decision.action === "attack",
        botProfitMusd: after.musd - before.musd + ((after.tkn - before.tkn) * price) / WAD,
        victimLossMusd: lossInTkn ? ((fairOut - actualOut) * price) / WAD : fairOut - actualOut,
      };
      rows.push(row);
      options.onTrade?.(row);
    }
  } finally {
    await env.stop();
  }
  return { rows, summary: summarize(rows) };
}

export function summarize(rows: TradeRow[]): Summary {
  const sorted = rows.map((r) => r.extractionBps).sort((a, b) => a - b);
  const attacked = rows.filter((r) => r.attacked);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    trades: rows.length,
    attacked: attacked.length,
    meanBps: round2(mean(sorted)),
    meanAttackedBps: round2(mean(attacked.map((r) => r.extractionBps))),
    medianBps: percentile(0.5),
    p95Bps: percentile(0.95),
    maxBps: sorted.at(-1) ?? 0,
    botProfitMusd: rows.reduce((s, r) => s + r.botProfitMusd, 0n),
    victimLossMusd: rows.reduce((s, r) => s + r.victimLossMusd, 0n),
  };
}

export function toCsv(rows: TradeRow[]): string {
  const header =
    "venue,trade,side,amount_in,slippage_bps,fair_out,actual_out,extraction_bps,attacked,bot_profit_musd,victim_loss_musd";
  const lines = rows.map((r) =>
    [
      r.venue,
      r.trade,
      r.side,
      formatUnits(r.amountIn, 18),
      r.slippageBps,
      formatUnits(r.fairOut, 18),
      formatUnits(r.actualOut, 18),
      r.extractionBps.toFixed(2),
      r.attacked,
      formatUnits(r.botProfitMusd, 18),
      formatUnits(r.victimLossMusd, 18),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
