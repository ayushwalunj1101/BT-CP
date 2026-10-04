/**
 * The same measurement as measurement.ts, on Obscura instead of SimpleAMM (task 2.12).
 *
 * Each trade is the same economic trade as the AMM run with the same seed: same side, same size, the same
 * slippage allowance (here it becomes the order's limit price). It goes into a sealed batch with six
 * simulated traders, and the batch runs twice from one snapshot: bot paused, then bot active.
 * Extraction compares the victim's effective price between the two runs.
 */
import { join } from "node:path";
import { DEPLOYMENTS_DIR, PRICE_SCALE, ROLE, anvilWallet, read, type SealedOrder } from "@obscura/shared";
import { runManualBatch } from "./batch.ts";
import { startLocalEnv } from "./env.ts";
import { type MeasurementOptions, type Summary, type TradeRow, summarize } from "./measurement.ts";
import { mulberry32 } from "./random.ts";
import { TRADER_ACCOUNTS, randomOrders, seededSalt } from "./traders.ts";
import type { Side } from "./victim.ts";

/** Separate stream for the simulated traders, so trade sides and sizes match the AMM run exactly. */
const TRADER_SEED_OFFSET = 1_000_003;

export async function runObscuraMeasurement(
  options: MeasurementOptions,
): Promise<{ rows: TradeRow[]; summary: Summary }> {
  const env = await startLocalEnv({
    port: options.port,
    mining: { mode: "manual" },
    deploymentFile: join(DEPLOYMENTS_DIR, `test-${options.port}.json`),
    removeDeploymentOnStop: true,
    botLog: () => {},
  });
  const { provider, bot } = env;
  const tradeRandom = mulberry32(options.seed);
  const traderRandom = mulberry32(options.seed + TRADER_SEED_OFFSET);
  const botAddress = anvilWallet(ROLE.bot).address;
  const rows: TradeRow[] = [];

  const botValue = async (price: bigint) => {
    const [tkn, musd] = await Promise.all([
      read<bigint>(env.tkn, "balanceOf", botAddress),
      read<bigint>(env.musd, "balanceOf", botAddress),
    ]);
    return musd + (tkn * price) / PRICE_SCALE;
  };

  try {
    for (let trade = 1; trade <= options.trades; trade++) {
      // Same two draws, in the same order, as the AMM measurement.
      const side: Side = tradeRandom() < 0.5 ? "buy" : "sell";
      const sizeBps = options.minSizeBps + tradeRandom() * (options.maxSizeBps - options.minSizeBps);
      const [tknReserve, musdReserve] = await Promise.all([
        read<bigint>(env.amm, "reserve0"),
        read<bigint>(env.amm, "reserve1"),
      ]);
      const price = await env.marketPrice();
      const reserveIn = side === "buy" ? musdReserve : tknReserve;
      const amountIn = (reserveIn * BigInt(Math.round(sizeBps * 100))) / 1_000_000n;
      const tknAmount = side === "buy" ? (amountIn * PRICE_SCALE) / price : amountIn;
      const slip = options.slippageBps;
      const victim: SealedOrder = {
        isBuy: side === "buy",
        amount: tknAmount,
        limitPrice:
          side === "buy" ? (price * (10_000n + slip)) / 10_000n : (price * (10_000n - slip)) / 10_000n,
        salt: seededSalt(traderRandom),
      };
      const plan = { traders: randomOrders(traderRandom, price, TRADER_ACCOUNTS.length), victim };

      const snapshot = (await provider.send("evm_snapshot", [])) as string;
      bot.pause();
      const fair = await runManualBatch(env, plan, false);
      await provider.send("evm_revert", [snapshot]);
      bot.resume();

      const botBefore = await botValue(price);
      const actual = await runManualBatch(env, plan, true);
      const botAfter = await botValue(price);

      // What the victim received: TKN when buying, mUSD when selling.
      const received = (fill: { base: bigint; quote: bigint }) => (side === "buy" ? fill.base : fill.quote);
      rows.push({
        venue: "obscura",
        trade,
        side,
        amountIn: tknAmount,
        slippageBps: slip,
        fairOut: received(fair.victimFill),
        actualOut: received(actual.victimFill),
        extractionBps: priceShortfallBps(side, fair.victimFill, actual.victimFill),
        attacked: actual.decision?.action === "attack",
        botProfitMusd: botAfter - botBefore,
        victimLossMusd:
          side === "buy"
            ? actual.victimFill.quote - fair.victimFill.quote
            : fair.victimFill.quote - actual.victimFill.quote,
      });
      options.onTrade?.(rows.at(-1)!);
    }
  } finally {
    await env.stop();
  }
  return { rows, summary: summarize(rows) };
}

/** How much worse the victim's effective price was with the bot active, in basis points. */
function priceShortfallBps(
  side: Side,
  fair: { base: bigint; quote: bigint },
  actual: { base: bigint; quote: bigint },
): number {
  if (fair.base === 0n || actual.base === 0n) return fair.base === actual.base ? 0 : 10_000;
  const fairPrice = (fair.quote * PRICE_SCALE) / fair.base;
  const actualPrice = (actual.quote * PRICE_SCALE) / actual.base;
  const worse = side === "buy" ? actualPrice - fairPrice : fairPrice - actualPrice;
  return Number((worse * 1_000_000n) / fairPrice) / 100;
}
