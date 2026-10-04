/**
 * Stage 4 end to end: a 16-order batch on a live chain that settles from a zero-knowledge proof, with no
 * reveal transaction at all. Orders travel to the solver privately; on-chain there are only Poseidon
 * commitments, one proof, and the settlement.
 */
import { join } from "node:path";
import { Contract, Interface, Wallet, parseEther, parseUnits, toQuantity } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEPLOYMENTS_DIR,
  MockERC20Abi,
  ObscuraAuctionZKAbi,
  ROLE,
  type ZkOrder,
  anvilWallet,
  epochAt,
  mineUntilNext,
  phaseAt,
  phaseStart,
  read,
  readClock,
} from "@obscura/shared";
import { fetchSolverPublicKey, sendOrderToSolver, shutdownProver } from "@obscura/solver";
import { type LocalEnv, startLocalEnv } from "../src/env.ts";
import { ZK_TRADER_ACCOUNTS, commitZk } from "../src/zkTraders.ts";

const PORT = 8601;
let env: LocalEnv;
const mine = () => env.provider.send("evm_mine", []);

beforeAll(async () => {
  env = await startLocalEnv({
    port: PORT,
    mining: { mode: "manual" },
    deploymentFile: join(DEPLOYMENTS_DIR, `test-${PORT}.json`),
    removeDeploymentOnStop: true,
    botLog: () => {},
  });
}, 120_000);

afterAll(async () => {
  await env?.stop();
  await shutdownProver();
});

/** Nine extra traders: ETH, tokens, approval and a deposit into the ZK auction. */
async function freshTraders(count: number): Promise<Wallet[]> {
  const wallets = Array.from({ length: count }, () => Wallet.createRandom(env.provider) as unknown as Wallet);
  for (const w of wallets)
    await env.provider.send("anvil_setBalance", [w.address, toQuantity(parseEther("10"))]);
  const as = (w: Wallet, address: string) => new Contract(address, MockERC20Abi, w);
  const zk = (w: Wallet) => new Contract(env.deployment.zkAuction, ObscuraAuctionZKAbi, w);
  const step = async (send: (w: Wallet) => Promise<unknown>) => {
    for (const w of wallets) await send(w);
    await mine();
  };
  await step((w) => as(w, env.deployment.tkn).getFunction("mint")(w.address, parseUnits("1000", 18)));
  await step((w) => as(w, env.deployment.musd).getFunction("mint")(w.address, parseUnits("200000", 18)));
  await step((w) =>
    as(w, env.deployment.tkn).getFunction("approve")(env.deployment.zkAuction, parseUnits("1000", 18)),
  );
  await step((w) =>
    as(w, env.deployment.musd).getFunction("approve")(env.deployment.zkAuction, parseUnits("200000", 18)),
  );
  await step((w) => zk(w).getFunction("deposit")(env.deployment.tkn, parseUnits("1000", 18)));
  await step((w) => zk(w).getFunction("deposit")(env.deployment.musd, parseUnits("200000", 18)));
  return wallets;
}

