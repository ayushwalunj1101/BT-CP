/**
 * A market maker for the live Sepolia demo, so one person can trade alone and still be filled.
 *
 * It wakes up when someone else commits to a batch, quotes both sides around the AMM's price in that same
 * batch (a buy just below it, a sell just above), and keeps quoting for the next couple of batches. Its own
 * buy and sell never cross, so it only ever trades with other people, at the price the auction sets. While
 * nobody trades it sends nothing, so it costs nothing.
 *
 * Two accounts: one always buys, one always sells. They commit and reveal like any other trader.
 */
import {
  Contract,
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
  MockERC20Abi,
  ObscuraAuctionAbi,
  PRICE_SCALE,
  type SealedOrder,
  SimpleAMMAbi,
  epochAt,
  fmtAmount,
  phaseAt,
  read,
  readClock,
} from "@obscura/shared";
import { commitSealed, revealSealed } from "./traders.ts";

export type MarketMakerConfig = {
  provider: JsonRpcProvider;
  /** Places the buy orders. Connected to `provider`. */
  buyer: Wallet;
  /** Places the sell orders. Connected to `provider`. */
  seller: Wallet;
  deployment: Deployment;
  /** How far each quote sits from the AMM price, in basis points. Default 50 (0.5%). */
  spreadBps?: bigint;
  /** TKN per quote, 18 decimals. Default 100 TKN. */
  size?: bigint;
  /** Batches to keep quoting after the last one where someone else committed. Default 2. */
  stayBatches?: bigint;
  log?: (line: string) => void;
  pollMs?: number;
};

/** What each account keeps deposited in the auction: the buyer holds mUSD, the seller TKN. */
const BUYER_MUSD = parseUnits("200000", 18);
const SELLER_TKN = parseUnits("2000", 18);
/** Below this an account cannot pay a bond and gas, so the market maker stops quoting. */
const MIN_ETH = parseEther("0.002");

type Quote = { orders: (SealedOrder | null)[]; revealed: boolean };

const max = (a: bigint, b: bigint) => (a > b ? a : b);

export class MarketMaker {
  private readonly log: (line: string) => void;
  private readonly auction: Contract;
  private readonly amm: Contract;
  private readonly spreadBps: bigint;
  private readonly size: bigint;
  private readonly stay: bigint;
  private clock?: EpochClock;
  /** Quote in every batch up to and including this one. */
  private activeUntil = -1n;
  private readonly quotes = new Map<bigint, Quote>();
  private lowEth = false;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly config: MarketMakerConfig) {
    const { provider, deployment } = config;
    this.log = config.log ?? ((line) => console.log(`[mm] ${line}`));
    this.auction = new Contract(deployment.auction, ObscuraAuctionAbi, provider);
    this.amm = new Contract(deployment.amm, SimpleAMMAbi, provider);
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
    const [free, locked] = await Promise.all([
      read<bigint>(this.auction, "freeBalance", wallet.address, token),
      read<bigint>(this.auction, "lockedBalance", wallet.address, token),
    ]);
    const held = free + locked;
    if (held >= target / 2n) return;
    const need = target - held;

    const erc20 = new Contract(token, MockERC20Abi, wallet);
    await (await erc20.getFunction("mint")(wallet.address, need)).wait();
    await (await erc20.getFunction("approve")(this.config.deployment.auction, need)).wait();
    await (
      await new Contract(this.config.deployment.auction, ObscuraAuctionAbi, wallet).getFunction("deposit")(
        token,
        need,
      )
    ).wait();
    this.log(`${wallet.address} deposited ${fmtAmount(need)} ${symbol} into the auction`);
  }

  /** One pass: reveal what is due, and quote where someone is trading. */
  async step(): Promise<void> {
    this.clock ??= await readClock(this.auction);
    const clock = this.clock;
    const next = await this.nextBlock();
    const epoch = epochAt(clock, next);

    for (const [e, quote] of this.quotes) {
      if (quote.revealed || phaseAt(clock, e, next) !== "Reveal") continue;
      quote.revealed = true;
      if (!quote.orders.some(Boolean)) continue;
      const results = await Promise.allSettled(
        this.wallets.map(async (w, i) => {
          const order = quote.orders[i];
          if (order) await (await revealSealed(this.config.deployment.auction, w, e, order)).wait();
        }),
      );
      this.report(`batch ${e}: revealed our quotes`, results);
    }
    for (const e of this.quotes.keys()) if (e < epoch - 2n) this.quotes.delete(e);

    // Anyone else committing keeps us in the market for a while.
    const commitments = await read<{ trader: string }[]>(this.auction, "getCommitments", epoch);
    if (commitments.some((c) => !this.isMine(c.trader)))
      this.activeUntil = max(this.activeUntil, epoch + this.stay);

    if (phaseAt(clock, epoch, next) !== "Commit" || epoch > this.activeUntil || this.quotes.has(epoch))
      return;
    if (!(await this.hasEth())) return;

    const [bid, ask] = await this.quotePrices();
    const orders: SealedOrder[] = [
      { isBuy: true, limitPrice: bid, amount: this.size, salt: hexlify(randomBytes(32)) },
      { isBuy: false, limitPrice: ask, amount: this.size, salt: hexlify(randomBytes(32)) },
    ];
    const quote: Quote = { orders: [null, null], revealed: false };
    this.quotes.set(epoch, quote);
    const bond = await read<bigint>(this.auction, "revealBond");
    const results = await Promise.allSettled(
      this.wallets.map(async (w, i) => {
        await (await commitSealed(this.config.deployment.auction, w, epoch, orders[i]!, bond)).wait();
        quote.orders[i] = orders[i]!;
      }),
    );
    this.report(
      `batch ${epoch}: quoting buy ${fmtAmount(this.size)} TKN at ${fmtAmount(bid)}, ` +
        `sell at ${fmtAmount(ask)} (sealed)`,
      results,
    );
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

  private report(done: string, results: PromiseSettledResult<unknown>[]): void {
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === 0) this.log(done);
    else this.log(`${done}, but ${failed.length} of 2 failed: ${String(failed[0]!.reason).split("\n")[0]}`);
  }
}
