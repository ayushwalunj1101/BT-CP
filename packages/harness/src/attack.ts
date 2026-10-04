/**
 * Act I of the demo: an ordinary trade on an ordinary exchange, and what the bot does to it.
 * Needs a running chain with the bot: start one with "npm run demo:up" first.
 * Usage: npm run demo:attack -- [--side buy|sell] [--amount 50000] [--slippage 100] [--rpc http://127.0.0.1:8545]
 *   --amount    how much the victim pays: mUSD when buying, TKN when selling
 *   --slippage  how far below the quote the victim accepts, in basis points (100 = 1%)
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Contract, Interface, parseUnits } from "ethers";
import {
  ANVIL_CHAIN_ID,
  MockERC20Abi,
  ROLE,
  SimpleAMMAbi,
  anvilWallet,
  fmtAmount,
  httpProvider,
  loadDeployment,
  read,
  shortHash,
  shortfallBps,
} from "@obscura/shared";
import { type Side, sendVictimSwap, swapOutput } from "./victim.ts";

const { values } = parseArgs({
  options: {
    side: { type: "string", default: "buy" },
    amount: { type: "string", default: "50000" },
    slippage: { type: "string", default: "100" },
    rpc: { type: "string", default: "http://127.0.0.1:8545" },
  },
});
if (values.side !== "buy" && values.side !== "sell") throw new Error(`--side must be "buy" or "sell"`);
const side: Side = values.side;
const slippageBps = BigInt(values.slippage);

const deployment = loadDeployment();
const provider = httpProvider(values.rpc, ANVIL_CHAIN_ID);
const victim = anvilWallet(ROLE.victim, provider);
const botAddress = anvilWallet(ROLE.bot).address;
const amm = new Contract(deployment.amm, SimpleAMMAbi, provider);
const tkn = new Contract(deployment.tkn, MockERC20Abi, provider);
const musd = new Contract(deployment.musd, MockERC20Abi, provider);
const ammInterface = new Interface(SimpleAMMAbi);
const symbol = (token: string) => (token.toLowerCase() === deployment.tkn.toLowerCase() ? "TKN" : "mUSD");

const botBalances = async () => {
  const [t, m] = await Promise.all([
    read<bigint>(tkn, "balanceOf", botAddress),
    read<bigint>(musd, "balanceOf", botAddress),
  ]);
  return { tkn: t, musd: m };
};

const [tknReserve, musdReserve] = await Promise.all([
  read<bigint>(amm, "reserve0"),
  read<bigint>(amm, "reserve1"),
]);
const price = (musdReserve * 10n ** 18n) / tknReserve;
const before = await botBalances();

// Start just after a block, so the bot has a whole block interval to react, as on a real chain.
const startBlock = await provider.getBlockNumber();
while ((await provider.getBlockNumber()) === startBlock) await sleep(100);

const sent = await sendVictimSwap(deployment, victim, {
  side,
  amountIn: parseUnits(values.amount, 18),
  slippageBps,
});
const inSym = symbol(sent.tokenIn);
const outSym = symbol(sent.tokenOut);
console.log(`\nAct I: an ordinary trade on an ordinary exchange\n`);
console.log(
  `[victim] ${side === "buy" ? "buying TKN with" : "selling"} ${values.amount} ${inSym}` +
    `   quote ${fmtAmount(sent.quote)} ${outSym}` +
    `   accepts ≥ ${fmtAmount(sent.minOut)} ${outSym} (${Number(slippageBps) / 100}% slippage)`,
);
console.log(`[victim] sent ${shortHash(sent.tx.hash)}, waiting for the next block…\n`);

const receipt = await sent.tx.wait();
if (!receipt) throw new Error("transaction was dropped");
const block = await provider.getBlock(receipt.blockNumber);

console.log(`Block ${receipt.blockNumber}, in order:`);
let botTxs = 0;
for (const [i, hash] of (block?.transactions ?? []).entries()) {
  const tx = await provider.getTransaction(hash);
  if (!tx) continue;
  const who =
    tx.from.toLowerCase() === victim.address.toLowerCase()
      ? "VICTIM"
      : tx.from.toLowerCase() === botAddress.toLowerCase()
        ? "BOT"
        : "other";
  if (who === "BOT") botTxs++;
  const call =
    tx.to?.toLowerCase() === deployment.amm.toLowerCase() ? ammInterface.parseTransaction(tx) : null;
  const what =
    call?.name === "swapExactIn"
      ? `swap ${fmtAmount(call.args[1] as bigint)} ${symbol(call.args[0] as string)} → ${symbol(
          (call.args[0] as string).toLowerCase() === deployment.tkn.toLowerCase()
            ? deployment.musd
            : deployment.tkn,
        )}`
      : "other transaction";
  const role =
    who === "BOT" ? (i < (block?.transactions.indexOf(sent.tx.hash) ?? 0) ? "front-run" : "back-run") : "";
  console.log(`  ${i}  ${who.padEnd(6)}  ${shortHash(hash)}  ${what.padEnd(34)} ${role}`);
}

const out = swapOutput(receipt, deployment.amm);
if (out === null) throw new Error("the victim's swap reverted");
const after = await botBalances();
const botProfit = after.musd - before.musd + ((after.tkn - before.tkn) * price) / 10n ** 18n;
const loss = shortfallBps(sent.quote, out);

console.log(`
Victim received ${fmtAmount(out)} ${outSym} instead of ${fmtAmount(sent.quote)} ${outSym}: ${loss.toFixed(2)} bps worse (${(loss / 100).toFixed(2)}%).`);
if (botTxs === 0) {
  console.log(
    "No bot transactions in this block. Is the bot running? Start everything with: npm run demo:up",
  );
} else {
  console.log(`Bot profit: +${fmtAmount(botProfit)} mUSD, taken from the victim's trade.`);
}
provider.destroy();
