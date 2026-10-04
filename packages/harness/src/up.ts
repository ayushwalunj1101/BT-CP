/**
 * Start everything the demo needs, in one terminal: a local chain with a block every few seconds, both
 * venues deployed, the sandwich bot printing what it sees, the solver, and six simulated traders who put
 * sealed orders into every Obscura batch.
 * Usage: npm run demo:up -- [--port 8545] [--block-time 2] [--quiet-traders]
 * Then, in a second terminal: npm run demo:attack (Act I) or npm run demo:defence (Act II).
 */
import { parseArgs } from "node:util";
import { deploymentPath, fmtAmount, read } from "@obscura/shared";
import { DEMO_INBOX_PORT, startLocalEnv } from "./env.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8545" },
    "block-time": { type: "string", default: "2" },
  },
});
const port = Number(values.port);
const blockTime = Number(values["block-time"]);

console.log("Starting a local chain, deploying both venues, and starting the bot, solver and traders…\n");
const env = await startLocalEnv({
  port,
  mining: { mode: "interval", seconds: blockTime },
  deploymentFile: deploymentPath(),
  live: true,
  zkInboxPort: DEMO_INBOX_PORT,
  botLog: (line) => console.log(`[bot]     ${line}`),
  solverLog: (line) => console.log(`[solver]  ${line}`),
  zkSolverLog: (line) => console.log(`[zk]      ${line}`),
  tradersLog: (line) => console.log(`[traders] ${line}`),
  seed: Date.now() % 1_000_000,
});

const [tknReserve, musdReserve, commitBlocks, revealBlocks, solveBlocks, vault] = await Promise.all([
  read<bigint>(env.amm, "reserve0"),
  read<bigint>(env.amm, "reserve1"),
  read<bigint>(env.auction, "commitBlocks"),
  read<bigint>(env.auction, "revealBlocks"),
  read<bigint>(env.auction, "solveBlocks"),
  read<bigint>(env.bounty, "vaultBalance"),
]);
const batchSeconds = Number(commitBlocks + revealBlocks + solveBlocks) * blockTime;
const rpcFlag = port === 8545 ? "" : ` -- --rpc ${env.anvil.httpUrl}`;
console.log(`
Chain          ${env.anvil.httpUrl}   (a new block every ${blockTime} s)
TKN            ${env.deployment.tkn}
mUSD           ${env.deployment.musd}
SimpleAMM      ${env.deployment.amm}
ObscuraAuction ${env.deployment.auction}
Obscura ZK     ${env.deployment.zkAuction}   private order inbox ${env.zkInboxUrl}
Bounty vault   ${env.deployment.bounty}   holds ${fmtAmount(vault)} mUSD for anyone who breaks I1 to I4
Pool           ${fmtAmount(tknReserve)} TKN / ${fmtAmount(musdReserve)} mUSD  (${fmtAmount((musdReserve * 10n ** 18n) / tknReserve)} mUSD per TKN)
Batches        commit ${commitBlocks} blocks, reveal ${revealBlocks}, solve ${solveBlocks}: about ${batchSeconds} s each

Ready. In a second terminal run:
  Act I    npm run demo:attack${rpcFlag}     an ordinary trade on SimpleAMM
  Act II   npm run demo:defence${rpcFlag}    the same trade through Obscura
           npm run demo:zk${rpcFlag}         the same trade, sealed and never revealed (zero knowledge)
  Act III  npm run demo:bounty     planted bugs make the vault pay out; the real contract never does
Press Ctrl+C here to stop everything.
`);

let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping…");
  await env.stop();
  process.exit(0);
});
// If the chain dies on its own, stop too, rather than leave the bot, solvers and traders running with nothing.
void env.anvil.exited.then(() => {
  if (stopping) return;
  console.log("\nThe local chain stopped. Exiting.");
  process.exit(1);
});
