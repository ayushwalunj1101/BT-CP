/**
 * Run the live Sepolia demo's services: the v1 solver, the ZK solver with its private inbox, and a market
 * maker so one person can trade alone and still be filled.
 * Needs a deployment (npm run deploy:sepolia) and .env with SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY.
 * Usage: npm run sepolia:services            (add -- --no-market-maker to run the solvers only)
 *
 * The ZK solver and the market maker's two accounts sign with keys derived from the deployer's, so nothing
 * competes for the deployer's nonces. Each is topped up with a little Sepolia ETH from the deployer when low.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Wallet, concat, formatEther, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { Solver, ZkSolver } from "@obscura/solver";
import { REPO_ROOT, deploymentPath, httpProvider, loadDeployment } from "@obscura/shared";
import { DEMO_INBOX_PORT } from "./env.ts";
import { MarketMaker } from "./marketMaker.ts";

const SEPOLIA_CHAIN_ID = 11155111;
const withMarketMaker = !process.argv.includes("--no-market-maker");

const envFile = join(REPO_ROOT, ".env");
if (!existsSync(envFile)) throw new Error("No .env file. Copy .env.example to .env and fill it in.");
process.loadEnvFile(envFile);
const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;
if (!SEPOLIA_RPC_URL || !DEPLOYER_PRIVATE_KEY)
  throw new Error("Set SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env");

const deployment = loadDeployment(deploymentPath(SEPOLIA_CHAIN_ID));
const provider = httpProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID);
// MetaMask shows private keys without the 0x prefix; ethers needs it.
const deployerKey = DEPLOYER_PRIVATE_KEY.trim();
const deployer = new Wallet(deployerKey.startsWith("0x") ? deployerKey : `0x${deployerKey}`, provider);
const derived = (label: string) =>
  new Wallet(keccak256(concat([deployer.privateKey, toUtf8Bytes(label)])), provider);

const zkWallet = derived("obscura-zk-solver");
const mmBuyer = derived("obscura-market-maker-buyer");
const mmSeller = derived("obscura-market-maker-seller");

/** Send `amount` from the deployer when `wallet` holds less than `min`. One at a time, before anything runs. */
async function topUp(wallet: Wallet, name: string, min: bigint, amount: bigint): Promise<void> {
  if ((await provider.getBalance(wallet.address)) >= min) return;
  console.log(`Topping up the ${name} ${wallet.address} with ${formatEther(amount)} ETH…`);
  await (await deployer.sendTransaction({ to: wallet.address, value: amount })).wait();
}

await topUp(zkWallet, "ZK solver", parseEther("0.02"), parseEther("0.05"));
if (withMarketMaker) {
  await topUp(mmBuyer, "market maker's buyer", parseEther("0.004"), parseEther("0.01"));
  await topUp(mmSeller, "market maker's seller", parseEther("0.004"), parseEther("0.01"));
}

// Sepolia makes a block every 12 s, so polling every 3 s is plenty and saves RPC quota.
const solver = new Solver({ provider, wallet: deployer, auction: deployment.auction, pollMs: 3_000 });
const zkSolver = new ZkSolver({ provider, wallet: zkWallet, auction: deployment.zkAuction, pollMs: 3_000 });
solver.start();
const inbox = await zkSolver.start(DEMO_INBOX_PORT);

let marketMaker: MarketMaker | undefined;
if (withMarketMaker) {
  marketMaker = new MarketMaker({
    provider,
    buyer: mmBuyer,
    seller: mmSeller,
    deployment,
    inboxUrl: inbox,
    solverPublicKey: zkSolver.inbox.publicKey,
    pollMs: 3_000,
  });
  console.log(
    "Preparing the market maker (the first run mints and deposits its test tokens, about a minute)…",
  );
  await marketMaker.prepare();
  marketMaker.start();
}

console.log(`
Sepolia services running.
  v1 solver      ${deployer.address}  (${formatEther(await provider.getBalance(deployer.address))} ETH)
  ZK solver      ${zkWallet.address}
  ZK inbox       ${inbox}   (the website on this machine sends private orders here)
  market maker   ${withMarketMaker ? `buyer ${mmBuyer.address}, seller ${mmSeller.address}` : "off"}
Press Ctrl+C to stop.`);

process.on("SIGINT", async () => {
  marketMaker?.stop();
  solver.stop();
  await zkSolver.stop();
  provider.destroy();
  process.exit(0);
});
