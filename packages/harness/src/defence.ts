/**
 * Act II of the demo: the same trade as Act I, through Obscura, with the same bot watching.
 * Needs "npm run demo:up" running (it runs the bot, the solver and the simulated traders).
 * Usage: npm run demo:defence -- [--side buy|sell] [--amount 50000] [--slippage 100] [--rpc http://127.0.0.1:8545]
 *   --amount    mUSD to spend when buying (converted to TKN at the market price), TKN when selling
 *   --slippage  how far from the market price the victim's limit is, in basis points (100 = 1%)
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Contract, parseUnits } from "ethers";
import {
  ANVIL_CHAIN_ID,
  MockERC20Abi,
  ObscuraAuctionAbi,
  PRICE_SCALE,
  ROLE,
  type SealedOrder,
  SimpleAMMAbi,
  anvilWallet,
  commitmentHash,
  epochAt,
  fmtAmount,
  httpProvider,
  loadDeployment,
  phaseStart,
  randomSalt,
  read,
  readClock,
  shortHash,
  waitUntilNext,
} from "@obscura/shared";
import { commitSealed, filledFor, revealSealed } from "./traders.ts";

const { values } = parseArgs({
  options: {
    side: { type: "string", default: "buy" },
    amount: { type: "string", default: "50000" },
    slippage: { type: "string", default: "100" },
    rpc: { type: "string", default: "http://127.0.0.1:8545" },
  },
});
if (values.side !== "buy" && values.side !== "sell") throw new Error(`--side must be "buy" or "sell"`);
const isBuy = values.side === "buy";
const slippageBps = BigInt(values.slippage);

const deployment = loadDeployment();
const provider = httpProvider(values.rpc, ANVIL_CHAIN_ID);
const victim = anvilWallet(ROLE.victim, provider);
const botAddress = anvilWallet(ROLE.bot).address;
const amm = new Contract(deployment.amm, SimpleAMMAbi, provider);
const auction = new Contract(deployment.auction, ObscuraAuctionAbi, provider);
const tkn = new Contract(deployment.tkn, MockERC20Abi, provider);
const musd = new Contract(deployment.musd, MockERC20Abi, provider);
const clock = await readClock(auction);

const [tknReserve, musdReserve] = await Promise.all([
  read<bigint>(amm, "reserve0"),
  read<bigint>(amm, "reserve1"),
]);
const marketPrice = (musdReserve * PRICE_SCALE) / tknReserve;
const amount = isBuy
  ? (parseUnits(values.amount, 18) * PRICE_SCALE) / marketPrice
  : parseUnits(values.amount, 18);
const order: SealedOrder = {
  isBuy,
  amount,
  limitPrice: isBuy
    ? (marketPrice * (10_000n + slippageBps)) / 10_000n
    : (marketPrice * (10_000n - slippageBps)) / 10_000n,
  salt: randomSalt(),
};

const botValue = async () => {
  const [t, m] = await Promise.all([
    read<bigint>(tkn, "balanceOf", botAddress),
    read<bigint>(musd, "balanceOf", botAddress),
  ]);
  return m + (t * marketPrice) / PRICE_SCALE;
};
const botBefore = await botValue();

// Wait for the start of the next batch, so the whole life of the order is on screen.
const epoch = epochAt(clock, BigInt(await provider.getBlockNumber()) + 1n) + 1n;
console.log(`\nAct II: the same trade, through Obscura\n`);
console.log(`[victim] waiting for batch ${epoch} to open…`);
await waitUntilNext(provider, phaseStart(clock, epoch, "Commit"));

console.log(
  `[victim] sealing: ${isBuy ? "buy" : "sell"} ${fmtAmount(order.amount)} TKN, ` +
    `${isBuy ? "paying at most" : "receiving at least"} ${fmtAmount(order.limitPrice)} mUSD each ` +
    `(${Number(slippageBps) / 100}% ${isBuy ? "above" : "below"} the market price). The salt stays on this machine.`,
);
const bond = await read<bigint>(auction, "revealBond");
const commitTx = await commitSealed(deployment.auction, victim, epoch, order, bond);
const firstBlock = (await commitTx.wait())!.blockNumber;
console.log(`[victim] committed in ${shortHash(commitTx.hash)}. What everyone sees, the bot included:`);
console.log(`         commit(epoch ${epoch}, ${commitmentHash(victim.address, epoch, order)})\n`);

console.log(`[victim] waiting for the reveal window…`);
await waitUntilNext(provider, phaseStart(clock, epoch, "Reveal"));
const revealTx = await revealSealed(deployment.auction, victim, epoch, order);
await revealTx.wait();
console.log(
  `[victim] revealed in ${shortHash(revealTx.hash)}. The commit window is closed: nobody can add an order now.\n`,
);

console.log(`[victim] waiting for the solver and settlement…`);
while ((await read<bigint>(auction, "epochStatus", epoch)) === 0n) await sleep(500);
const lastBlock = await provider.getBlockNumber();

const result = await read<{ price: bigint; volume: bigint }>(auction, "results", epoch);
const fills = await read<{ trader: string; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint }[]>(
  auction,
  "getFills",
  epoch,
);
console.log(`\nBatch ${epoch} settled at one price: p* = ${fmtAmount(result.price)} mUSD per TKN`);
for (const f of fills) {
  const who = f.trader.toLowerCase() === victim.address.toLowerCase() ? "VICTIM" : "trader";
  const each = (f.quoteAmount * PRICE_SCALE) / f.baseAmount;
  console.log(
    `  ${who.padEnd(6)}  ${f.isBuy ? "bought" : "sold  "} ${fmtAmount(f.baseAmount).padStart(10)} TKN` +
      `  for ${fmtAmount(f.quoteAmount).padStart(12)} mUSD  = ${fmtAmount(each)} each`,
  );
}

let botTxs = 0;
for (let b = firstBlock; b <= lastBlock; b++) {
  const block = await provider.getBlock(b, true);
  botTxs +=
    block?.prefetchedTransactions.filter((t) => t.from.toLowerCase() === botAddress.toLowerCase()).length ??
    0;
}
const mine = await filledFor(auction, epoch, victim.address);
const botProfit = (await botValue()) - botBefore;

console.log(`
Victim ${isBuy ? "bought" : "sold"} ${fmtAmount(mine.base)} of ${fmtAmount(order.amount)} TKN at p*, the same price as everyone in the batch.
Bot transactions from commit to settlement: ${botTxs}. Bot profit: ${fmtAmount(botProfit)} mUSD.`);
provider.destroy();
