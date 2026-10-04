import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonRpcProvider, Network, WebSocketProvider } from "ethers";

export const ANVIL_CHAIN_ID = 31337;

/** Path to a Foundry tool: the default foundryup install folder if present, otherwise rely on PATH. */
export function foundryBinary(tool: "anvil" | "forge" | "cast"): string {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  const local = join(homedir(), ".foundry", "bin", exe);
  return existsSync(local) ? local : tool;
}

/**
 * HTTP provider with caching switched off. ethers otherwise reuses identical calls for 250 ms,
 * which returns stale nonces and balances (found in Spike A).
 */
export function httpProvider(url: string, chainId = ANVIL_CHAIN_ID): JsonRpcProvider {
  return new JsonRpcProvider(url, Network.from(chainId), { staticNetwork: true, cacheTimeout: -1 });
}

export function wsProvider(url: string, chainId = ANVIL_CHAIN_ID): WebSocketProvider {
  return new WebSocketProvider(url, chainId);
}

export async function isRpcUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRpcUp(url)) return;
    await sleep(100);
  }
  throw new Error(`No chain answered at ${url} within ${timeoutMs / 1000} s`);
}

/**
 * How the chain produces blocks.
 * - auto: a block per transaction (fast deploys)
 * - interval: a block every N seconds (live demo, like a real chain)
 * - manual: only when we call evm_mine (measurement harness, fully repeatable)
 */
export type Mining = { mode: "auto" } | { mode: "interval"; seconds: number } | { mode: "manual" };

export async function setMining(provider: JsonRpcProvider, mining: Mining): Promise<void> {
  if (mining.mode === "auto") {
    await provider.send("evm_setIntervalMining", [0]);
    await provider.send("evm_setAutomine", [true]);
  } else if (mining.mode === "interval") {
    await provider.send("evm_setAutomine", [false]);
    await provider.send("evm_setIntervalMining", [mining.seconds]);
  } else {
    await provider.send("evm_setAutomine", [false]);
    await provider.send("evm_setIntervalMining", [0]);
  }
}

export type AnvilHandle = {
  port: number;
  httpUrl: string;
  wsUrl: string;
  provider: JsonRpcProvider;
  stop(): Promise<void>;
};

/** Start a fresh Anvil chain on `port`, with automine on so deploy scripts finish quickly. */
export async function startAnvil(port: number): Promise<AnvilHandle> {
  const httpUrl = `http://127.0.0.1:${port}`;
  if (await isRpcUp(httpUrl)) {
    throw new Error(`Port ${port} is already used by another chain. Stop it, or choose another port.`);
  }

  const child = spawn(foundryBinary("anvil"), ["--port", String(port), "--quiet"], { stdio: "ignore" });
  const failed = new Promise<never>((_, reject) =>
    child.once("error", (err) =>
      reject(new Error(`Could not start anvil (${err.message}). Is Foundry installed?`)),
    ),
  );
  failed.catch(() => {}); // only matters while racing below
  await Promise.race([waitForRpc(httpUrl), failed]);

  const provider = httpProvider(httpUrl);
  return {
    port,
    httpUrl,
    wsUrl: `ws://127.0.0.1:${port}`,
    provider,
    async stop() {
      provider.destroy();
      child.kill();
    },
  };
}
