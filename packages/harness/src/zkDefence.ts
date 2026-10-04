/**
 * Act II, zero-knowledge edition: the same trade as Act I, sealed with Poseidon, sent to the solver
 * privately, and settled from a proof. The order is never revealed on-chain, not even afterwards.
 * Needs "npm run demo:up" running (it runs the ZK solver, its private inbox, and the ZK traders).
 * Usage: npm run demo:zk -- [--side buy|sell] [--amount 50000] [--slippage 100]
 *                           [--rpc http://127.0.0.1:8545] [--inbox http://127.0.0.1:8650]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Contract, Interface, parseUnits } from "ethers";
import {
  ANVIL_CHAIN_ID,
  MockERC20Abi,
  ObscuraAuctionZKAbi,
  PRICE_SCALE,
  ROLE,
  SimpleAMMAbi,
  TICK,
  type ZkOrder,
  anvilWallet,
  epochAt,
  fmtAmount,
  httpProvider,
  loadDeployment,
  phaseStart,
  randomFieldSalt,
  read,
  readClock,
  shortHash,
  waitUntilNext,
  zkCommitment,
} from "@obscura/shared";
import { fetchSolverPublicKey, sendOrderToSolver } from "@obscura/solver";
import { DEMO_INBOX_PORT } from "./env.ts";
import { commitZk } from "./zkTraders.ts";

const { values } = parseArgs({
  options: {
    side: { type: "string", default: "buy" },
    amount: { type: "string", default: "50000" },
    slippage: { type: "string", default: "100" },
    rpc: { type: "string", default: "http://127.0.0.1:8545" },
    inbox: { type: "string", default: `http://127.0.0.1:${DEMO_INBOX_PORT}` },
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
const zk = new Contract(deployment.zkAuction, ObscuraAuctionZKAbi, provider);
const tkn = new Contract(deployment.tkn, MockERC20Abi, provider);
const musd = new Contract(deployment.musd, MockERC20Abi, provider);
const clock = await readClock(zk);

const [tknReserve, musdReserve] = await Promise.all([
  read<bigint>(amm, "reserve0"),
  read<bigint>(amm, "reserve1"),
]);
const marketPrice = (musdReserve * PRICE_SCALE) / tknReserve;
const marketTicks = marketPrice / TICK;
const tknAmount = isBuy
  ? (parseUnits(values.amount, 18) * PRICE_SCALE) / marketPrice
  : parseUnits(values.amount, 18);
const order: ZkOrder = {
  isBuy,
  amountLots: tknAmount / 10n ** 15n,
  limitTicks: isBuy
    ? (marketTicks * (10_000n + slippageBps)) / 10_000n
    : (marketTicks * (10_000n - slippageBps)) / 10_000n,
  salt: randomFieldSalt(),
};

const botValue = async () => {
  const [t, m] = await Promise.all([
    read<bigint>(tkn, "balanceOf", botAddress),
    read<bigint>(musd, "balanceOf", botAddress),
  ]);
  return m + (t * marketPrice) / PRICE_SCALE;
};
const botBefore = await botValue();
const publicKey = await fetchSolverPublicKey(values.inbox);

console.log(`\nAct II, zero-knowledge edition: the same trade, never revealed\n`);
// A commit locks the whole free balance, so wait for any earlier batch of ours to release it.
while ((await read<bigint>(zk, "lockedBalance", victim.address, deployment.musd)) > 0n) await sleep(500);
const epoch = epochAt(clock, BigInt(await provider.getBlockNumber()) + 1n) + 1n;
console.log(`[victim] waiting for ZK batch ${epoch} to open…`);
await waitUntilNext(provider, phaseStart(clock, epoch, "Commit"));

console.log(
  `[victim] sealing: ${isBuy ? "buy" : "sell"} ${fmtAmount(order.amountLots * 10n ** 15n)} TKN, ` +
    `${isBuy ? "paying at most" : "receiving at least"} ${fmtAmount(order.limitTicks * TICK)} mUSD each.`,
);
const commitTx = await commitZk(
  deployment.zkAuction,
  victim,
  epoch,
  order,
  await read<bigint>(zk, "revealBond"),
);
const firstBlock = (await commitTx.wait())!.blockNumber;
console.log(`[victim] committed in ${shortHash(commitTx.hash)}. What everyone sees, the bot included:`);
console.log(`         commit(epoch ${epoch}, ${zkCommitment(victim.address, epoch, order)})`);
await sendOrderToSolver(values.inbox, publicKey, { epoch, trader: victim.address, order });
console.log(
  `[victim] sent the order itself to the solver, encrypted to its key. Nothing about it goes on-chain.\n`,
);

console.log(`[victim] waiting for the solver's proof and settlement…`);
while ((await read<bigint>(zk, "epochStatus", epoch)) === 0n) await sleep(500);
const lastBlock = await provider.getBlockNumber();

const result = await read<{ price: bigint }>(zk, "results", epoch);
const fills = await read<{ trader: string; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint }[]>(
  zk,
  "getFills",
  epoch,
);
console.log(
  `\nZK batch ${epoch} settled from a proof at one price: p* = ${fmtAmount(result.price)} mUSD per TKN`,
);
for (const f of fills) {
  const who = f.trader.toLowerCase() === victim.address.toLowerCase() ? "VICTIM" : "trader";
  console.log(
    `  ${who.padEnd(6)}  ${f.isBuy ? "bought" : "sold  "} ${fmtAmount(f.baseAmount, 3).padStart(11)} TKN` +
      `  for ${fmtAmount(f.quoteAmount).padStart(12)} mUSD`,
  );
}

const zkInterface = new Interface(ObscuraAuctionZKAbi);
const calls = new Map<string, number>();
let botTxs = 0;
for (let b = firstBlock; b <= lastBlock; b++) {
  const block = await provider.getBlock(b, true);
  for (const tx of block?.prefetchedTransactions ?? []) {
    if (tx.from.toLowerCase() === botAddress.toLowerCase()) botTxs++;
    if (tx.to?.toLowerCase() !== deployment.zkAuction.toLowerCase()) continue;
    const call = zkInterface.parseTransaction(tx);
    if (!call || (call.args[0] as bigint) !== epoch) continue; // only this batch's calls
    calls.set(call.name, (calls.get(call.name) ?? 0) + 1);
  }
}
const summary = [...calls.entries()].map(([name, n]) => `${n} × ${name}`).join(", ");
console.log(`
Every transaction for ZK batch ${epoch}: ${summary}. No reveal, ever.
Limit prices and unfilled orders were never published. Bot transactions: ${botTxs}. Bot profit: ${fmtAmount((await botValue()) - botBefore)} mUSD.`);
provider.destroy();
