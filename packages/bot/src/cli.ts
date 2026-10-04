/**
 * Run the sandwich bot against an already running chain.
 * Usage: npm run bot -- [--rpc http://127.0.0.1:8545]
 * (npm run demo:up starts a chain, deploys, and runs this bot for you.)
 */
import { parseArgs } from "node:util";
import { ANVIL_CHAIN_ID, ROLE, anvilWallet, httpProvider, loadDeployment } from "@obscura/shared";
import { SandwichBot } from "./bot.ts";

const { values } = parseArgs({ options: { rpc: { type: "string", default: "http://127.0.0.1:8545" } } });
const rpc = values.rpc;

const deployment = loadDeployment();
const provider = httpProvider(rpc, ANVIL_CHAIN_ID);
const bot = new SandwichBot({
  provider,
  wsUrl: rpc.replace(/^http/, "ws"),
  chainId: ANVIL_CHAIN_ID,
  wallet: anvilWallet(ROLE.bot, provider),
  amm: deployment.amm,
  auction: deployment.auction,
  symbols: { [deployment.tkn.toLowerCase()]: "TKN", [deployment.musd.toLowerCase()]: "mUSD" },
});

await bot.start();
process.on("SIGINT", async () => {
  await bot.stop();
  provider.destroy();
  process.exit(0);
});
