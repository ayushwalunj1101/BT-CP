/**
 * Measure sandwich extraction on SimpleAMM and on Obscura, and write the per-trade results to results/.
 * Usage: npm run harness -- [--venue both|amm|obscura] [--trades 100] [--seed 1] [--slippage 100]
 *                            [--min-size 50] [--max-size 500] [--port 8565]
 *   --slippage           victim slippage allowance, in basis points (100 = 1%)
 *   --min-size/max-size  trade size range, in basis points of the pool (50 = 0.5%)
 * Starts and stops its own chains, so it does not interfere with "npm run demo:up".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RESULTS_DIR, fmtAmount } from "@obscura/shared";
import {
  type MeasurementOptions,
  type Summary,
  type TradeRow,
  runMeasurement,
  toCsv,
} from "./measurement.ts";
import { runObscuraMeasurement } from "./obscuraMeasurement.ts";

const { values } = parseArgs({
  options: {
    venue: { type: "string", default: "both" },
    trades: { type: "string", default: "100" },
    seed: { type: "string", default: "1" },
    slippage: { type: "string", default: "100" },
    "min-size": { type: "string", default: "50" },
    "max-size": { type: "string", default: "500" },
    port: { type: "string", default: "8565" },
  },
});
if (!["both", "amm", "obscura"].includes(values.venue))
  throw new Error(`--venue must be both, amm or obscura`);
const trades = Number(values.trades);
const seed = Number(values.seed);
const slippageBps = BigInt(values.slippage);
const minSizeBps = Number(values["min-size"]);
const maxSizeBps = Number(values["max-size"]);

const progress = (r: TradeRow) => {
  const what =
    r.venue === "amm"
      ? r.side === "buy"
        ? `buy  with ${fmtAmount(r.amountIn)} mUSD`
        : `sell ${fmtAmount(r.amountIn)} TKN`
      : `${r.side === "buy" ? "buy " : "sell"} ${fmtAmount(r.amountIn)} TKN`;
  const venue = r.venue === "amm" ? "SimpleAMM" : "Obscura  ";
  console.log(
    `${venue} [${String(r.trade).padStart(3)}/${trades}] ${what.padEnd(30)} ` +
      `${r.attacked ? "sandwiched" : "left alone"}  extraction ${r.extractionBps.toFixed(2).padStart(6)} bps`,
  );
};

const options = (port: number): MeasurementOptions => ({
  trades,
  seed,
  slippageBps,
  minSizeBps,
  maxSizeBps,
  port,
  onTrade: progress,
});

console.log(
  `Measuring sandwich extraction: ${trades} trades, seed ${seed}, victim slippage ${Number(slippageBps) / 100}%, ` +
    `trade sizes ${minSizeBps / 100}% to ${maxSizeBps / 100}% of the pool\n`,
);

const port = Number(values.port);
const results: { name: string; rows: TradeRow[]; summary: Summary }[] = [];
if (values.venue !== "obscura") results.push({ name: "SimpleAMM", ...(await runMeasurement(options(port))) });
if (values.venue !== "amm")
  results.push({ name: "Obscura", ...(await runObscuraMeasurement(options(port + 1))) });

mkdirSync(RESULTS_DIR, { recursive: true });
const tag = `seed${seed}-n${trades}-slip${slippageBps}-size${minSizeBps}to${maxSizeBps}`;
const files = results.map(({ name, rows }) => {
  const file = join(RESULTS_DIR, `${name === "SimpleAMM" ? "amm" : "obscura"}-${tag}.csv`);
  writeFileSync(file, toCsv(rows));
  return file;
});

const col = (s: string) => s.padStart(14);
console.log(`\nResults (bot active, ${trades} trades)\n`);
console.log(`${"".padEnd(26)}${results.map((r) => col(r.name)).join("")}`);
const line = (label: string, cell: (s: Summary) => string) =>
  console.log(`${label.padEnd(26)}${results.map((r) => col(cell(r.summary))).join("")}`);
line("trades sandwiched", (s) => `${s.attacked} / ${s.trades}`);
line("mean extraction (bps)", (s) => s.meanBps.toFixed(2));
line("median / max (bps)", (s) => `${s.medianBps.toFixed(2)} / ${s.maxBps.toFixed(2)}`);
line("victims lost (mUSD)", (s) => fmtAmount(s.victimLossMusd, 0));
line("bot profit (mUSD)", (s) => fmtAmount(s.botProfitMusd, 0));
console.log(`\nPer-trade data:\n${files.map((f) => `  ${f}`).join("\n")}`);
