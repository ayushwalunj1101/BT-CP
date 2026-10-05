/**
 * A market maker for the live Sepolia demo, so one person can trade alone and still be filled.
 *
 * It wakes up when someone else commits to a batch, quotes both sides around the AMM's price in that same
 * batch (a buy just below it, a sell just above), and keeps quoting for the next couple of batches. Its own
 * buy and sell never cross, so it only ever trades with other people, at the price the auction sets. While
 * nobody trades it sends nothing, so it costs nothing.
 *
 * Two accounts: one always buys, one always sells, on both auctions. On the commit-reveal auction they commit
 * and reveal like any trader. On the ZK auction they commit and send the order privately to the solver; that
 * auction takes one order per trader per batch, which is why there are two accounts.
 */
import {
  Contract,
  type InterfaceAbi,
  type JsonRpcProvider,
  type Wallet,
  hexlify,
  parseEther,
  parseUnits,
  randomBytes,
} from "ethers";
import {
  type Deployment,
  type EpochClock,
  LOT,
  MockERC20Abi,
  ObscuraAuctionAbi,
  ObscuraAuctionZKAbi,
  PRICE_SCALE,
  type SealedOrder,
  SimpleAMMAbi,
  TICK,
  type ZkOrder,
  epochAt,
  fmtAmount,
  phaseAt,
  read,
  readClock,
} from "@obscura/shared";
import { sendOrderToSolver } from "@obscura/solver";
import { commitSealed, revealSealed } from "./traders.ts";
import { commitZk } from "./zkTraders.ts";

export type MarketMakerConfig = {
  provider: JsonRpcProvider;
  /** Places the buy orders. Connected to `provider`. */
  buyer: Wallet;
  /** Places the sell orders. Connected to `provider`. */
  seller: Wallet;
  deployment: Deployment;
  /** The ZK solver's private order inbox, and the key orders are encrypted to. */
  inboxUrl: string;
  solverPublicKey: string;
  /** How far each quote sits from the AMM price, in basis points. Default 50 (0.5%). */
  spreadBps?: bigint;
  /** TKN per quote, 18 decimals. Default 100 TKN. */
  size?: bigint;
  /** Batches to keep quoting after the last one where someone else committed. Default 2. */
  stayBatches?: bigint;
  log?: (line: string) => void;
  pollMs?: number;
};

/** What each account keeps deposited in each auction: the buyer holds mUSD, the seller TKN. */
const BUYER_MUSD = parseUnits("200000", 18);
const SELLER_TKN = parseUnits("2000", 18);
/** Below this an account cannot pay a bond and gas, so the market maker stops quoting. */
const MIN_ETH = parseEther("0.002");
/** Collect refunded bonds every this many steps. */
const COLLECT_EVERY = 15;

type V1Quote = { orders: (SealedOrder | null)[]; revealed: boolean };
type Venue = { address: string; abi: InterfaceAbi; name: string };

const max = (a: bigint, b: bigint) => (a > b ? a : b);

