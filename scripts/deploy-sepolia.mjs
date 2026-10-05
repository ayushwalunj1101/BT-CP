// Deploy every contract to Sepolia and verify the source on Etherscan.
//
//   npm run deploy:sepolia               real deployment; needs SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env,
//                                        and ETHERSCAN_API_KEY for verification
//   npm run deploy:sepolia -- --dry-run  rehearsal on a local chain that pretends to be Sepolia (chain id 11155111)
//
// The key is read from .env and passed to Foundry in the environment. It is never printed.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contracts = join(root, "contracts");
const dryRun = process.argv.includes("--dry-run");

const tool = (name) => {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const local = join(homedir(), ".foundry", "bin", exe);
  return existsSync(local) ? local : name;
};

function forgeScript(rpcUrl, env, extra) {
  const args = [
    "script",
    "script/DeploySepolia.s.sol",
    "--rpc-url",
    rpcUrl,
    "--broadcast",
    "--slow",
    ...extra,
  ];
  const result = spawnSync(tool("forge"), args, {
    cwd: contracts,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("the deploy script failed (see the output above)");
}

if (dryRun) {
  // Anvil's development key 0, on a throwaway chain that reports Sepolia's chain id.
  const port = 8611;
  const out = join(root, "deployments", "test-sepolia-dry-run.json");
  // Keep the rehearsal's transaction records out of contracts/broadcast, which holds the real Sepolia deploy.
  const broadcast = join(tmpdir(), "obscura-dry-run-broadcast");
  const anvil = spawn(tool("anvil"), ["--port", String(port), "--chain-id", "11155111", "--quiet"], {
    stdio: "ignore",
  });
  try {
    await sleep(1500);
    forgeScript(
      `http://127.0.0.1:${port}`,
      {
        DEPLOYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        DEPLOYMENTS_FILE: out,
        FOUNDRY_BROADCAST: broadcast,
      },
      [],
    );
    const deployed = JSON.parse(readFileSync(out, "utf8"));
    console.log("\nDry run passed. Every contract deployed and was seeded:", deployed);
  } finally {
    anvil.kill();
    rmSync(out, { force: true });
    rmSync(broadcast, { recursive: true, force: true });
  }
  process.exit(0);
}

const envFile = join(root, ".env");
if (!existsSync(envFile)) {
  console.error("No .env file. Copy .env.example to .env and fill it in (see the README, Stage 5).");
  process.exit(1);
}
process.loadEnvFile(envFile);
const missing = ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}
// MetaMask shows private keys without the 0x prefix; Foundry needs it.
const key = process.env.DEPLOYER_PRIVATE_KEY.trim();
process.env.DEPLOYER_PRIVATE_KEY = key.startsWith("0x") ? key : `0x${key}`;

const verify = process.env.ETHERSCAN_API_KEY
  ? ["--verify", "--etherscan-api-key", process.env.ETHERSCAN_API_KEY]
  : [];
if (!verify.length) console.warn("No ETHERSCAN_API_KEY in .env: deploying without source verification.\n");

forgeScript(process.env.SEPOLIA_RPC_URL, {}, verify);
console.log(
  `\nDeployed. Addresses: deployments/11155111.json. Commit that file so the website and teammates use it.`,
);
