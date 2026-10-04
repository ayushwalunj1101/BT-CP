import { AbiCoder, hexlify, keccak256, randomBytes } from "ethers";

/** Prices are mUSD per TKN scaled by 1e18, as in the contracts. */
export const PRICE_SCALE = 10n ** 18n;

/** A batch order before it is sealed. Amounts are TKN, limit prices mUSD per TKN, both 18 decimals. */
export type OrderTerms = { isBuy: boolean; limitPrice: bigint; amount: bigint };

/** The order plus the secret salt that keeps its commitment unguessable. Keep it until you reveal. */
export type SealedOrder = OrderTerms & { salt: string };

/**
 * The sealed form of an order: exactly ObscuraAuction.commitmentHash.
 * The trader and epoch are inside, so a copied commitment cannot be revealed by anyone else or in another batch.
 */
export function commitmentHash(trader: string, epoch: bigint, order: SealedOrder): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bool", "uint128", "uint128", "bytes32"],
      [trader, epoch, order.isBuy, order.limitPrice, order.amount, order.salt],
    ),
  );
}

export function randomSalt(): string {
  return hexlify(randomBytes(32));
}

/** mUSD for `base` TKN at `price`, rounded up: what a buyer pays or locks (Clearing.quoteUp). */
export function quoteUp(base: bigint, price: bigint): bigint {
  return (base * price + PRICE_SCALE - 1n) / PRICE_SCALE;
}

/** mUSD for `base` TKN at `price`, rounded down: what a seller receives (Clearing.quoteDown). */
export function quoteDown(base: bigint, price: bigint): bigint {
  return (base * price) / PRICE_SCALE;
}
