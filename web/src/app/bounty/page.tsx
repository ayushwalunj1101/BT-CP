"use client";

import { InvariantBountyAbi, ObscuraAuctionAbi } from "@obscura/shared/abis";
import { useState } from "react";
import type { Abi, Address } from "viem";
import { useConnection } from "wagmi";
import { useDeployment } from "@/lib/deployment";
import { errorText, fmt } from "@/lib/format";
import { useBatchNow, useBlock, usePoll } from "@/lib/hooks";
import { randomSalt } from "@/lib/orders";
import { read, send } from "@/lib/tx";

const bountyAbi = InvariantBountyAbi as Abi;
const auctionAbi = ObscuraAuctionAbi as Abi;
const RECENT = 12;

const RULES = [
  { id: 1, name: "I1 Conservation", text: "The contract holds at least what it owes, in TKN, mUSD and ETH." },
  { id: 2, name: "I2 Uniform price", text: "Every fill in a batch used the batch's one clearing price." },
  {
    id: 3,
    name: "I3 Limit respect",
    text: "No buyer paid above their limit, no seller received below theirs.",
  },
  { id: 4, name: "I4 Solver honesty", text: "The solver gained no more than its declared reward." },
];

export default function BountyPage() {
  const { deployment } = useDeployment();
  const bounty = deployment?.bounty;
  const auction = deployment?.auction;
  const now = useBatchNow(auction);

  const board = usePoll(
    ["bounty", bounty, now?.epoch.toString()],
    async () => {
      const [vault, paid, delay, i1] = await Promise.all([
        read<bigint>({ address: bounty!, abi: bountyAbi, functionName: "vaultBalance" }),
        read<boolean>({ address: bounty!, abi: bountyAbi, functionName: "paid" }),
        read<bigint>({ address: bounty!, abi: bountyAbi, functionName: "claimDelay" }),
        read<boolean>({ address: auction!, abi: auctionAbi, functionName: "checkI1" }),
      ]);
      // I2 to I4 are per batch: check the most recent ones.
      const epochs = Array.from({ length: RECENT }, (_, i) => now!.epoch - BigInt(i + 1)).filter(
        (e) => e >= 0n,
      );
      const perBatch = await Promise.all(
        [2, 3, 4].map(async (id) => {
          const results = await Promise.all(
            epochs.map((e) =>
              read<boolean>({ address: auction!, abi: auctionAbi, functionName: `checkI${id}`, args: [e] }),
            ),
          );
          return results.every(Boolean);
        }),
      );
      return { vault, paid, delay, holds: [i1, ...perBatch] };
    },
    !!bounty && !!auction && !!now,
    3_000,
    true,
  ).data;

  return (
    <>
      <div className="page-head">
        <h1>Break a rule, take the vault</h1>
        <p>
          These four rules must always hold. The vault pays everything it holds to the first person who proves
          one broken. Nobody approves the payout and nobody can stop it: the contract checks the rule itself,
          in the same transaction.
        </p>
      </div>
      {!deployment ? (
        <p className="muted">Obscura is not deployed on this chain.</p>
      ) : (
        <div className="layout">
          <section className="card" aria-labelledby="vault-title">
            <h2 id="vault-title">The vault</h2>
            <div className="big">{board ? `${fmt(board.vault)}` : "…"}</div>
            <div className="muted">mUSD of test funds</div>
            <p style={{ marginTop: "0.75rem" }}>
              {board?.paid ? (
                <span className="chip bad">Already paid out</span>
              ) : (
                <span className="chip good">Unclaimed</span>
              )}
            </p>
            <p className="small muted">
              Contract <span className="hash">{bounty}</span>
            </p>
          </section>
          <div className="stack">
            <section className="card" aria-labelledby="rules-title">
              <h2 id="rules-title">The rules, checked live</h2>
              <div className="rules">
                {RULES.map((r, i) => {
                  const holds = board?.holds[i];
                  return (
                    <div className="rule" key={r.id}>
                      <div className="clock-head">
                        <strong>{r.name}</strong>
                        <span className={`chip ${holds === undefined ? "" : holds ? "good" : "bad"}`}>
                          {holds === undefined ? "checking" : holds ? "holding" : "BROKEN"}
                        </span>
                      </div>
                      <span className="small muted">{r.text}</span>
                    </div>
                  );
                })}
              </div>
              <p className="small muted" style={{ marginTop: "0.6rem" }}>
                I1 is checked over the whole contract; I2 to I4 over the last {RECENT} batches.
              </p>
            </section>
            <ClaimForm bounty={bounty!} delay={board?.delay} />
          </div>
        </div>
      )}
    </>
  );
}

