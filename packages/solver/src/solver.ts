/**
 * The solver service: reads each batch's revealed orders, computes the clearing (clearing.ts), checks it
 * with the contract's own rules before risking a bond, submits it, and calls settle() once the batch closes.
 *
 * Tests and the harness call solve() and settle() directly. demo:up runs start(), which follows the clock.
 */
import { Contract, type JsonRpcProvider, type Wallet, formatEther } from "ethers";
import {
  AUCTION_GAS,
  type EpochClock,
  ObscuraAuctionAbi,
  epochAt,
  fmtAmount,
  phaseAt,
  read,
  readClock,
} from "@obscura/shared";
import { clearBatch } from "./clearing.ts";

export type OnChainOrder = { trader: string; isBuy: boolean; limitPrice: bigint; amount: bigint };

export type SolverConfig = {
  provider: JsonRpcProvider;
  /** The solver's wallet, connected to `provider`. It pays the bonds. */
  wallet: Wallet;
  auction: string;
  log?: (line: string) => void;
  pollMs?: number;
};

export type SubmittedSolution = { hash: string; price: bigint; volume: bigint; orders: number };

export class Solver {
  private readonly auction: Contract;
  private readonly log: (line: string) => void;
  private clock?: EpochClock;
  private readonly solved = new Set<bigint>();
  private readonly settled = new Set<bigint>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly config: SolverConfig) {
    this.auction = new Contract(config.auction, ObscuraAuctionAbi, config.wallet);
    this.log = config.log ?? ((line) => console.log(`[solver] ${line}`));
  }

  async getClock(): Promise<EpochClock> {
    this.clock ??= await readClock(this.auction);
    return this.clock;
  }

  async orders(epoch: bigint): Promise<OnChainOrder[]> {
    const raw = await read<OnChainOrder[]>(this.auction, "getOrders", epoch);
    return raw.map((o) => ({ trader: o.trader, isBuy: o.isBuy, limitPrice: o.limitPrice, amount: o.amount }));
  }

  /** Compute and submit a solution for `epoch`. Null when no order was revealed, or nothing crosses. */
  async solve(epoch: bigint): Promise<SubmittedSolution | null> {
    this.solved.add(epoch);
    const orders = await this.orders(epoch);
    const clearing = clearBatch(orders);
    if (!clearing) return null;
    // Nothing crosses: a solution would only record zero fills. Without one, settle() releases every order.
    if (clearing.volume === 0n) {
      this.log(`epoch ${epoch}: ${orders.length} orders, none cross. Nothing to submit.`);
      return null;
    }

    // Run the exact check settle() will run, so a bug here never costs us the bond.
    const [ok] = await read<[boolean, bigint]>(
      this.auction,
      "checkClearing",
      orders,
      clearing.price,
      clearing.fills,
    );
    if (!ok) throw new Error(`solver bug: the contract rejects our solution for epoch ${epoch}`);

    const bond = await read<bigint>(this.auction, "solverBond");
    const tx = await this.auction.getFunction("submitSolution")(epoch, clearing.price, clearing.fills, {
      value: bond,
      gasLimit: AUCTION_GAS.submit(orders.length),
    });
    this.log(
      `epoch ${epoch}: ${orders.length} orders → p* = ${fmtAmount(clearing.price)} mUSD/TKN, ` +
        `matched ${fmtAmount(clearing.volume)} TKN. Submitted with a ${formatEther(bond)} ETH bond.`,
    );
    return { hash: tx.hash, price: clearing.price, volume: clearing.volume, orders: orders.length };
  }

  /** Close `epoch`: checks every solution, slashes bad ones, executes the best. */
  async settle(epoch: bigint): Promise<string> {
    this.settled.add(epoch);
    const orderCount = (await this.orders(epoch)).length;
    const tx = await this.auction.getFunction("settle")(epoch, { gasLimit: AUCTION_GAS.settle(orderCount) });
    this.log(`epoch ${epoch}: settle() sent. Every fill in the batch executes at the same price.`);
    return tx.hash as string;
  }

  /** Follow the chain: solve each batch when its solve window opens, settle it when it closes. */
  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.pollMs ?? 500);
    this.log(`running as ${this.config.wallet.address}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const clock = await this.getClock();
      const next = BigInt(await this.config.provider.getBlockNumber()) + 1n; // our transaction lands here
      const epoch = epochAt(clock, next);

      if (phaseAt(clock, epoch, next) === "Solve" && !this.solved.has(epoch)) await this.solve(epoch);

      for (let e = epoch - 1n; e >= 0n && e >= epoch - 3n; e--) {
        if (this.settled.has(e) || phaseAt(clock, e, next) !== "Settleable") continue;
        const [status, commitments] = await Promise.all([
          read<bigint>(this.auction, "epochStatus", e),
          read<unknown[]>(this.auction, "getCommitments", e),
        ]);
        if (status !== 0n || commitments.length === 0) {
          this.settled.add(e); // already closed, or nothing ever happened in it
          continue;
        }
        await this.settle(e);
      }

      // Collect refunded bonds now and then, so the solver never runs out of ETH for new ones.
      const owed = await read<bigint>(this.auction, "claimableEth", this.config.wallet.address);
      if (owed > 0n) await this.auction.getFunction("withdrawEth")({ gasLimit: 100_000n });
    } catch (err) {
      this.log(`error: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      this.busy = false;
    }
  }
}
