/**
 * SandwichBot: the adversary from the brief (feature F8).
 *
 * It subscribes to pending transactions, picks out swaps on SimpleAMM, and for each one sends a
 * front-run that lands before the victim and a back-run that lands after it, in the same block.
 *
 * Ordering rule (Spike A): Anvil ranks pending transactions by max fee per gas, real Ethereum
 * builders by priority fee. The bot moves both: higher than the victim's to go first, lower to go last.
 *
 * It also watches Obscura, logs what it sees there, and finds nothing to act on.
 */
import {
  Contract,
  Interface,
  type JsonRpcProvider,
  type TransactionResponse,
  type Wallet,
  type WebSocketProvider,
  parseUnits,
} from "ethers";
import {
  MockERC20Abi,
  ObscuraAuctionAbi,
  SimpleAMMAbi,
  fmtAmount,
  fmtGwei,
  read,
  shortHash,
  wsProvider,
} from "@obscura/shared";
import { DUST_PROFIT, type SandwichPlan, planSandwich } from "./sandwich.ts";

export type BotDecision =
  | {
      victim: string;
      action: "attack";
      tokenIn: string;
      plan: SandwichPlan;
      frontHash: string;
      backHash: string;
    }
  | { victim: string; action: "skip"; reason: string };

export type BotConfig = {
  /** HTTP provider used for reads and for sending; the bot's wallet must be connected to it. */
  provider: JsonRpcProvider;
  /** WebSocket URL for the pending-transaction stream. */
  wsUrl: string;
  chainId: number;
  wallet: Wallet;
  amm: string;
  /** ObscuraAuction address, if deployed. The bot watches it too, and finds nothing it can use. */
  auction?: string;
  /** Token symbols by address, for log lines. */
  symbols: Record<string, string>;
  /** Ignore sandwiches that would earn this much or less, in the victim's input token. Default: DUST_PROFIT. */
  minProfit?: bigint;
  log?: (line: string) => void;
};

type FeeFields = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };

const ONE_GWEI = parseUnits("1", "gwei");
/** Enough for one SimpleAMM swap. Set explicitly: the back-run cannot be gas-estimated before the front-run lands. */
const SWAP_GAS_LIMIT = 200_000n;

export class SandwichBot {
  private readonly ammInterface = new Interface(SimpleAMMAbi);
  private readonly auctionInterface = new Interface(ObscuraAuctionAbi);
  private readonly amm: Contract;
  private readonly log: (line: string) => void;
  private ws?: WebSocketProvider;
  private paused = false;
  /** Victims are handled one at a time, so the bot's own nonces never race. */
  private queue: Promise<void> = Promise.resolve();
  private readonly decisions = new Map<string, BotDecision>();
  private readonly waiting = new Map<string, (decision: BotDecision) => void>();
  private readonly seen = new Set<string>();
  private readonly seenWaiting = new Map<string, () => void>();

  constructor(private readonly config: BotConfig) {
    this.amm = new Contract(config.amm, SimpleAMMAbi, config.provider);
    this.log = config.log ?? ((line) => console.log(`[bot] ${line}`));
  }

  get address(): string {
    return this.config.wallet.address;
  }

  async start(): Promise<void> {
    this.ws = wsProvider(this.config.wsUrl, this.config.chainId);
    await this.ws.on("pending", (hash: string) => {
      this.seen.add(hash);
      this.seenWaiting.get(hash)?.();
      this.seenWaiting.delete(hash);
      if (this.paused) return; // decided when the transaction arrives, not when it is processed
      this.queue = this.queue.then(() => this.handle(hash)).catch((err) => this.log(`error: ${String(err)}`));
    });
    this.log(`watching mempool  ${this.config.wsUrl}  as ${this.address}`);
  }

  async stop(): Promise<void> {
    await this.ws?.destroy();
    this.ws = undefined;
  }

