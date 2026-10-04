import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAddress, isAddress } from "ethers";
import { ANVIL_CHAIN_ID, foundryBinary } from "./chain.ts";
import { CONTRACTS_DIR, DEPLOYMENTS_DIR } from "./paths.ts";

/** Contract addresses written by the deploy scripts (deployments/<chainId>.json). */
export type Deployment = {
  chainId: number;
  tkn: string;
  musd: string;
  amm: string;
  auction: string;
};

export function deploymentPath(chainId: number = ANVIL_CHAIN_ID): string {
  return join(DEPLOYMENTS_DIR, `${chainId}.json`);
}

export function loadDeployment(file: string = deploymentPath()): Deployment {
  if (!existsSync(file)) {
    throw new Error(`No deployment at ${file}. Start a chain first with "npm run demo:up".`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const address = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || !isAddress(value))
      throw new Error(`${file}: "${key}" is not an address`);
    return getAddress(value);
  };
  return {
    chainId: Number(raw.chainId),
    tkn: address("tkn"),
    musd: address("musd"),
    amm: address("amm"),
    auction: address("auction"),
  };
}

/** Run contracts/script/DeployLocal.s.sol against `rpcUrl` and return the addresses it wrote to `outFile`. */
export async function deployLocal(rpcUrl: string, outFile: string = deploymentPath()): Promise<Deployment> {
  mkdirSync(dirname(outFile), { recursive: true });
  try {
    await promisify(execFile)(
      foundryBinary("forge"),
      ["script", "script/DeployLocal.s.sol", "--rpc-url", rpcUrl, "--broadcast"],
      { cwd: CONTRACTS_DIR, env: { ...process.env, DEPLOYMENTS_FILE: outFile }, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
    const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-15).join("\n");
    throw new Error(`Deploy script failed:\n${tail}`);
  }
  return loadDeployment(outFile);
}
