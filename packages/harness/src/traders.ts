/**
 * Sealed-order helpers for any Obscura trader, and the simulated traders (feature work 2.11) that give
 * every batch orders on both sides, the way real market participants would.
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
  AUCTION_GAS,
  type EpochClock,
  ObscuraAuctionAbi,
  type SealedOrder,
  anvilWallet,
  commitmentHash,
  epochAt,
  phaseAt,
  read,
  readClock,
} from "@obscura/shared";

/** Anvil accounts 4 to 9 play the simulated traders. */
export const TRADER_ACCOUNTS = [4, 5, 6, 7, 8, 9];

type CommitmentView = { trader: string; hash: string; revealed: boolean };
type FillView = { trader: string; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint };

function auctionAs(auction: string, wallet: Wallet): Contract {
  return new Contract(auction, ObscuraAuctionAbi, wallet);
}

/** Post the sealed form of `order` into `epoch`. Only the hash goes on-chain. */
export async function commitSealed(
  auction: string,
  wallet: Wallet,
  epoch: bigint,
  order: SealedOrder,
  bond: bigint,
): Promise<ContractTransactionResponse> {
  const hash = commitmentHash(wallet.address, epoch, order);
  return (await auctionAs(auction, wallet).getFunction("commit")(epoch, hash, {
    value: bond,
    gasLimit: AUCTION_GAS.commit,
  })) as ContractTransactionResponse;
}

/** Open a committed order. Finds its slot by matching the commitment hash. */
export async function revealSealed(
  auction: string,
  wallet: Wallet,
  epoch: bigint,
  order: SealedOrder,
): Promise<ContractTransactionResponse> {
  const contract = auctionAs(auction, wallet);
  const hash = commitmentHash(wallet.address, epoch, order).toLowerCase();
  const list = await read<CommitmentView[]>(contract, "getCommitments", epoch);
  const index = list.findIndex(
    (c) => c.trader.toLowerCase() === wallet.address.toLowerCase() && c.hash.toLowerCase() === hash,
  );
  if (index < 0) throw new Error(`no commitment from ${wallet.address} for this order in epoch ${epoch}`);
  return (await contract.getFunction("reveal")(
    epoch,
    index,
    order.isBuy,
    order.limitPrice,
    order.amount,
    order.salt,
    { gasLimit: AUCTION_GAS.reveal },
  )) as ContractTransactionResponse;
}

/** What `trader` bought or sold in `epoch`: TKN amount and the mUSD paid or received. */
export async function filledFor(
  auction: Contract,
  epoch: bigint,
  trader: string,
): Promise<{ base: bigint; quote: bigint }> {
  const fills = await read<FillView[]>(auction, "getFills", epoch);
  return fills
    .filter((f) => f.trader.toLowerCase() === trader.toLowerCase())
    .reduce((sum, f) => ({ base: sum.base + f.baseAmount, quote: sum.quote + f.quoteAmount }), {
      base: 0n,
      quote: 0n,
    });
}

/** A salt drawn from a seeded generator, so harness runs are repeatable. */
export function seededSalt(random: () => number): string {
  return keccak256(toUtf8Bytes(`salt-${random()}-${random()}`));
}

/** `count` random orders around `referencePrice`: limits within ±1%, sizes 100 to 600 TKN. */
export function randomOrders(random: () => number, referencePrice: bigint, count: number): SealedOrder[] {
  return Array.from({ length: count }, () => {
    const isBuy = random() < 0.5;
    const offsetBps = BigInt(Math.round((random() * 2 - 1) * 100));
    return {
      isBuy,
      limitPrice: (referencePrice * (10_000n + offsetBps)) / 10_000n,
      amount: BigInt(Math.round(100 + random() * 500)) * 10n ** 18n,
      salt: seededSalt(random),
    };
  });
}

export type TradersConfig = {
  provider: JsonRpcProvider;
  auction: string;
  /** Market price the traders quote around; demo:up uses the AMM's price. */
  referencePrice: () => Promise<bigint>;
  random: () => number;
  log?: (line: string) => void;
  pollMs?: number;
};

/** The simulated traders as a live loop: commit in every commit window, reveal in every reveal window. */
export class SimulatedTraders {
  readonly wallets: Wallet[];
  private readonly sealed = new Map<bigint, SealedOrder[]>();
  private readonly revealed = new Set<bigint>();
  private readonly log: (line: string) => void;
  private clock?: EpochClock;
  private bond?: bigint;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly config: TradersConfig) {
    this.wallets = TRADER_ACCOUNTS.map((i) => anvilWallet(i, config.provider));
    this.log = config.log ?? ((line) => console.log(`[traders] ${line}`));
  }

  /** One sealed order per trader into `epoch`. */
  async commitAll(epoch: bigint, orders: SealedOrder[]): Promise<ContractTransactionResponse[]> {
    this.bond ??= await read<bigint>(
      new Contract(this.config.auction, ObscuraAuctionAbi, this.config.provider),
      "revealBond",
    );
    this.sealed.set(epoch, orders);
    return Promise.all(
      orders.map((o, i) => commitSealed(this.config.auction, this.wallets[i]!, epoch, o, this.bond!)),
    );
  }

  async revealAll(epoch: bigint): Promise<ContractTransactionResponse[]> {
    this.revealed.add(epoch);
    const orders = this.sealed.get(epoch) ?? [];
    return Promise.all(orders.map((o, i) => revealSealed(this.config.auction, this.wallets[i]!, epoch, o)));
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
      this.clock ??= await readClock(
        new Contract(this.config.auction, ObscuraAuctionAbi, this.config.provider),
      );
      const next = BigInt(await this.config.provider.getBlockNumber()) + 1n;
      const epoch = epochAt(this.clock, next);
      if (phaseAt(this.clock, epoch, next) === "Commit" && !this.sealed.has(epoch)) {
        const orders = randomOrders(
          this.config.random,
          await this.config.referencePrice(),
          this.wallets.length,
        );
        await this.commitAll(epoch, orders);
        this.log(`epoch ${epoch}: ${orders.length} sealed orders committed`);
      }
      for (const e of this.sealed.keys()) {
        if (!this.revealed.has(e) && phaseAt(this.clock, e, next) === "Reveal") {
          await this.revealAll(e);
          this.log(`epoch ${e}: ${this.sealed.get(e)!.length} orders revealed`);
        }
      }
    } catch (err) {
      this.log(`error: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      this.busy = false;
    }
  }
}
