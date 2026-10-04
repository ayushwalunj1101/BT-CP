/**
 * Run the solver against an already running chain.
 * Usage: npm run solver -- [--rpc http://127.0.0.1:8545]
 * (npm run demo:up starts a chain, deploys, and runs this solver for you.)
 */
import { parseArgs } from "node:util";
import { ANVIL_CHAIN_ID, ROLE, anvilWallet, httpProvider, loadDeployment } from "@obscura/shared";
import { Solver } from "./solver.ts";

const { values } = parseArgs({ options: { rpc: { type: "string", default: "http://127.0.0.1:8545" } } });

const deployment = loadDeployment();
const provider = httpProvider(values.rpc, ANVIL_CHAIN_ID);
const solver = new Solver({
  provider,
  wallet: anvilWallet(ROLE.solver, provider),
  auction: deployment.auction,
});
solver.start();

process.on("SIGINT", () => {
  solver.stop();
  provider.destroy();
  process.exit(0);
});
