/**
 * Trading on the ZK auction: commit a Poseidon-sealed order on-chain, send the order itself to the solver
 * privately. Plus simulated traders (accounts 11 to 16) that do this in every batch of the live demo.
 */
import {
  Contract,
  type ContractTransactionResponse,
  type JsonRpcProvider,
  type Wallet,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  type EpochClock,
  ObscuraAuctionZKAbi,
  TICK,
  type ZkOrder,
  anvilWallet,
  epochAt,
  phaseAt,
  read,
  readClock,
  zkCommitment,
} from "@obscura/shared";
import { sendOrderToSolver } from "@obscura/solver";

/** Accounts 11 to 16 play the simulated traders on the ZK auction. */
export const ZK_TRADER_ACCOUNTS = [11, 12, 13, 14, 15, 16];

/** Gas for a ZK commit (it also locks two balances). Set explicitly to skip estimation. */
const COMMIT_GAS = 300_000n;

/** Post the Poseidon commitment of `order` into `epoch`. Locks the trader's whole free balance. */
export async function commitZk(
  zkAuction: string,
  wallet: Wallet,
  epoch: bigint,
  order: ZkOrder,
  bond: bigint,
): Promise<ContractTransactionResponse> {
  const auction = new Contract(zkAuction, ObscuraAuctionZKAbi, wallet);
  return (await auction.getFunction("commit")(epoch, zkCommitment(wallet.address, epoch, order), {
    value: bond,
    gasLimit: COMMIT_GAS,
  })) as ContractTransactionResponse;
}

/** A field-sized salt from a seeded generator, so harness runs are repeatable. */
export function seededFieldSalt(random: () => number): bigint {
  return BigInt(keccak256(toUtf8Bytes(`zk-salt-${random()}-${random()}`))) >> 8n;
}

/** Convert a 1e18-scaled price to whole ticks. */
export function toTicks(price: bigint): bigint {
  return price / TICK;
}

/** `count` random ZK orders around `referencePrice`: limits within ±1%, sizes 100 to 600 TKN. */
export function randomZkOrders(random: () => number, referencePrice: bigint, count: number): ZkOrder[] {
  const ref = toTicks(referencePrice);
  return Array.from({ length: count }, () => ({
    isBuy: random() < 0.5,
    limitTicks: (ref * (10_000n + BigInt(Math.round((random() * 2 - 1) * 100)))) / 10_000n,
    amountLots: BigInt(Math.round(100 + random() * 500)) * 1_000n,
    salt: seededFieldSalt(random),
  }));
}

export type ZkTradersConfig = {
  provider: JsonRpcProvider;
  zkAuction: string;
  inboxUrl: string;
  solverPublicKey: string;
  referencePrice: () => Promise<bigint>;
  random: () => number;
  log?: (line: string) => void;
  pollMs?: number;
};

/** The ZK simulated traders as a live loop: commit and privately send an order in every batch. */
export class ZkSimulatedTraders {
  readonly wallets: Wallet[];
  private readonly committed = new Set<bigint>();
  private readonly log: (line: string) => void;
  private readonly auction: Contract;
  private clock?: EpochClock;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly config: ZkTradersConfig) {
    this.wallets = ZK_TRADER_ACCOUNTS.map((i) => anvilWallet(i, config.provider));
    this.log = config.log ?? ((line) => console.log(`[zk-traders] ${line}`));
    this.auction = new Contract(config.zkAuction, ObscuraAuctionZKAbi, config.provider);
  }

  /** Commit one order per trader into `epoch`, then send each order to the solver's private inbox. */
  async tradeIn(epoch: bigint, orders: ZkOrder[]): Promise<void> {
    this.committed.add(epoch);
    const bond = await read<bigint>(this.auction, "revealBond");
    await Promise.all(
      orders.map((o, i) => commitZk(this.config.zkAuction, this.wallets[i]!, epoch, o, bond)),
    );
    await Promise.all(
      orders.map((order, i) =>
        sendOrderToSolver(this.config.inboxUrl, this.config.solverPublicKey, {
          epoch,
          trader: this.wallets[i]!.address,
          order,
        }),
      ),
    );
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.pollMs ?? 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.clock ??= await readClock(this.auction);
      const next = BigInt(await this.config.provider.getBlockNumber()) + 1n;
      const epoch = epochAt(this.clock, next);
      if (phaseAt(this.clock, epoch, next) !== "Commit" || this.committed.has(epoch)) return;
      // A commit locks the trader's whole free balance, so wait until the previous batch has released it.
      if (epoch > 0n) {
        const [status, slots] = await Promise.all([
          read<bigint>(this.auction, "epochStatus", epoch - 1n),
          read<unknown[]>(this.auction, "getSlots", epoch - 1n),
        ]);
        if (slots.length > 0 && status === 0n) return;
      }
      const orders = randomZkOrders(
        this.config.random,
        await this.config.referencePrice(),
        this.wallets.length,
      );
      await this.tradeIn(epoch, orders);
      this.log(
        `epoch ${epoch}: ${orders.length} sealed orders committed, contents sent privately to the solver`,
      );
    } catch (err) {
      this.log(`error: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      this.busy = false;
    }
  }
}