describe("Stage 4: a batch settled from a zero-knowledge proof", () => {
  it("settles 16 sealed orders with one proof and no reveal transaction", async () => {
    const victim = anvilWallet(ROLE.victim, env.provider);
    const traders = [
      victim,
      ...ZK_TRADER_ACCOUNTS.map((i) => anvilWallet(i, env.provider)),
      ...(await freshTraders(9)),
    ];
    expect(traders).toHaveLength(16);

    // The victim buys 300 TKN at up to 101.00; the others alternate sides around 100.00 (ticks of 0.01 mUSD).
    const orders: ZkOrder[] = traders.map((_, k) => ({
      isBuy: k === 0 || k % 2 === 1,
      limitTicks: k === 0 ? 10_100n : k % 2 === 1 ? 9_960n + BigInt(k) * 10n : 9_900n + BigInt(k) * 8n,
      amountLots: k === 0 ? 300_000n : (100n + BigInt(k) * 20n) * 1_000n,
      salt: BigInt(k + 1) * 0x1234_5678_9abc_def0n,
    }));
    const neverSent = 15; // this trader commits but never sends the order: it stays sealed and is left out

    const zk = env.zkAuction;
    const clock = await readClock(zk);
    const bond = await read<bigint>(zk, "revealBond");
    const next = BigInt(await env.provider.getBlockNumber()) + 1n;
    let epoch = epochAt(clock, next);
    if (phaseAt(clock, epoch, next) !== "Commit" || next !== phaseStart(clock, epoch, "Commit")) epoch += 1n;
    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Commit"));
    const firstBlock = BigInt(await env.provider.getBlockNumber()) + 1n;
    const treasuryBefore = await read<bigint>(zk, "treasuryEth");

    // 1. Commit: only Poseidon hashes go on-chain.
    const victimCommit = await commitZk(env.deployment.zkAuction, victim, epoch, orders[0]!, bond);
    for (let k = 1; k < 16; k++)
      await commitZk(env.deployment.zkAuction, traders[k]!, epoch, orders[k]!, bond);
    const decision = await env.bot.waitForDecision(victimCommit.hash);
    expect(decision).toMatchObject({ action: "skip", reason: "sealed order, zero knowledge" });
    await mine();

    // 2. Each trader sends the order itself to the solver, encrypted. Never on-chain.
    const publicKey = await fetchSolverPublicKey(env.zkInboxUrl);
    expect(publicKey).toBe(env.zkSolver.inbox.publicKey);
    for (let k = 0; k < 16; k++) {
      if (k === neverSent) continue;
      await sendOrderToSolver(env.zkInboxUrl, publicKey, {
        epoch,
        trader: traders[k]!.address,
        order: orders[k]!,
      });
    }

    // 3. Prove and submit in the solve window.
    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Solve"));
    const submission = await env.zkSolver.solve(epoch);
    expect(submission).not.toBeNull();
    expect(submission!.included).toBe(15);
    await mine();
    const proofReceipt = await env.provider.getTransactionReceipt(submission!.hash);
    expect(proofReceipt!.status).toBe(1);

    // 4. Settle.
    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Settleable"));
    const settleHash = await env.zkSolver.settle(epoch);
    await mine();
    const settleReceipt = await env.provider.getTransactionReceipt(settleHash);
    expect(settleReceipt!.status).toBe(1);
    console.log(
      `ZK batch of 16: proved in ${submission!.provingMs} ms; submitProof ${proofReceipt!.gasUsed} gas; ` +
        `settle ${settleReceipt!.gasUsed} gas`,
    );

    // Every transaction to the ZK auction in this batch was a commit, the proof, or the settlement.
    const zkInterface = new Interface(ObscuraAuctionZKAbi);
    const latest = BigInt(await env.provider.getBlockNumber());
    const calls: string[] = [];
    for (let b = firstBlock; b <= latest; b++) {
      const block = await env.provider.getBlock(Number(b), true);
      for (const tx of block!.prefetchedTransactions) {
        if (tx.to?.toLowerCase() === env.deployment.zkAuction.toLowerCase()) {
          calls.push(zkInterface.parseTransaction(tx)!.name);
        }
      }
    }
    expect(calls.filter((c) => c === "commit")).toHaveLength(16);
    expect(new Set(calls)).toEqual(new Set(["commit", "submitProof", "settle"]));

    // The batch settled at one price, bought equals sold, the rules hold.
    type FillView = { trader: string; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint };
    const fills = await read<FillView[]>(zk, "getFills", epoch);
    const bought = fills.filter((f) => f.isBuy).reduce((s, f) => s + f.baseAmount, 0n);
    const sold = fills.filter((f) => !f.isBuy).reduce((s, f) => s + f.baseAmount, 0n);
    expect(bought).toBeGreaterThan(0n);
    expect(bought).toBe(sold);
    expect(fills.some((f) => f.trader.toLowerCase() === victim.address.toLowerCase())).toBe(true);
    for (const id of ["checkI1"] as const) expect(await read<boolean>(zk, id)).toBe(true);
    expect(await read<boolean>(zk, "checkI2", epoch)).toBe(true);
    expect(await read<boolean>(zk, "checkI4", epoch)).toBe(true);

    // The trader who never sent their order forfeited the bond; their funds are free again.
    expect((await read<bigint>(zk, "treasuryEth")) - treasuryBefore).toBe(bond);
    expect(await read<bigint>(zk, "lockedBalance", traders[neverSent]!.address, env.deployment.musd)).toBe(
      0n,
    );
  }, 180_000);

  it("refuses an order it cannot decrypt", async () => {
    const res = await fetch(`${env.zkInboxUrl}/orders`, { method: "POST", body: "deadbeef" });
    expect(res.status).toBe(400);
  });
});
