/**
 * The Sepolia demo's market maker, on a local chain: it stays quiet while nobody trades, and when a lone
 * trader commits it quotes in that same batch, so the trader is filled at its price, on both auctions.
 */
import { join } from "node:path";
import { Wallet, hexlify, parseEther, parseUnits, randomBytes, toQuantity } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEPLOYMENTS_DIR,
  type EpochClock,
  PRICE_SCALE,
  ROLE,
  type SealedOrder,
  TICK,
  type ZkOrder,
  anvilWallet,
  epochAt,
  mineUntilNext,
  phaseStart,
  read,
  readClock,
} from "@obscura/shared";
import { sendOrderToSolver, shutdownProver } from "@obscura/solver";
import { type LocalEnv, startLocalEnv } from "../src/env.ts";
import { MarketMaker } from "../src/marketMaker.ts";
import { commitSealed, filledFor, revealSealed } from "../src/traders.ts";
import { commitZk } from "../src/zkTraders.ts";

const PORT = 8621;
const TEN = parseUnits("10", 18);
let env: LocalEnv;
let buyer: Wallet;
let seller: Wallet;

const newMarketMaker = () =>
  new MarketMaker({
    provider: env.provider,
    buyer,
    seller,
    deployment: env.deployment,
    inboxUrl: env.zkInboxUrl,
    solverPublicKey: env.zkSolver.inbox.publicKey,
    log: () => {},
  });

/** Mine to the first block of the next commit window; returns that batch. */
async function toCommitStart(clock: EpochClock): Promise<bigint> {
  const next = BigInt(await env.provider.getBlockNumber()) + 1n;
  let epoch = epochAt(clock, next);
  if (next !== phaseStart(clock, epoch, "Commit")) epoch += 1n;
  await mineUntilNext(env.provider, phaseStart(clock, epoch, "Commit"));
  return epoch;
}

/** The market maker's ask: 0.5% above the AMM price. */
async function ask(): Promise<bigint> {
  const [tkn, musd] = await Promise.all([
    read<bigint>(env.amm, "reserve0"),
    read<bigint>(env.amm, "reserve1"),
  ]);
  return (((musd * PRICE_SCALE) / tkn) * 10_050n) / 10_000n;
}

beforeAll(async () => {
  env = await startLocalEnv({
    port: PORT,
    mining: { mode: "auto" },
    deploymentFile: join(DEPLOYMENTS_DIR, `test-${PORT}.json`),
    removeDeploymentOnStop: true,
    botLog: () => {},
  });
  buyer = Wallet.createRandom(env.provider) as unknown as Wallet;
  seller = Wallet.createRandom(env.provider) as unknown as Wallet;
  for (const w of [buyer, seller])
    await env.provider.send("anvil_setBalance", [w.address, toQuantity(parseEther("1"))]);
  await newMarketMaker().prepare();
}, 120_000);

afterAll(async () => {
  await env?.stop();
  await shutdownProver();
});

describe("The market maker", () => {
  it("sends nothing while nobody else trades", async () => {
    const mm = newMarketMaker();
    await toCommitStart(await readClock(env.auction));
    const nonces = async () =>
      Promise.all([buyer, seller].map((w) => env.provider.getTransactionCount(w.address)));
    const before = await nonces();
    await mm.step();
    await mm.step();
    expect(await nonces()).toEqual(before);
  });

  it("fills a lone buyer on the commit-reveal auction, at its ask", async () => {
    const mm = newMarketMaker();
    const clock = await readClock(env.auction);
    const epoch = await toCommitStart(clock);
    const victim = anvilWallet(ROLE.victim, env.provider);
    const order: SealedOrder = {
      isBuy: true,
      limitPrice: parseUnits("101", 18),
      amount: TEN,
      salt: hexlify(randomBytes(32)),
    };
    const bond = await read<bigint>(env.auction, "revealBond");
    await (await commitSealed(env.deployment.auction, victim, epoch, order, bond)).wait();

    await mm.step(); // sees someone else in the batch and quotes both sides in it
    expect(await read<unknown[]>(env.auction, "getCommitments", epoch)).toHaveLength(3);

    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Reveal"));
    await mm.step(); // reveals its quotes
    await (await revealSealed(env.deployment.auction, victim, epoch, order)).wait();
    expect(await read<unknown[]>(env.auction, "getOrders", epoch)).toHaveLength(3);

    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Solve"));
    const solution = await env.solver.solve(epoch);
    expect(solution!.price).toBe(await ask());
    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Settleable"));
    await env.solver.settle(epoch);

    const price = await ask();
    expect(await filledFor(env.auction, epoch, victim.address)).toEqual({
      base: TEN,
      quote: (TEN * price) / PRICE_SCALE,
    });
    expect((await filledFor(env.auction, epoch, seller.address)).base).toBe(TEN);
    expect((await filledFor(env.auction, epoch, buyer.address)).base).toBe(0n); // its buy and sell never cross
  }, 120_000);

  it("fills a lone buyer on the ZK auction, and stays quiet-but-quoting for the next batches", async () => {
    const mm = newMarketMaker();
    const clock = await readClock(env.zkAuction);
    const epoch = await toCommitStart(clock);
    const victim = anvilWallet(ROLE.victim, env.provider);
    const order: ZkOrder = { isBuy: true, limitTicks: 10_100n, amountLots: 10_000n, salt: 0x5eed_1234n };
    const bond = await read<bigint>(env.zkAuction, "revealBond");
    await (await commitZk(env.deployment.zkAuction, victim, epoch, order, bond)).wait();
    await sendOrderToSolver(env.zkInboxUrl, env.zkSolver.inbox.publicKey, {
      epoch,
      trader: victim.address,
      order,
    });

    await mm.step(); // commits both quotes and sends them privately to the solver
    expect(await read<unknown[]>(env.zkAuction, "getSlots", epoch)).toHaveLength(3);

    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Solve"));
    const submission = await env.zkSolver.solve(epoch);
    expect(submission).toMatchObject({ included: 3, volumeLots: 10_000n });
    expect(submission!.priceTicks).toBe((await ask()) / TICK);
    await mineUntilNext(env.provider, phaseStart(clock, epoch, "Settleable"));
    await env.zkSolver.settle(epoch);

    expect(await filledFor(env.zkAuction, epoch, victim.address)).toEqual({
      base: TEN,
      quote: (TEN * submission!.priceTicks * TICK) / PRICE_SCALE,
    });
    expect((await filledFor(env.zkAuction, epoch, seller.address)).base).toBe(TEN);

    // The next batch (settle landed in its first block): it still quotes, alone. Nothing crosses, so no proof
    // is made, and settle frees its funds.
    const later = epoch + 1n;
    await mm.step();
    expect(await read<unknown[]>(env.zkAuction, "getSlots", later)).toHaveLength(2);
    await mineUntilNext(env.provider, phaseStart(clock, later, "Solve"));
    expect(await env.zkSolver.solve(later)).toBeNull();
    await mineUntilNext(env.provider, phaseStart(clock, later, "Settleable"));
    await env.zkSolver.settle(later);
    expect(await read<bigint>(env.zkAuction, "lockedBalance", buyer.address, env.deployment.musd)).toBe(0n);
    expect(await read<bigint>(env.zkAuction, "lockedBalance", seller.address, env.deployment.tkn)).toBe(0n);
  }, 180_000);
});
