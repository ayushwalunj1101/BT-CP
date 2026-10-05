/**
 * The solver service for the ZK auction (task 4.8): collects orders from its private inbox, and for each
 * batch checks them against the on-chain commitments, clears the batch, proves it, submits the proof, and
 * settles when the batch closes.
 */
import { Contract, type JsonRpcProvider, type Wallet } from "ethers";
import {
  type EpochClock,
  ObscuraAuctionZKAbi,
  TICK,
  type ZkOrder,
  type ZkSlot,
  epochAt,
  fmtAmount,
  phaseAt,
  read,
  readClock,
  zkCommitment,
} from "@obscura/shared";
import { type Opening, OrderInbox } from "./inbox.ts";
import { proveClearing, solveZkBatch } from "./zk.ts";

export type ZkSolverConfig = {
  provider: JsonRpcProvider;
  wallet: Wallet;
  auction: string;
  log?: (line: string) => void;
  pollMs?: number;
};

export type ZkSubmission = {
  hash: string;
  priceTicks: bigint;
  volumeLots: bigint;
  included: number;
  provingMs: number;
};

type SlotView = { trader: string; commitment: bigint; lockBase: bigint; lockQuote: bigint };

const SUBMIT_GAS = 3_000_000n;
const SETTLE_GAS = 4_000_000n;

export class ZkSolver {
  readonly inbox: OrderInbox;
  private readonly auction: Contract;
  private readonly log: (line: string) => void;
  private readonly openings = new Map<string, ZkOrder>();
  private readonly solved = new Set<bigint>();
  private readonly settled = new Set<bigint>();
  private clock?: EpochClock;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly config: ZkSolverConfig) {
    this.auction = new Contract(config.auction, ObscuraAuctionZKAbi, config.wallet);
    this.log = config.log ?? ((line) => console.log(`[zk-solver] ${line}`));
    this.inbox = new OrderInbox(config.wallet.privateKey, (opening) => this.receive(opening));
  }

  private receive(opening: Opening): void {
    this.openings.set(`${opening.epoch}:${opening.trader.toLowerCase()}`, opening.order);
    this.log(`received a sealed order for epoch ${opening.epoch} (contents stay with the solver)`);
  }

  async slots(epoch: bigint): Promise<ZkSlot[]> {
    const raw = await read<SlotView[]>(this.auction, "getSlots", epoch);
    return raw.map((s) => ({
      trader: s.trader,
      commitment: s.commitment,
      lockBase: s.lockBase,
      lockQuote: s.lockQuote,
    }));
  }

  /** Clear, prove and submit `epoch`. Null when the solver holds no valid order for it, or nothing crosses. */
  async solve(epoch: bigint): Promise<ZkSubmission | null> {
    this.solved.add(epoch);
    const slots = await this.slots(epoch);
    // Only orders that open their slot's commitment count; anything else is ignored.
    const openings = slots.map((s) => {
      const order = this.openings.get(`${epoch}:${s.trader.toLowerCase()}`);
      return order && zkCommitment(s.trader, epoch, order) === s.commitment ? order : null;
    });
    const included = openings.filter(Boolean).length;
    if (included === 0) return null;

    const cleared = solveZkBatch(epoch, slots, openings);
    // Nothing crosses: a proof would only record zero fills. Without one, settle() releases every order.
    if (cleared.volumeLots === 0n) {
      this.log(`epoch ${epoch}: ${included} orders, none cross. No proof needed; settle will release them.`);
      return null;
    }
    const proof = await proveClearing(cleared.input);
    const tx = await this.auction.getFunction("submitProof")(
      epoch,
      cleared.priceTicks,
      cleared.fillEnc,
      cleared.included,
      proof.a,
      proof.b,
      proof.c,
      { gasLimit: SUBMIT_GAS },
    );
    this.log(
      `epoch ${epoch}: ${included} of ${slots.length} orders, p* = ${fmtAmount(cleared.priceTicks * TICK)} mUSD/TKN, ` +
        `matched ${fmtAmount(cleared.volumeLots * 10n ** 15n, 3)} TKN. Proved in ${proof.ms} ms, proof submitted.`,
    );
    return {
      hash: tx.hash as string,
      priceTicks: cleared.priceTicks,
      volumeLots: cleared.volumeLots,
      included,
      provingMs: proof.ms,
    };
  }

  async settle(epoch: bigint): Promise<string> {
    this.settled.add(epoch);
    const tx = await this.auction.getFunction("settle")(epoch, { gasLimit: SETTLE_GAS });
    this.log(`epoch ${epoch}: settle() sent.`);
    return tx.hash as string;
  }

  /** Open the inbox and follow the chain. Resolves to the inbox URL. */
  async start(inboxPort: number): Promise<string> {
    const url = await this.inbox.listen(inboxPort);
    this.timer = setInterval(() => void this.tick(), this.config.pollMs ?? 500);
    this.log(`running as ${this.config.wallet.address}; private order inbox at ${url}`);
    return url;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.inbox.close();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.clock ??= await readClock(this.auction);
      const next = BigInt(await this.config.provider.getBlockNumber()) + 1n;
      const epoch = epochAt(this.clock, next);
      if (phaseAt(this.clock, epoch, next) === "Solve" && !this.solved.has(epoch)) await this.solve(epoch);
      for (let e = epoch - 1n; e >= 0n && e >= epoch - 3n; e--) {
        if (this.settled.has(e) || phaseAt(this.clock, e, next) !== "Settleable") continue;
        const [status, slots] = await Promise.all([
          read<bigint>(this.auction, "epochStatus", e),
          read<unknown[]>(this.auction, "getSlots", e),
        ]);
        if (status !== 0n || slots.length === 0) {
          this.settled.add(e);
          continue;
        }
        await this.settle(e);
      }
    } catch (err) {
      this.log(`error: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      this.busy = false;
    }
  }
}
