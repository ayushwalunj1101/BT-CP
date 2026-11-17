/**
 * The Sepolia demo's market maker, on a local chain: it stays quiet while nobody trades, and when a lone
 * trader commits it quotes in that same batch, so the trader is filled at its price.
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
  anvilWallet,
  epochAt,
  mineUntilNext,
  phaseStart,
  read,
  readClock,
} from "@obscura/shared";
import { type LocalEnv, startLocalEnv } from "../src/env.ts";
import { MarketMaker } from "../src/marketMaker.ts";
import { commitSealed, filledFor, revealSealed } from "../src/traders.ts";

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
});