export class MarketMaker {
  private readonly log: (line: string) => void;
  private readonly auction: Contract;
  private readonly zkAuction: Contract;
  private readonly amm: Contract;
  private readonly venues: Venue[];
  private readonly spreadBps: bigint;
  private readonly size: bigint;
  private readonly stay: bigint;
  private v1Clock?: EpochClock;
  private zkClock?: EpochClock;
  /** Quote in every batch up to and including these. */
  private v1ActiveUntil = -1n;
  private zkActiveUntil = -1n;
  private readonly v1Quotes = new Map<bigint, V1Quote>();
  /** ZK batches we quoted in that have not settled yet: our balance is locked until they do. */
  private readonly zkPending = new Set<bigint>();
  private steps = 0;
  private lowEth = false;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly config: MarketMakerConfig) {
    const { provider, deployment } = config;
    this.log = config.log ?? ((line) => console.log(`[mm] ${line}`));
    this.auction = new Contract(deployment.auction, ObscuraAuctionAbi, provider);
    this.zkAuction = new Contract(deployment.zkAuction, ObscuraAuctionZKAbi, provider);
    this.amm = new Contract(deployment.amm, SimpleAMMAbi, provider);
    this.venues = [
      { address: deployment.auction, abi: ObscuraAuctionAbi, name: "commit-reveal auction" },
      { address: deployment.zkAuction, abi: ObscuraAuctionZKAbi, name: "ZK auction" },
    ];
    this.spreadBps = config.spreadBps ?? 50n;
    this.size = config.size ?? parseUnits("100", 18);
    this.stay = config.stayBatches ?? 2n;
  }

  private get wallets(): Wallet[] {
    return [this.config.buyer, this.config.seller];
  }

  private isMine(trader: string): boolean {
    return this.wallets.some((w) => w.address.toLowerCase() === trader.toLowerCase());
  }

  /** Mint and deposit the inventory each account quotes from, where it is low (in practice, the first run). */
  async prepare(): Promise<void> {
    const { buyer, seller, deployment } = this.config;
    await Promise.all([
      this.stock(buyer, deployment.musd, "mUSD", BUYER_MUSD),
      this.stock(seller, deployment.tkn, "TKN", SELLER_TKN),
    ]);
  }

  private async stock(wallet: Wallet, token: string, symbol: string, target: bigint): Promise<void> {
    const held = await Promise.all(
      this.venues.map(async (v) => {
        const venue = new Contract(v.address, v.abi, this.config.provider);
        const [free, locked] = await Promise.all([
          read<bigint>(venue, "freeBalance", wallet.address, token),
          read<bigint>(venue, "lockedBalance", wallet.address, token),
        ]);
        return free + locked;
      }),
    );
    const needs = held.map((h) => (h < target / 2n ? target - h : 0n));
    const total = needs.reduce((a, b) => a + b, 0n);
    if (total === 0n) return;

    const erc20 = new Contract(token, MockERC20Abi, wallet);
    await (await erc20.getFunction("mint")(wallet.address, total)).wait();
    for (const [i, v] of this.venues.entries()) {
      if (needs[i] === 0n) continue;
      await (await erc20.getFunction("approve")(v.address, needs[i])).wait();
      await (await new Contract(v.address, v.abi, wallet).getFunction("deposit")(token, needs[i])).wait();
      this.log(`${wallet.address} deposited ${fmtAmount(needs[i]!)} ${symbol} into the ${v.name}`);
    }
  }

  /** One pass: reveal what is due, quote where someone is trading, and now and then collect refunded bonds. */
  async step(): Promise<void> {
    await this.stepV1();
    await this.stepZk();
    if (++this.steps % COLLECT_EVERY === 0) await this.collectBonds();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.pollMs ?? 500);
    this.log(
      `running: buyer ${this.config.buyer.address}, seller ${this.config.seller.address}. ` +
        `Quotes ${fmtAmount(this.size)} TKN each side, ${Number(this.spreadBps) / 100}% from the AMM price, ` +
        `whenever someone else commits.`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } catch (err) {
      this.log(`error: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      this.busy = false;
    }
  }

  private async nextBlock(): Promise<bigint> {
    return BigInt(await this.config.provider.getBlockNumber()) + 1n;
  }

  // ------------------------------------------------------------------ commit-reveal auction

  private async stepV1(): Promise<void> {
    this.v1Clock ??= await readClock(this.auction);
    const clock = this.v1Clock;
    const next = await this.nextBlock();
    const epoch = epochAt(clock, next);

    for (const [e, quote] of this.v1Quotes) {
      if (quote.revealed || phaseAt(clock, e, next) !== "Reveal") continue;
      quote.revealed = true;
      if (!quote.orders.some(Boolean)) continue;
      const results = await Promise.allSettled(
        this.wallets.map(async (w, i) => {
          const order = quote.orders[i];
          if (order) await (await revealSealed(this.config.deployment.auction, w, e, order)).wait();
        }),
      );
      this.report(`commit-reveal batch ${e}: revealed our quotes`, results);
    }
    for (const e of this.v1Quotes.keys()) if (e < epoch - 2n) this.v1Quotes.delete(e);

    // Anyone else committing keeps us in the market for a while.
    const commitments = await read<{ trader: string }[]>(this.auction, "getCommitments", epoch);
    if (commitments.some((c) => !this.isMine(c.trader)))
      this.v1ActiveUntil = max(this.v1ActiveUntil, epoch + this.stay);

    if (phaseAt(clock, epoch, next) !== "Commit" || epoch > this.v1ActiveUntil || this.v1Quotes.has(epoch))
      return;
    if (!(await this.hasEth())) return;

    const [bid, ask] = await this.quotePrices();
    const orders: SealedOrder[] = [
      { isBuy: true, limitPrice: bid, amount: this.size, salt: hexlify(randomBytes(32)) },
      { isBuy: false, limitPrice: ask, amount: this.size, salt: hexlify(randomBytes(32)) },
    ];
    const quote: V1Quote = { orders: [null, null], revealed: false };
    this.v1Quotes.set(epoch, quote);
    const bond = await read<bigint>(this.auction, "revealBond");
    const results = await Promise.allSettled(
      this.wallets.map(async (w, i) => {
        await (await commitSealed(this.config.deployment.auction, w, epoch, orders[i]!, bond)).wait();
        quote.orders[i] = orders[i]!;
      }),
    );
    this.report(
      `commit-reveal batch ${epoch}: quoting buy ${fmtAmount(this.size)} TKN at ${fmtAmount(bid)}, ` +
        `sell at ${fmtAmount(ask)} (sealed)`,
      results,
    );
  }

  // ------------------------------------------------------------------ ZK auction

  private async stepZk(): Promise<void> {
    this.zkClock ??= await readClock(this.zkAuction);
    const clock = this.zkClock;
    const next = await this.nextBlock();
    const epoch = epochAt(clock, next);

    const slots = await read<{ trader: string }[]>(this.zkAuction, "getSlots", epoch);
    if (slots.some((s) => !this.isMine(s.trader)))
      this.zkActiveUntil = max(this.zkActiveUntil, epoch + this.stay);

    if (phaseAt(clock, epoch, next) !== "Commit" || epoch > this.zkActiveUntil || this.zkPending.has(epoch))
      return;
    // A ZK commit locks the account's whole balance, so wait until our earlier batches have settled.
    for (const e of this.zkPending) {
      if ((await read<bigint>(this.zkAuction, "epochStatus", e)) === 0n) return;
      this.zkPending.delete(e);
    }
    if (!(await this.hasEth())) return;

    const [bid, ask] = await this.quotePrices();
    const lots = this.size / LOT;
    const orders: ZkOrder[] = [
      { isBuy: true, limitTicks: bid / TICK, amountLots: lots, salt: randomFieldSalt() },
      { isBuy: false, limitTicks: (ask + TICK - 1n) / TICK, amountLots: lots, salt: randomFieldSalt() },
    ];
    this.zkPending.add(epoch);
    const bond = await read<bigint>(this.zkAuction, "revealBond");
    const results = await Promise.allSettled(
      this.wallets.map(async (w, i) => {
        await (await commitZk(this.config.deployment.zkAuction, w, epoch, orders[i]!, bond)).wait();
        await sendOrderToSolver(this.config.inboxUrl, this.config.solverPublicKey, {
          epoch,
          trader: w.address,
          order: orders[i]!,
        });
      }),
    );
    this.report(
      `ZK batch ${epoch}: quoting buy ${fmtAmount(this.size)} TKN at ${fmtAmount(orders[0]!.limitTicks * TICK)}, ` +
        `sell at ${fmtAmount(orders[1]!.limitTicks * TICK)} (sent privately to the solver)`,
      results,
    );
  }

  // ------------------------------------------------------------------ helpers

  /** Bid and ask, `spreadBps` either side of the AMM price. */
  private async quotePrices(): Promise<[bigint, bigint]> {
    const [tkn, musd] = await Promise.all([
      read<bigint>(this.amm, "reserve0"),
      read<bigint>(this.amm, "reserve1"),
    ]);
    const mid = (musd * PRICE_SCALE) / tkn;
    return [(mid * (10_000n - this.spreadBps)) / 10_000n, (mid * (10_000n + this.spreadBps)) / 10_000n];
  }

  private async hasEth(): Promise<boolean> {
    const balances = await Promise.all(this.wallets.map((w) => this.config.provider.getBalance(w.address)));
    const ok = balances.every((b) => b >= MIN_ETH);
    if (!ok && !this.lowEth)
      this.log("not enough ETH for bonds and gas, so not quoting. Restart to top it up.");
    this.lowEth = !ok;
    return ok;
  }

  /** Bonds come back as claimable ETH when a ZK batch settles (and on a failed push); withdraw them. */
  private async collectBonds(): Promise<void> {
    for (const v of this.venues) {
      for (const w of this.wallets) {
        const venue = new Contract(v.address, v.abi, w);
        if ((await read<bigint>(venue, "claimableEth", w.address)) > 0n)
          await (await venue.getFunction("withdrawEth")({ gasLimit: 100_000n })).wait();
      }
    }
  }

  private report(done: string, results: PromiseSettledResult<unknown>[]): void {
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === 0) this.log(done);
    else this.log(`${done}, but ${failed.length} of 2 failed: ${String(failed[0]!.reason).split("\n")[0]}`);
  }
}

/** A random salt below the SNARK field (31 bytes). */
function randomFieldSalt(): bigint {
  return BigInt(hexlify(randomBytes(31)));
}
