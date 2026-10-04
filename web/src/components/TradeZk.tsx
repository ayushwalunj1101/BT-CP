"use client";

import { ObscuraAuctionZKAbi } from "@obscura/shared/abis";
import { type ReactNode, useState } from "react";
import { type Abi, type Address, formatEther, parseEventLogs } from "viem";
import { useConnection } from "wagmi";
import { CONTRACT_PHASES } from "@/lib/clock";
import { useDeployment } from "@/lib/deployment";
import { errorText, fmt, parseAmount } from "@/lib/format";
import { type BatchNow, useBatchNow, usePoll } from "@/lib/hooks";
import { LOT, TICK, type ZkOrder, randomFieldSalt, sendToSolver, zkCommitment } from "@/lib/orders";
import { type Ticket, useTickets } from "@/lib/tickets";
import { read, send } from "@/lib/tx";
import { ZK_INBOX_URL } from "@/lib/wagmi";

const abi = ObscuraAuctionZKAbi as Abi;
const COMMIT_GAS = 300_000n;

type Fill = { trader: Address; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint };

export function TradeZk() {
  const { address } = useConnection();
  const { chainId, deployment } = useDeployment();
  const auction = deployment?.zkAuction;
  const now = useBatchNow(auction);
  const scope = address && auction ? `${chainId}:${auction}:${address}` : null;
  const { tickets, add, update } = useTickets(scope);

  return (
    <div className="stack">
      <SealZkOrder auction={auction} now={now} onSealed={add} onSent={(tx) => update(tx, { sent: true })} />
      <section className="card" aria-labelledby="zk-orders-title">
        <h2 id="zk-orders-title">Your private orders</h2>
        {tickets.length === 0 ? (
          <p className="muted">No private orders from this account yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Order (only you and the solver know this)</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <ZkTicketRow
                    key={t.txHash}
                    ticket={t}
                    auction={auction!}
                    trader={address!}
                    now={now}
                    onSent={() => update(t.txHash, { sent: true })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SealZkOrder({
  auction,
  now,
  onSealed,
  onSent,
}: {
  auction: Address | undefined;
  now: BatchNow | undefined;
  onSealed: (t: Ticket) => void;
  onSent: (txHash: string) => void;
}) {
  const { address } = useConnection();
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState("10");
  const [limit, setLimit] = useState("101");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<{ commitment: string; epoch: string; sent: boolean } | null>(null);

  const info = usePoll(
    ["zk-info", auction, address, now?.epoch.toString()],
    async () => {
      const [bond, committed] = await Promise.all([
        read<bigint>({ address: auction!, abi, functionName: "revealBond" }),
        read<boolean>({ address: auction!, abi, functionName: "hasCommitted", args: [now!.epoch, address] }),
      ]);
      return { bond, committed };
    },
    !!auction && !!address && !!now,
  ).data;

  const amountWei = parseAmount(amount);
  const limitWei = parseAmount(limit);
  const lots = amountWei ? amountWei / LOT : 0n;
  const ticks = limitWei ? limitWei / TICK : 0n;
  const open = now?.phase === "Commit";
  const canSeal =
    !!address && !!auction && open && lots > 0n && ticks > 0n && !!info && !info.committed && !busy;

  const seal = async () => {
    setError(null);
    try {
      const epoch = now!.epoch;
      const order: ZkOrder = { isBuy, limitTicks: ticks, amountLots: lots, salt: randomFieldSalt() };
      const commitment = zkCommitment(address!, epoch, order);
      setBusy("Committing the sealed order…");
      const receipt = await send({
        address: auction!,
        abi,
        functionName: "commit",
        args: [epoch, commitment],
        value: info!.bond,
        gas: COMMIT_GAS,
      });
      const [event] = parseEventLogs({
        abi: ObscuraAuctionZKAbi,
        eventName: "Committed",
        logs: receipt.logs,
      });
      const ticket: Ticket = {
        kind: "zk",
        epoch: epoch.toString(),
        index: (event?.args.slot ?? 0n).toString(),
        isBuy,
        limit: ticks.toString(),
        amount: lots.toString(),
        salt: order.salt.toString(),
        commitment: commitment.toString(),
        txHash: receipt.transactionHash,
        sent: false,
      };
      onSealed(ticket);
      setSealed({ commitment: commitment.toString(), epoch: epoch.toString(), sent: false });

      setBusy("Sending the order to the solver, encrypted…");
      await sendToSolver(ZK_INBOX_URL, epoch, address!, order);
      onSent(receipt.transactionHash);
      setSealed({ commitment: commitment.toString(), epoch: epoch.toString(), sent: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-labelledby="zk-seal-title">
      <h2 id="zk-seal-title">Place a private order</h2>
      <div className="row">
        <div className="field" style={{ flex: "0 0 auto" }}>
          <span className="label">Side</span>
          <div className="seg" role="group" aria-label="Side">
            <button aria-pressed={isBuy} onClick={() => setIsBuy(true)}>
              Buy TKN
            </button>
            <button aria-pressed={!isBuy} onClick={() => setIsBuy(false)}>
              Sell TKN
            </button>
          </div>
        </div>
        <label className="field">
          <span className="label">Amount (TKN, to 0.001)</span>
          <input
            id="zk-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">
            {isBuy ? "Pay at most (mUSD, to 0.01)" : "Receive at least (mUSD, to 0.01)"}
          </span>
          <input id="zk-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
      </div>
      <p className="small muted" style={{ marginTop: "0.6rem" }}>
        Bond {info ? `${formatEther(info.bond)} ETH` : "…"}. Committing locks your whole free balance on this
        auction until the batch settles, so the lock says nothing about your order. One order per account per
        batch. The order itself goes only to the solver, encrypted to its key, and is never published.
      </p>
      <div className="row" style={{ marginTop: "0.6rem" }}>
        <button className="btn" disabled={!canSeal} onClick={seal}>
          {busy ? "Working…" : "Seal, commit & send privately"}
        </button>
        {!open && now && (
          <span className="small muted">Sealing opens with the next batch&apos;s commit window.</span>
        )}
        {info?.committed && <span className="small muted">You already have an order in this batch.</span>}
      </div>
      {busy && <p className="small muted">{busy}</p>}
      {error && <p className="note bad">{error}</p>}
      {sealed && (
        <div className="note good" style={{ marginTop: "0.75rem" }}>
          <strong>Sealed into ZK batch {sealed.epoch}.</strong> What everyone sees, bots included:
          <div className="hash">
            commit({sealed.epoch}, {sealed.commitment})
          </div>
          <span className="small">
            {sealed.sent
              ? "Your order reached the solver, encrypted. It will never appear on-chain, not even after settlement."
              : "Not yet sent to the solver."}
          </span>
        </div>
      )}
    </section>
  );
}

function ZkTicketRow({
  ticket,
  auction,
  trader,
  now,
  onSent,
}: {
  ticket: Ticket;
  auction: Address;
  trader: Address;
  now: BatchNow | undefined;
  onSent: () => void;
}) {
  const epoch = BigInt(ticket.epoch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = usePoll(["zk-ticket", auction, ticket.txHash], async () => {
    const [phase, fills, result, best] = await Promise.all([
      read<number>({ address: auction, abi, functionName: "phaseOf", args: [epoch] }),
      read<Fill[]>({ address: auction, abi, functionName: "getFills", args: [epoch] }),
      read<readonly [bigint, bigint]>({ address: auction, abi, functionName: "results", args: [epoch] }),
      read<{ solver: Address; includedMask: bigint }>({
        address: auction,
        abi,
        functionName: "getBest",
        args: [epoch],
      }),
    ]);
    const mine = fills.filter((f) => f.trader.toLowerCase() === trader.toLowerCase());
    return {
      phase: CONTRACT_PHASES[phase]!,
      proven: best.solver !== "0x0000000000000000000000000000000000000000",
      included: ((best.includedMask >> BigInt(ticket.index)) & 1n) === 1n,
      filled: mine.reduce((s, f) => s + f.baseAmount, 0n),
      price: result[0],
    };
  }).data;

  // The solver reads the orders it holds when the solve window opens, so a late send still helps until then.
  const canSend = !ticket.sent && now?.epoch === epoch && (now.phase === "Commit" || now.phase === "Reveal");
  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendToSolver(ZK_INBOX_URL, epoch, trader, {
        isBuy: ticket.isBuy,
        limitTicks: BigInt(ticket.limit),
        amountLots: BigInt(ticket.amount),
        salt: BigInt(ticket.salt),
      });
      onSent();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  let status: ReactNode = <span className="chip">Reading…</span>;
  if (state) {
    if (state.phase === "Settled") {
      status = !state.included ? (
        <span className="chip bad">Left out of the batch · bond forfeited</span>
      ) : state.filled > 0n ? (
        <span className="chip good">
          {ticket.isBuy ? "Bought" : "Sold"} {fmt(state.filled, 3)} TKN at {fmt(state.price)}
        </span>
      ) : (
        <span className="chip">Settled at {fmt(state.price)} · your limit did not cross</span>
      );
    } else if (state.phase === "Voided") {
      status = <span className="chip warn">No proof submitted · funds and bond returned</span>;
    } else if (state.proven) {
      status = <span className="chip accent">Proof accepted · settling</span>;
    } else if (!ticket.sent) {
      status = <span className="chip warn">Sealed, not yet sent to the solver</span>;
    } else {
      status = <span className="chip accent">Sealed and sent · waiting for the proof</span>;
    }
  }

  return (
    <tr>
      <td className="num">{ticket.epoch}</td>
      <td className="num">
        {ticket.isBuy ? "Buy" : "Sell"} {fmt(BigInt(ticket.amount) * LOT, 3)} TKN @{" "}
        {fmt(BigInt(ticket.limit) * TICK)}
      </td>
      <td>
        {status}
        {error && (
          <div className="small" style={{ color: "var(--bad)" }}>
            {error}
          </div>
        )}
      </td>
      <td>
        {canSend && (
          <button className="btn small" disabled={busy} onClick={resend}>
            {busy ? "Sending…" : "Send to solver"}
          </button>
        )}
      </td>
    </tr>
  );
}
