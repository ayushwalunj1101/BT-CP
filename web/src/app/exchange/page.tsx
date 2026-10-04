"use client";

import { MockERC20Abi, SimpleAMMAbi } from "@obscura/shared/abis";
import { useState } from "react";
import { type Abi, type Address, maxUint256, parseEventLogs } from "viem";
import { useConnection } from "wagmi";
import { getBlock } from "wagmi/actions";
import { useDeployment } from "@/lib/deployment";
import { errorText, fmt, parseAmount, short } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { read, send } from "@/lib/tx";
import { config } from "@/lib/wagmi";

const ammAbi = SimpleAMMAbi as Abi;
const erc20 = MockERC20Abi as Abi;
/** On the local chain the demo's sandwich bot is Anvil account #2. */
const LOCAL_BOT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

type Outcome = {
  quote: bigint;
  received: bigint;
  outSymbol: string;
  block: bigint;
  order: { hash: string; who: "you" | "bot" | "other" }[];
};

export default function ExchangePage() {
  const { address } = useConnection();
  const { deployment } = useDeployment();
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState("50000");
  const [slippage, setSlippage] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const amm = deployment?.amm;
  const tokenIn = deployment ? (isBuy ? deployment.musd : deployment.tkn) : undefined;
  const amountIn = parseAmount(amount);
  const slippageBps = BigInt(Math.round(Number(slippage) * 100));

  const quote = usePoll(
    ["quote", amm, tokenIn, amountIn?.toString()],
    () =>
      read<bigint>({ address: amm!, abi: ammAbi, functionName: "getAmountOut", args: [tokenIn, amountIn] }),
    !!amm && !!tokenIn && !!amountIn,
    2_000,
  ).data;

  const swap = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const allowance = await read<bigint>({
        address: tokenIn!,
        abi: erc20,
        functionName: "allowance",
        args: [address, amm],
      });
      if (allowance < amountIn!) {
        await send({ address: tokenIn!, abi: erc20, functionName: "approve", args: [amm, maxUint256] });
      }
      const fresh = await read<bigint>({
        address: amm!,
        abi: ammAbi,
        functionName: "getAmountOut",
        args: [tokenIn, amountIn],
      });
      const minOut = (fresh * (10_000n - slippageBps)) / 10_000n;
      const receipt = await send({
        address: amm!,
        abi: ammAbi,
        functionName: "swapExactIn",
        args: [tokenIn, amountIn, minOut, address],
      });
      const [event] = parseEventLogs({ abi: SimpleAMMAbi, eventName: "Swap", logs: receipt.logs });
      const block = await getBlock(config, { blockNumber: receipt.blockNumber, includeTransactions: true });
      setOutcome({
        quote: fresh,
        received: event?.args.amountOut ?? 0n,
        outSymbol: isBuy ? "TKN" : "mUSD",
        block: receipt.blockNumber,
        order: block.transactions
          .filter((tx) => tx.to?.toLowerCase() === amm!.toLowerCase())
          .map((tx) => ({
            hash: tx.hash,
            who:
              tx.hash === receipt.transactionHash
                ? "you"
                : (tx.from as Address).toLowerCase() === LOCAL_BOT.toLowerCase()
                  ? "bot"
                  : "other",
          })),
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const lossBps = outcome
    ? Number(((outcome.quote - outcome.received) * 1_000_000n) / outcome.quote) / 100
    : 0;

  return (
    <>
      <div className="page-head">
        <h1>The normal exchange</h1>
        <p>
          A standard constant-product pool, where trades execute one at a time. Swap here while the sandwich
          bot is running and see what happens to your price. This is the problem Obscura removes.
        </p>
      </div>
      <div className="layout">
        <section className="card" aria-labelledby="swap-title">
          <h2 id="swap-title">Swap</h2>
          <div className="seg" role="group" aria-label="Side">
            <button aria-pressed={isBuy} onClick={() => setIsBuy(true)}>
              Buy TKN
            </button>
            <button aria-pressed={!isBuy} onClick={() => setIsBuy(false)}>
              Sell TKN
            </button>
          </div>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <label className="field">
              <span className="label">{isBuy ? "Pay (mUSD)" : "Sell (TKN)"}</span>
              <input
                id="swap-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="field" style={{ flex: "0 0 7rem" }}>
              <span className="label">Slippage %</span>
              <input
                id="swap-slippage"
                inputMode="decimal"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
              />
            </label>
          </div>
          <p className="small muted" style={{ marginTop: "0.5rem" }}>
            Quote: {quote === undefined ? "…" : `${fmt(quote)} ${isBuy ? "TKN" : "mUSD"}`}. You accept down to{" "}
            {slippage}% less.
          </p>
          <button
            className="btn"
            style={{ marginTop: "0.5rem" }}
            disabled={!address || !amountIn || busy}
            onClick={swap}
          >
            {busy ? "Swapping…" : "Swap"}
          </button>
          {error && <p className="note bad">{error}</p>}
        </section>
        <section className="card" aria-labelledby="what-title">
          <h2 id="what-title">What happened</h2>
          {!outcome ? (
            <p className="muted">Make a swap to see the block it landed in.</p>
          ) : (
            <>
              <p>Block {outcome.block.toString()}, trades on this pool in order:</p>
              <ol className="mono small">
                {outcome.order.map((tx) => (
                  <li key={tx.hash}>
                    <span className={`chip ${tx.who === "bot" ? "bad" : tx.who === "you" ? "accent" : ""}`}>
                      {tx.who === "you" ? "YOU" : tx.who === "bot" ? "BOT" : "other"}
                    </span>{" "}
                    {short(tx.hash)}
                  </li>
                ))}
              </ol>
              <p className={`note ${lossBps > 0 ? "bad" : "good"}`}>
                You received {fmt(outcome.received)} {outcome.outSymbol} against a quote of{" "}
                {fmt(outcome.quote)}: {lossBps.toFixed(2)} bps worse.
                {lossBps > 0 &&
                  " The bot bought just before you and sold just after, keeping the difference."}
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
