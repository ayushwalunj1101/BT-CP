/**
 * Run the solvers against Sepolia for the live demo: the v1 solver, and the ZK solver with its private inbox.
 * Needs a deployment (npm run deploy:sepolia) and .env with SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY.
 * Usage: npm run sepolia:services
 *
 * The ZK solver signs with a second key derived from the deployer's, so the two solvers never compete for
 * nonces. It is topped up with a little Sepolia ETH from the deployer when it runs low.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Wallet, concat, formatEther, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { Solver, ZkSolver } from "@obscura/solver";
import { REPO_ROOT, deploymentPath, httpProvider, loadDeployment } from "@obscura/shared";
import { DEMO_INBOX_PORT } from "./env.ts";

const SEPOLIA_CHAIN_ID = 11155111;
const ZK_SOLVER_MIN_ETH = parseEther("0.02");
const ZK_SOLVER_TOP_UP = parseEther("0.05");

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
const zkWallet = new Wallet(
  keccak256(concat([deployer.privateKey, toUtf8Bytes("obscura-zk-solver")])),
  provider,
);

const zkBalance = await provider.getBalance(zkWallet.address);
if (zkBalance < ZK_SOLVER_MIN_ETH) {
  console.log(`Topping up the ZK solver ${zkWallet.address} with ${formatEther(ZK_SOLVER_TOP_UP)} ETH…`);
  await (await deployer.sendTransaction({ to: zkWallet.address, value: ZK_SOLVER_TOP_UP })).wait();
}

// Sepolia makes a block every 12 s, so polling every 3 s is plenty and saves RPC quota.
const solver = new Solver({ provider, wallet: deployer, auction: deployment.auction, pollMs: 3_000 });
const zkSolver = new ZkSolver({ provider, wallet: zkWallet, auction: deployment.zkAuction, pollMs: 3_000 });
solver.start();
const inbox = await zkSolver.start(DEMO_INBOX_PORT);

console.log(`
Sepolia services running.
  v1 solver   ${deployer.address}  (${formatEther(await provider.getBalance(deployer.address))} ETH)
  ZK solver   ${zkWallet.address}
  ZK inbox    ${inbox}   (the website on this machine sends private orders here)
Press Ctrl+C to stop.`);

process.on("SIGINT", async () => {
  solver.stop();
  await zkSolver.stop();
  provider.destroy();
  process.exit(0);
});
