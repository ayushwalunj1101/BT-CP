/**
 * The clearing engine (feature F3): one price for the whole batch, and how much each order fills.
 *
 * For a candidate price p:
 *   - buyers with a limit above p, and sellers with a limit below p, cross strictly and must fill in full;
 *   - orders exactly at p may fill partly, to make bought volume equal sold volume.
 * p is feasible when the strict crossers on each side fit inside everything the other side offers at p.
 * Its volume is min(all buying at p, all selling at p). We pick the feasible p with the most volume.
 *
 * Only the orders' own limit prices need trying: between two adjacent limits nothing sits exactly at the
 * price, so no in-between price can match more.
 */
export type BookOrder = { isBuy: boolean; limitPrice: bigint; amount: bigint };

export type BatchClearing = {
  price: bigint;
  /** One per order, in the same order as the input. */
  fills: bigint[];
  /** Matched TKN volume: total bought, which equals total sold. */
  volume: bigint;
};

type Candidate = { price: bigint; volume: bigint; buyStrict: bigint; sellStrict: bigint };

export function clearBatch(orders: BookOrder[]): BatchClearing | null {
  if (orders.length === 0) return null;

  const prices = [...new Set(orders.map((o) => o.limitPrice))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const feasible: Candidate[] = [];
  for (const price of prices) {
    let buyStrict = 0n;
    let buyAt = 0n;
    let sellStrict = 0n;
    let sellAt = 0n;
    for (const o of orders) {
      if (o.isBuy) {
        if (o.limitPrice > price) buyStrict += o.amount;
        else if (o.limitPrice === price) buyAt += o.amount;
      } else {
        if (o.limitPrice < price) sellStrict += o.amount;
        else if (o.limitPrice === price) sellAt += o.amount;
      }
    }
    const buyTotal = buyStrict + buyAt;
    const sellTotal = sellStrict + sellAt;
    if (buyStrict <= sellTotal && sellStrict <= buyTotal) {
      feasible.push({ price, volume: buyTotal < sellTotal ? buyTotal : sellTotal, buyStrict, sellStrict });
    }
  }
  if (feasible.length === 0) return null;

  // Most volume first. Among prices that tie, take the middle one rather than favouring either side.
  const maxVolume = feasible.reduce((m, c) => (c.volume > m ? c.volume : m), 0n);
  const best = feasible.filter((c) => c.volume === maxVolume);
  const chosen = best[Math.floor((best.length - 1) / 2)]!;

  const fills = orders.map((o) =>
    (o.isBuy && o.limitPrice > chosen.price) || (!o.isBuy && o.limitPrice < chosen.price) ? o.amount : 0n,
  );
  shareAtPrice(orders, fills, chosen.price, true, chosen.volume - chosen.buyStrict);
  shareAtPrice(orders, fills, chosen.price, false, chosen.volume - chosen.sellStrict);
  return { price: chosen.price, fills, volume: chosen.volume };
}

/**
 * Split `remaining` between the orders on one side that sit exactly at the price, in proportion to size.
 * Integer division leaves a few wei over; those go one at a time to the earliest orders with room left.
 */
function shareAtPrice(
  orders: BookOrder[],
  fills: bigint[],
  price: bigint,
  isBuy: boolean,
  remaining: bigint,
): void {
  if (remaining === 0n) return;
  const atPrice = orders.flatMap((o, i) => (o.isBuy === isBuy && o.limitPrice === price ? [i] : []));
  const total = atPrice.reduce((sum, i) => sum + orders[i]!.amount, 0n);

  let given = 0n;
  for (const i of atPrice) {
    const share = (remaining * orders[i]!.amount) / total;
    fills[i] = share;
    given += share;
  }
  for (const i of atPrice) {
    if (given === remaining) break;
    if (fills[i]! < orders[i]!.amount) {
      fills[i] = fills[i]! + 1n;
      given += 1n;
    }
  }
}