  /** While paused the bot sees transactions but does nothing. The harness uses this for "no bot" runs. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Resolves once the bot's mempool stream has delivered `hash`, whether or not it acts on it. */
  waitUntilSeen(hash: string, timeoutMs = 5_000): Promise<void> {
    if (this.seen.has(hash)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.seenWaiting.delete(hash);
        reject(new Error(`bot never saw ${hash} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.seenWaiting.set(hash, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Resolves once the bot has decided what to do about `victimHash`. */
  waitForDecision(victimHash: string, timeoutMs = 5_000): Promise<BotDecision> {
    const known = this.decisions.get(victimHash);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(victimHash);
        reject(new Error(`bot made no decision about ${victimHash} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(victimHash, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
    });
  }

  private decide(decision: BotDecision): BotDecision {
    this.decisions.set(decision.victim, decision);
    this.waiting.get(decision.victim)?.(decision);
    this.waiting.delete(decision.victim);
    return decision;
  }

  private symbol(token: string): string {
    return this.config.symbols[token.toLowerCase()] ?? shortHash(token);
  }

  /**
   * What the bot can do about an Obscura transaction: nothing.
   * A commit carries only a hash. A reveal is readable, but it only arrives after the commit window has
   * closed, nobody can add orders to the batch any more, and every fill gets the same price anyway.
   */
  private inspectObscura(hash: string, data: string): void {
    const call = this.auctionInterface.parseTransaction({ data });
    if (call?.name === "commit") {
      this.log(
        `pending ${shortHash(hash)}  Obscura commit(${shortHash(call.args[1] as string)})` +
          `  sealed order: no side, no size, no price. Nothing to front-run.`,
      );
      this.decide({ victim: hash, action: "skip", reason: "sealed order" });
    } else if (call?.name === "reveal") {
      const isBuy = call.args[2] as boolean;
      this.log(
        `pending ${shortHash(hash)}  Obscura reveal: ${isBuy ? "buy" : "sell"} ${fmtAmount(call.args[4] as bigint)} TKN` +
          `  too late: the batch is closed and every fill gets one price. Going first is worth nothing.`,
      );
      this.decide({ victim: hash, action: "skip", reason: "batch order, uniform price" });
    }
  }

  private async handle(hash: string): Promise<void> {
    if (this.paused || this.decisions.has(hash)) return; // act on each transaction at most once
    const { provider, wallet } = this.config;

    const tx = await provider.getTransaction(hash);
    if (!tx?.to) return;
    if (this.config.auction && tx.to.toLowerCase() === this.config.auction.toLowerCase()) {
      this.inspectObscura(hash, tx.data);
      return;
    }
    if (tx.to.toLowerCase() !== this.config.amm.toLowerCase()) return;
    if (tx.from.toLowerCase() === wallet.address.toLowerCase()) return; // our own front/back-run

    const call = this.ammInterface.parseTransaction({ data: tx.data });
    if (call?.name !== "swapExactIn") return;
    const tokenIn = call.args[0] as string;
    const amountIn = call.args[1] as bigint;
    const minOut = call.args[2] as bigint;

    const [token0, token1, reserve0, reserve1] = await Promise.all([
      read<string>(this.amm, "token0"),
      read<string>(this.amm, "token1"),
      read<bigint>(this.amm, "reserve0"),
      read<bigint>(this.amm, "reserve1"),
    ]);
    const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();
    const tokenOut = zeroForOne ? token1 : token0;
    const pool = zeroForOne
      ? { reserveIn: reserve0, reserveOut: reserve1 }
      : { reserveIn: reserve1, reserveOut: reserve0 };

    const inSym = this.symbol(tokenIn);
    const outSym = this.symbol(tokenOut);
    this.log(
      `pending ${shortHash(hash)}  victim swaps ${fmtAmount(amountIn)} ${inSym} → ${outSym}` +
        `  (accepts ≥ ${fmtAmount(minOut)} ${outSym})`,
    );

    const budget = await read<bigint>(
      new Contract(tokenIn, MockERC20Abi, provider),
      "balanceOf",
      wallet.address,
    );
    const plan = planSandwich(pool, { amountIn, minOut }, budget, this.config.minProfit ?? DUST_PROFIT);
    if (!plan) {
      this.log("  no profitable sandwich within the victim's slippage limit. skipping.");
      this.decide({ victim: hash, action: "skip", reason: "not profitable within slippage limit" });
      return;
    }

    const fees = outbid(tx);
    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    const front = await wallet.sendTransaction({
      to: this.config.amm,
      data: this.ammInterface.encodeFunctionData("swapExactIn", [
        tokenIn,
        plan.frontIn,
        plan.frontOut,
        wallet.address,
      ]),
      nonce,
      gasLimit: SWAP_GAS_LIMIT,
      ...fees.front,
    });
    const back = await wallet.sendTransaction({
      to: this.config.amm,
      // Sell everything bought in the front-run; refuse to sell back for less than we paid.
      data: this.ammInterface.encodeFunctionData("swapExactIn", [
        tokenOut,
        plan.frontOut,
        plan.frontIn,
        wallet.address,
      ]),
      nonce: nonce + 1,
      gasLimit: SWAP_GAS_LIMIT,
      ...fees.back,
    });

    this.log(
      `  front-run: ${fmtAmount(plan.frontIn)} ${inSym} → ${outSym}   ${describeFees(fees.front)}  → goes first`,
    );
    this.log(
      `  back-run:  ${fmtAmount(plan.frontOut)} ${outSym} → ${inSym}   ${describeFees(fees.back)}  → goes last`,
    );
    this.log(`  expected profit +${fmtAmount(plan.profit)} ${inSym}`);
    this.decide({
      victim: hash,
      action: "attack",
      tokenIn,
      plan,
      frontHash: front.hash,
      backHash: back.hash,
    });
  }
}

/** Fees that rank just above the victim (front-run) and just below it (back-run). */
function outbid(victim: TransactionResponse): { front: FeeFields; back: FeeFields } {
  if (victim.maxFeePerGas != null && victim.maxPriorityFeePerGas != null) {
    const tip = victim.maxPriorityFeePerGas;
    return {
      front: { maxFeePerGas: victim.maxFeePerGas + ONE_GWEI, maxPriorityFeePerGas: tip + ONE_GWEI },
      back: { maxFeePerGas: victim.maxFeePerGas - 1n, maxPriorityFeePerGas: tip > 0n ? tip - 1n : 0n },
    };
  }
  const gasPrice = victim.gasPrice;
  return { front: { gasPrice: gasPrice + ONE_GWEI }, back: { gasPrice: gasPrice - 1n } };
}

function describeFees(fees: FeeFields): string {
  return "gasPrice" in fees ? `gas price ${fmtGwei(fees.gasPrice)}` : `max fee ${fmtGwei(fees.maxFeePerGas)}`;
}
