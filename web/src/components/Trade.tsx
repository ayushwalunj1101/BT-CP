"use client";

import { ObscuraAuctionAbi } from "@obscura/shared/abis";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Abi, type Address, formatEther, parseEventLogs } from "viem";
import { useConnection } from "wagmi";
import { CONTRACT_PHASES, phaseStart } from "@/lib/clock";
import { useDeployment } from "@/lib/deployment";
import { errorText, fmt, parseAmount, short } from "@/lib/format";
import { type BatchNow, useBatchNow, useFreeBalance, usePoll } from "@/lib/hooks";
import { commitmentHash, randomSalt } from "@/lib/orders";
import { type Ticket, downloadTicket, useTickets } from "@/lib/tickets";
import { read, send } from "@/lib/tx";

const abi = ObscuraAuctionAbi as Abi;
const COMMIT_GAS = 150_000n;
const REVEAL_GAS = 300_000n;

type Fill = { trader: Address; isBuy: boolean; baseAmount: bigint; quoteAmount: bigint };

export function Trade() {
  const { address } = useConnection();
  const { chainId, deployment } = useDeployment();
  const auction = deployment?.auction;
  const now = useBatchNow(auction);
  const scope = address && auction ? `${chainId}:${auction}:${address}` : null;
  const { tickets, add, update, remove } = useTickets(scope);
  const [autoReveal, setAutoReveal] = useState(true);

  return (
    <div className="stack">
      <SealOrder auction={auction} now={now} onSealed={add} />
      <section className="card" aria-labelledby="orders-title">
        <div className="clock-head">
          <h2 id="orders-title">Your orders</h2>
          <label className="small">
            <input
              id="auto-reveal"
              type="checkbox"
              checked={autoReveal}
              onChange={(e) => setAutoReveal(e.target.checked)}
              style={{ width: "auto", marginRight: "0.4rem" }}
            />
            Reveal automatically while this tab is open
          </label>
        </div>
        {tickets.length === 0 ? (
          <p className="muted">
            No sealed orders from this account yet. Seal one above during a commit window.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <TicketRow
                    key={t.txHash}
                    ticket={t}
                    auction={auction!}
                    trader={address!}
                    now={now}
                    autoReveal={autoReveal}
                    onForget={() => remove(t.txHash)}
                    extra={{ chainId: String(chainId), auction: auction!, trader: address! }}
                    onUpdate={(patch) => update(t.txHash, patch)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ImportTicket onImport={add} />
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ sealing

function SealOrder({
  auction,
  now,
  onSealed,
}: {
  auction: Address | undefined;
  now: BatchNow | undefined;
  onSealed: (t: Ticket) => void;
}) {
  const { address } = useConnection();
  const { deployment } = useDeployment();
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState("10");
  const [limit, setLimit] = useState("101");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<{ commitment: string; txHash: string; epoch: string } | null>(null);
  const bond = usePoll(
    ["revealBond", auction],
    () => read<bigint>({ address: auction!, abi, functionName: "revealBond" }),
    !!auction,
    60_000,
  ).data;

  const amountWei = parseAmount(amount);
  const limitWei = parseAmount(limit);
  const open = now?.phase === "Commit";
  // What the reveal will lock, exactly as the contract computes it (a buy rounds up).
  const needed =
    amountWei && limitWei
      ? isBuy
        ? (amountWei * limitWei + 10n ** 18n - 1n) / 10n ** 18n
        : amountWei
      : undefined;
  const symbol = isBuy ? "mUSD" : "TKN";
  const free = useFreeBalance(auction, isBuy ? deployment?.musd : deployment?.tkn);
  const short = needed !== undefined && free !== undefined && free < needed;
  const canSeal =
    !!address && !!auction && open && !!amountWei && !!limitWei && bond !== undefined && !short && !busy;
  const lockText = needed !== undefined ? `${fmt(needed)} ${symbol}` : "…";

  const seal = async () => {
    setBusy(true);
    setError(null);
    try {
      const epoch = now!.epoch;
      const salt = randomSalt();
      const commitment = commitmentHash(address!, epoch, isBuy, limitWei!, amountWei!, salt);
      const receipt = await send({
        address: auction!,
        abi,
        functionName: "commit",
        args: [epoch, commitment],
        value: bond,
        gas: COMMIT_GAS,
      });
      const [event] = parseEventLogs({ abi: ObscuraAuctionAbi, eventName: "Committed", logs: receipt.logs });
      onSealed({
        epoch: epoch.toString(),
        index: (event?.args.index ?? 0n).toString(),
        isBuy,
        limit: limitWei!.toString(),
        amount: amountWei!.toString(),
        salt,
        commitment,
        txHash: receipt.transactionHash,
      });
      setSealed({ commitment, txHash: receipt.transactionHash, epoch: epoch.toString() });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="seal-title">
      <h2 id="seal-title">Place a sealed order</h2>
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
          <span className="label">Amount (TKN)</span>
          <input
            id="seal-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">
            {isBuy ? "Pay at most (mUSD per TKN)" : "Receive at least (mUSD per TKN)"}
          </span>
          <input
            id="seal-limit"
            inputMode="decimal"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      </div>
      <p className="small muted" style={{ marginTop: "0.6rem" }}>
        Bond {bond === undefined ? "…" : `${formatEther(bond)} ETH`}, returned when you reveal. At reveal,{" "}
        {lockText} of your free balance locks until the batch settles. Everyone in the batch trades at one
        price, never worse than your limit.
      </p>
      <div className="row" style={{ marginTop: "0.6rem" }}>
        <button className="btn" disabled={!canSeal} onClick={seal}>
          {busy ? "Sealing…" : "Seal & commit"}
        </button>
        {!open && now && (
          <span className="small muted">Sealing opens with the next batch&apos;s commit window.</span>
        )}
      </div>
      {short && (
        <p className="note bad">
          Deposit first: this order needs {lockText} free in Obscura, and you have {fmt(free!)}. Its reveal
          locks that amount, so without it the order could not be revealed and its bond would be lost.
        </p>
      )}
      {error && <p className="note bad">{error}</p>}
      {sealed && (
        <div className="note good" style={{ marginTop: "0.75rem" }}>
          <strong>Sealed into batch {sealed.epoch}.</strong> What everyone sees, bots included:
          <div className="hash">
            commit({sealed.epoch}, {sealed.commitment})
          </div>
          <span className="small">Your order and its secret salt stay in this browser until you reveal.</span>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ one order's life

function TicketRow({
  ticket,
  auction,
  trader,
  now,
  autoReveal,
  extra,
  onForget,
}: {
  ticket: Ticket;
  auction: Address;
  trader: Address;
  now: BatchNow | undefined;
  autoReveal: boolean;
  extra: Record<string, string>;
  onForget: () => void;
  onUpdate: (patch: Partial<Ticket>) => void;
}) {
  const epoch = BigInt(ticket.epoch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  const state = usePoll(["ticket", auction, ticket.txHash], async () => {
    const [phase, commitments, fills, result] = await Promise.all([
      read<number>({ address: auction, abi, functionName: "phaseOf", args: [epoch] }),
      read<{ revealed: boolean }[]>({ address: auction, abi, functionName: "getCommitments", args: [epoch] }),
      read<Fill[]>({ address: auction, abi, functionName: "getFills", args: [epoch] }),
      read<readonly [bigint, bigint]>({ address: auction, abi, functionName: "results", args: [epoch] }),
    ]);
    const mine = fills.filter(
      (f) => f.trader.toLowerCase() === trader.toLowerCase() && f.isBuy === ticket.isBuy,
    );
    return {
      phase: CONTRACT_PHASES[phase]!,
      revealed: commitments[Number(ticket.index)]?.revealed ?? false,
      filled: mine.reduce((s, f) => s + f.baseAmount, 0n),
      paid: mine.reduce((s, f) => s + f.quoteAmount, 0n),
      price: result[0],
    };
  }).data;

  const canReveal = !!state && !state.revealed && now?.epoch === epoch && now.phase === "Reveal";

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      await send({
        address: auction,
        abi,
        functionName: "reveal",
        args: [
          epoch,
          BigInt(ticket.index),
          ticket.isBuy,
          BigInt(ticket.limit),
          BigInt(ticket.amount),
          ticket.salt,
        ],
        gas: REVEAL_GAS,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoReveal && canReveal && !busy && !tried.current) {
      tried.current = true;
      void reveal();
    }
  });

  const side = ticket.isBuy ? "Buy" : "Sell";
  let status: ReactNode = <span className="chip">Reading…</span>;
  if (state) {
    if (state.phase === "Commit") {
      const opens = now ? phaseStart(now.clock, epoch, "Reveal") - now.next : 0n;
      status = <span className="chip accent">Sealed · reveal opens in {opens.toString()} blocks</span>;
    } else if (!state.revealed && state.phase === "Reveal") {
      status = <span className="chip warn">Reveal now</span>;
    } else if (!state.revealed) {
      status = <span className="chip bad">Not revealed in time · bond forfeited</span>;
    } else if (state.phase === "Settled") {
      status =
        state.filled > 0n ? (
          <span className="chip good">
            {ticket.isBuy ? "Bought" : "Sold"} {fmt(state.filled)} TKN at {fmt(state.price)}
          </span>
        ) : (
          <span className="chip">Settled at {fmt(state.price)} · your limit did not cross</span>
        );
    } else if (state.phase === "Voided") {
      status = <span className="chip warn">Batch voided · funds returned</span>;
    } else {
      status = <span className="chip accent">Revealed · waiting for settlement</span>;
    }
  }

  return (
    <tr>
      <td className="num">{ticket.epoch}</td>
      <td className="num">
        {side} {fmt(BigInt(ticket.amount))} TKN @ {fmt(BigInt(ticket.limit))}
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
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {canReveal && (
            <button className="btn small" disabled={busy} onClick={reveal}>
              {busy ? "Revealing…" : "Reveal"}
            </button>
          )}
          <button
            className="btn ghost small"
            onClick={() => downloadTicket(ticket, extra)}
            title={short(ticket.salt)}
          >
            Ticket
          </button>
          {state && (state.phase === "Settled" || state.phase === "Voided") && (
            <button className="btn ghost small" onClick={onForget}>
              Forget
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ImportTicket({ onImport }: { onImport: (t: Ticket) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginTop: "0.75rem" }}>
      <label className="small muted">
        Restore a downloaded ticket:{" "}
        <input
          id="import-ticket"
          type="file"
          accept="application/json"
          style={{ width: "auto", border: 0, padding: 0 }}
          onChange={async (e) => {
            setError(null);
            try {
              const t = JSON.parse(await e.target.files![0]!.text()) as Ticket;
              if (!t.salt || !t.commitment || !t.txHash)
                throw new Error("That file is not an Obscura ticket.");
              onImport(t);
            } catch (err) {
              setError(errorText(err));
            }
          }}
        />
      </label>
      {error && <span className="chip bad">{error}</span>}
    </div>
  );
}
