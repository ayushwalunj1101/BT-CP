/**
 * Start everything Act I needs, in one terminal: a local chain with a block every few seconds,
 * the deployed contracts, and the sandwich bot printing what it sees.
 * Usage: npm run demo:up -- [--port 8545] [--block-time 4]
 * Then, in a second terminal: npm run demo:attack
 */
import { parseArgs } from "node:util";
import { deploymentPath, fmtAmount, read } from "@obscura/shared";
import { startStage1 } from "./env.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8545" },
    "block-time": { type: "string", default: "4" },
  },
});
const port = Number(values.port);
const blockTime = Number(values["block-time"]);

console.log("Starting a local chain, deploying the contracts, and starting the bot…\n");
const env = await startStage1({
  port,
  mining: { mode: "interval", seconds: blockTime },
  deploymentFile: deploymentPath(),
  botLog: (line) => console.log(`[bot] ${line}`),
});

const [tknReserve, musdReserve] = await Promise.all([
  read<bigint>(env.amm, "reserve0"),
  read<bigint>(env.amm, "reserve1"),
]);
console.log(`
Chain      ${env.anvil.httpUrl}   (a new block every ${blockTime} s)
TKN        ${env.deployment.tkn}
mUSD       ${env.deployment.musd}
SimpleAMM  ${env.deployment.amm}
Pool       ${fmtAmount(tknReserve)} TKN / ${fmtAmount(musdReserve)} mUSD  (${fmtAmount((musdReserve * 10n ** 18n) / tknReserve)} mUSD per TKN)

Ready. In a second terminal run:  npm run demo:attack${port === 8545 ? "" : ` -- --rpc ${env.anvil.httpUrl}`}
Press Ctrl+C here to stop the chain and the bot.
`);

let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping…");
  await env.stop();
  process.exit(0);
});
