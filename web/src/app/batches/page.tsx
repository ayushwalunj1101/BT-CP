"use client";

import { ObscuraAuctionAbi } from "@obscura/shared/abis";
import type { Abi, Address } from "viem";
import { CONTRACT_PHASES } from "@/lib/clock";
import { useDeployment } from "@/lib/deployment";
import { fmt, short } from "@/lib/format";
import { useBatchNow, usePoll } from "@/lib/hooks";
import { read } from "@/lib/tx";

type Fill = { trader: Address; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint };
type Batch = {
  epoch: bigint;
  phase: (typeof CONTRACT_PHASES)[number];
  orders: number;
  price: bigint;
  volume: bigint;
  solver: Address;
  fills: Fill[];
};

const ZERO = "0x0000000000000000000000000000000000000000";
const SHOWN = 8;

export default function BatchesPage() {
  const { deployment } = useDeployment();
  const auction = deployment?.auction;
  const abi = ObscuraAuctionAbi as Abi;
  const now = useBatchNow(auction);

  const batches = usePoll<Batch[]>(
    ["batches", auction, now?.epoch.toString()],
    async () => {
      const latest = now!.epoch;
      const epochs = Array.from({ length: SHOWN }, (_, i) => latest - BigInt(i)).filter((e) => e >= 0n);
      const rows = await Promise.all(
        epochs.map(async (epoch) => {
          const [phase, list, result, fills] = await Promise.all([
            read<number>({ address: auction!, abi, functionName: "phaseOf", args: [epoch] }),
            read<unknown[]>({ address: auction!, abi, functionName: "getCommitments", args: [epoch] }),
            read<readonly [bigint, bigint, Address]>({
              address: auction!,
              abi,
              functionName: "results",
              args: [epoch],
            }),
            read<Fill[]>({ address: auction!, abi, functionName: "getFills", args: [epoch] }),
          ]);
          return {
            epoch,
            phase: CONTRACT_PHASES[phase]!,
            orders: list.length,
            price: result[0],
            volume: result[1],
            solver: result[2],
            fills,
          };
        }),
      );
      return rows.filter((b) => b.orders > 0);
    },
    !!auction && !!now,
    3_000,
    true,
  ).data;

  return (
    <>
      <div className="page-head">
        <h1>Batch explorer</h1>
        <p>
          Every settled batch has one clearing price, and every fill in it used that price. Check it yourself:
          each fill&apos;s mUSD divided by its TKN is the same number.
        </p>
      </div>
      {!deployment ? (
        <p className="muted">Obscura is not deployed on this chain.</p>
      ) : !batches ? (
        <p className="muted">Reading recent batches…</p>
      ) : batches.length === 0 ? (
        <p className="muted">No orders in the last {SHOWN} batches.</p>
      ) : (
        <div className="stack">
          {batches.map((b) => (
            <BatchCard key={b.epoch.toString()} batch={b} />
          ))}
        </div>
      )}
    </>
  );
}

function BatchCard({ batch }: { batch: Batch }) {
  const chip =
    batch.phase === "Settled"
      ? batch.volume > 0n
        ? "good"
        : ""
      : batch.phase === "Voided"
        ? "warn"
        : "accent";
  const label =
    batch.phase === "Settled" ? (batch.volume > 0n ? "Settled" : "Settled, no trades") : batch.phase;
  return (
    <section className="card" aria-label={`Batch ${batch.epoch}`}>
      <div className="clock-head">
        <h2>Batch {batch.epoch.toString()}</h2>
        <span className={`chip ${chip}`}>{label}</span>
      </div>
      <dl className="kv" style={{ marginTop: "0.6rem", maxWidth: "30rem" }}>
        <dt>Sealed orders</dt>
        <dd>{batch.orders}</dd>
        {batch.phase === "Settled" && batch.volume > 0n && (
          <>
            <dt>Clearing price (p*)</dt>
            <dd>{fmt(batch.price)} mUSD per TKN</dd>
            <dt>Matched</dt>
            <dd>{fmt(batch.volume)} TKN</dd>
            <dt>Solver</dt>
            <dd title={batch.solver}>{batch.solver === ZERO ? "none" : short(batch.solver)}</dd>
          </>
        )}
      </dl>
      {batch.fills.length > 0 && (
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead>
              <tr>
                <th>Trader</th>
                <th>Side</th>
                <th>TKN</th>
                <th>mUSD</th>
                <th>Per TKN</th>
              </tr>
            </thead>
            <tbody>
              {batch.fills.map((f, i) => (
                <tr key={i}>
                  <td className="num" title={f.trader}>
                    {short(f.trader)}
                  </td>
                  <td>{f.isBuy ? "bought" : "sold"}</td>
                  <td className="num">{fmt(f.baseAmount)}</td>
                  <td className="num">{fmt(f.quoteAmount)}</td>
                  <td className="num">{fmt((f.quoteAmount * 10n ** 18n) / f.baseAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