/** The two-step claim: commit a sealed claim, wait, then claim. A copied claim is useless to anyone else. */
function ClaimForm({ bounty, delay }: { bounty: Address; delay: bigint | undefined }) {
  const { address } = useConnection();
  const block = useBlock();
  const [rule, setRule] = useState(1);
  const [epoch, setEpoch] = useState("0");
  const [salt, setSalt] = useState<`0x${string}` | null>(null);
  const [committedAt, setCommittedAt] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "good" | "bad" | "warn"; text: string } | null>(null);

  const readyAt = committedAt !== null && delay !== undefined ? committedAt + delay : null;
  const waiting = readyAt !== null && block !== undefined && block < readyAt;

  const commit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const s = randomSalt();
      const hash = await read<`0x${string}`>({
        address: bounty,
        abi: bountyAbi,
        functionName: "claimHash",
        args: [address, rule, BigInt(epoch || "0"), s],
      });
      const receipt = await send({
        address: bounty,
        abi: bountyAbi,
        functionName: "commitClaim",
        args: [hash],
      });
      setSalt(s);
      setCommittedAt(receipt.blockNumber);
      setMessage({
        kind: "warn",
        text: `Claim sealed. You can claim once ${delay ?? "a few"} more blocks have passed.`,
      });
    } catch (err) {
      setMessage({ kind: "bad", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await send({
        address: bounty,
        abi: bountyAbi,
        functionName: "claim",
        args: [rule, BigInt(epoch || "0"), salt],
      });
      setMessage({ kind: "good", text: "The rule was broken and the vault has paid you." });
    } catch (err) {
      const text = errorText(err);
      setMessage({
        kind: "bad",
        text: /NoViolation/.test(text)
          ? "The vault checked: that rule is not broken, so it keeps its funds."
          : text,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="claim-title">
      <h2 id="claim-title">Claim the bounty</h2>
      <p className="small muted">
        Step 1 seals your claim with your own address inside, so a bot copying it gets nothing. Step 2, a few
        blocks later, makes the vault check the rule and pay you if it is broken.
      </p>
      <div className="row" style={{ marginTop: "0.5rem" }}>
        <label className="field">
          <span className="label">Rule</span>
          <select
            id="claim-rule"
            value={rule}
            onChange={(e) => setRule(Number(e.target.value))}
            disabled={!!salt}
          >
            {RULES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Batch (for I2 to I4)</span>
          <input
            id="claim-epoch"
            inputMode="numeric"
            value={epoch}
            onChange={(e) => setEpoch(e.target.value)}
            disabled={!!salt}
          />
        </label>
      </div>
      <div className="row" style={{ marginTop: "0.6rem" }}>
        <button className="btn" disabled={!address || busy || !!salt} onClick={commit}>
          1. Seal claim
        </button>
        <button className="btn" disabled={!address || busy || !salt || waiting} onClick={claim}>
          2. Claim{" "}
          {waiting && readyAt !== null && block !== undefined
            ? `(in ${(readyAt - block).toString()} blocks)`
            : ""}
        </button>
        {salt && (
          <button
            className="btn ghost"
            onClick={() => {
              setSalt(null);
              setCommittedAt(null);
              setMessage(null);
            }}
          >
            Start over
          </button>
        )}
      </div>
      {message && (
        <p className={`note ${message.kind}`} style={{ marginTop: "0.6rem" }}>
          {message.text}
        </p>
      )}
    </section>
  );
}
