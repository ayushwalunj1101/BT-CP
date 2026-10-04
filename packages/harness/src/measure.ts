/**
 * Measure sandwich extraction on SimpleAMM and write the per-trade results to results/.
 * Usage: npm run harness -- [--trades 100] [--seed 1] [--slippage 100] [--min-size 50] [--max-size 500] [--port 8565]
 *   --slippage           victim slippage allowance, in basis points (100 = 1%)
 *   --min-size/max-size  trade size range, in basis points of the pool (50 = 0.5%)
 * Starts and stops its own chain, so it does not interfere with "npm run demo:up".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RESULTS_DIR, fmtAmount } from "@obscura/shared";
import { runMeasurement, toCsv } from "./measurement.ts";

const { values } = parseArgs({
  options: {
    trades: { type: "string", default: "100" },
    seed: { type: "string", default: "1" },
    slippage: { type: "string", default: "100" },
    "min-size": { type: "string", default: "50" },
    "max-size": { type: "string", default: "500" },
    port: { type: "string", default: "8565" },
  },
});
const trades = Number(values.trades);
const seed = Number(values.seed);
const slippageBps = BigInt(values.slippage);
const minSizeBps = Number(values["min-size"]);
const maxSizeBps = Number(values["max-size"]);

console.log(
  `Measuring sandwich extraction on SimpleAMM: ${trades} trades, seed ${seed}, ` +
    `victim slippage ${Number(slippageBps) / 100}%, trade sizes ${minSizeBps / 100}% to ${maxSizeBps / 100}% of the pool\n`,
);

const { rows, summary } = await runMeasurement({
  trades,
  seed,
  slippageBps,
  minSizeBps,
  maxSizeBps,
  port: Number(values.port),
  onTrade: (r) => {
    const what =
      r.side === "buy" ? `buy  with ${fmtAmount(r.amountIn)} mUSD` : `sell ${fmtAmount(r.amountIn)} TKN`;
    console.log(
      `[${String(r.trade).padStart(3)}/${trades}] ${what.padEnd(30)} ` +
        `${r.attacked ? "sandwiched" : "left alone"}  extraction ${r.extractionBps.toFixed(2).padStart(6)} bps`,
    );
  },
});

mkdirSync(RESULTS_DIR, { recursive: true });
const csvFile = join(
  RESULTS_DIR,
  `stage1-amm-seed${seed}-n${trades}-slip${slippageBps}-size${minSizeBps}to${maxSizeBps}.csv`,
);
writeFileSync(csvFile, toCsv(rows));

console.log(`
Results (SimpleAMM, bot active)
  trades sandwiched        ${summary.attacked} of ${summary.trades}
  mean extraction          ${summary.meanBps.toFixed(2)} bps   (all trades)
  mean when sandwiched     ${summary.meanAttackedBps.toFixed(2)} bps
  median / p95 / max       ${summary.medianBps.toFixed(2)} / ${summary.p95Bps.toFixed(2)} / ${summary.maxBps.toFixed(2)} bps
  victims lost in total    ${fmtAmount(summary.victimLossMusd)} mUSD
  bot profit in total      ${fmtAmount(summary.botProfitMusd)} mUSD

Per-trade data: ${csvFile}`);
