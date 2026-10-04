/**
 * Spike A: transaction ordering on Anvil.
 *
 * The Stage 1 sandwich bot only works if two things are true on our local chain:
 *   1. A WebSocket subscriber sees a transaction while it is still pending (not yet in a block).
 *   2. Within a block, a higher priority fee goes first and a lower one goes last,
 *      so the bot can place one transaction before the victim and one after.
 * These tests check both, in the two mining modes we plan to use:
 *   - manual mining (the measurement harness), and
 *   - interval mining (the live demo).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonRpcProvider, Network, WebSocketProvider, Wallet, parseUnits } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 8555;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const ANVIL_CHAIN_ID = 31337;

// Anvil's built-in development keys. They are public and only ever hold test ETH.
const VICTIM_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // account 1
const BOT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // account 2
const SINK = "0x000000000000000000000000000000000000dEaD";

const gwei = (n: number) => parseUnits(String(n), "gwei");

/** Fee settings for one transaction, in gwei: priority fee (tip) and max fee per gas. */
type Fees = { tip: number; max: number };

/** Use anvil from PATH, or from the default foundryup install folder if PATH is not refreshed yet. */
function anvilBinary(): string {
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const local = join(homedir(), ".foundry", "bin", exe);
  return existsSync(local) ? local : "anvil";
}

async function waitForRpc(url: string): Promise<void> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`Anvil did not start on ${url}`);
}

let anvil: ChildProcess;
let provider: JsonRpcProvider;
let victim: Wallet;
let bot: Wallet;

beforeAll(async () => {
  anvil = spawn(anvilBinary(), ["--port", String(PORT), "--no-mining", "--quiet"], { stdio: "ignore" });
  await waitForRpc(HTTP_URL);
  // cacheTimeout -1: ethers otherwise reuses identical calls for 250 ms, which returns stale nonces.
  provider = new JsonRpcProvider(HTTP_URL, Network.from(ANVIL_CHAIN_ID), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  victim = new Wallet(VICTIM_KEY, provider);
  bot = new Wallet(BOT_KEY, provider);
});

afterAll(async () => {
  provider?.destroy();
  anvil?.kill();
});

/** Victim trades first; the bot then sends its front-run and back-run with the given fees. */
async function sendSandwich(fees: { victim: Fees; front: Fees; back: Fees }) {
  const feeFields = (f: Fees) => ({ maxPriorityFeePerGas: gwei(f.tip), maxFeePerGas: gwei(f.max) });

  const victimTx = await victim.sendTransaction({ to: SINK, value: 1n, ...feeFields(fees.victim) });
  const nonce = await provider.getTransactionCount(bot.address, "pending");
  const front = await bot.sendTransaction({ to: SINK, value: 1n, nonce, ...feeFields(fees.front) });
  const back = await bot.sendTransaction({ to: SINK, value: 1n, nonce: nonce + 1, ...feeFields(fees.back) });
  return { victimTx, front, back };
}

// The bot raises both fees to go first and lowers both to go last. This works on Anvil,
// which ranks by max fee, and on real Ethereum, where builders rank by the tip.
const SANDWICH_FEES = {
  victim: { tip: 2, max: 50 },
  front: { tip: 3, max: 60 },
  back: { tip: 1, max: 40 },
};

describe("Spike A: transaction ordering on Anvil", () => {
  it("shows pending transactions to a WebSocket subscriber before they are mined", async () => {
    const ws = new WebSocketProvider(WS_URL, ANVIL_CHAIN_ID);
    try {
      const seen = new Promise<string>((resolve) => ws.on("pending", (hash: string) => resolve(hash)));
      await sleep(200); // let the subscription register

      const tx = await victim.sendTransaction({ to: SINK, value: 1n });
      const hash = await Promise.race([seen, sleep(5_000).then(() => "timeout")]);

      expect(hash).toBe(tx.hash);
      expect(await provider.getTransactionReceipt(tx.hash)).toBeNull(); // still pending
    } finally {
      await ws.destroy();
      await provider.send("evm_mine", []); // clear the pool for the next test
    }
  });

  it("keeps arrival order when only the tip differs (Anvil ranks by max fee)", async () => {
    const { victimTx, front, back } = await sendSandwich({
      victim: { tip: 2, max: 100 },
      front: { tip: 3, max: 100 },
      back: { tip: 1, max: 100 },
    });
    await provider.send("evm_mine", []);

    const block = await provider.getBlock("latest");
    expect(block?.transactions).toEqual([victimTx.hash, front.hash, back.hash]);
  });

  it("orders front-run, victim, back-run by fees (manual mining)", async () => {
    const { victimTx, front, back } = await sendSandwich(SANDWICH_FEES);
    await provider.send("evm_mine", []);

    const block = await provider.getBlock("latest");
    expect(block?.transactions).toEqual([front.hash, victimTx.hash, back.hash]);
  });

  it("orders front-run, victim, back-run by fees (interval mining)", async () => {
    await provider.send("evm_setIntervalMining", [2]);
    try {
      // Start right after a fresh block so all three land in the next one.
      const start = await provider.getBlockNumber();
      while ((await provider.getBlockNumber()) === start) await sleep(50);

      const { victimTx, front, back } = await sendSandwich(SANDWICH_FEES);
      const receipt = await back.wait();

      const block = await provider.getBlock(receipt!.blockNumber);
      expect(block?.transactions).toEqual([front.hash, victimTx.hash, back.hash]);
    } finally {
      await provider.send("evm_setIntervalMining", [0]);
    }
  });
});
