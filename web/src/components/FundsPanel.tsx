"use client";

import { MockERC20Abi, ObscuraAuctionAbi } from "@obscura/shared/abis";
import { useState } from "react";
import { type Abi, type Address, formatEther, maxUint256, parseUnits } from "viem";
import { useConnection } from "wagmi";
import { getBalance } from "wagmi/actions";
import { useDeployment } from "@/lib/deployment";
import { errorText, fmt, parseAmount } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { read, send } from "@/lib/tx";
import { config } from "@/lib/wagmi";

const erc20 = MockERC20Abi as Abi;
const ledger = ObscuraAuctionAbi as Abi; // the deposit ledger (ObscuraBase)

type Balances = {
  eth: bigint;
  wallet: { tkn: bigint; musd: bigint };
  free: { tkn: bigint; musd: bigint };
  locked: { tkn: bigint; musd: bigint };
};

/** Wallet and auction balances, deposits, withdrawals, and free test tokens. */
export function FundsPanel({ auction, title }: { auction: Address | undefined; title: string }) {
  const { address } = useConnection();
  const { deployment } = useDeployment();
  const [token, setToken] = useState<"tkn" | "musd">("musd");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = !!address && !!deployment && !!auction;
  const balances = usePoll<Balances>(
    ["funds", auction, address],
    async () => {
      const d = deployment!;
      const bal = (t: Address) =>
        read<bigint>({ address: t, abi: erc20, functionName: "balanceOf", args: [address] });
      const led = (fn: string, t: Address) =>
        read<bigint>({ address: auction!, abi: ledger, functionName: fn, args: [address, t] });
      const [eth, wt, wm, ft, fm, lt, lm] = await Promise.all([
        getBalance(config, { address: address! }).then((b) => b.value),
        bal(d.tkn),
        bal(d.musd),
        led("freeBalance", d.tkn),
        led("freeBalance", d.musd),
        led("lockedBalance", d.tkn),
        led("lockedBalance", d.musd),
      ]);
      return {
        eth,
        wallet: { tkn: wt, musd: wm },
        free: { tkn: ft, musd: fm },
        locked: { tkn: lt, musd: lm },
      };
    },
    ready,
  ).data;

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      setAmount("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const tokenAddress = deployment ? deployment[token] : undefined;
  const value = parseAmount(amount);

  const deposit = () =>
    run("Depositing…", async () => {
      const allowance = await read<bigint>({
        address: tokenAddress!,
        abi: erc20,
        functionName: "allowance",
        args: [address, auction],
      });
      if (allowance < value!) {
        setBusy("Approving…");
        await send({
          address: tokenAddress!,
          abi: erc20,
          functionName: "approve",
          args: [auction, maxUint256],
        });
        setBusy("Depositing…");
      }
      await send({ address: auction!, abi: ledger, functionName: "deposit", args: [tokenAddress, value] });
    });
  const withdraw = () =>
    run("Withdrawing…", () =>
      send({ address: auction!, abi: ledger, functionName: "withdraw", args: [tokenAddress, value] }),
    );
  const faucet = () =>
    run("Minting test tokens…", async () => {
      await send({
        address: deployment!.tkn,
        abi: erc20,
        functionName: "mint",
        args: [address, parseUnits("1000", 18)],
      });
      await send({
        address: deployment!.musd,
        abi: erc20,
        functionName: "mint",
        args: [address, parseUnits("100000", 18)],
      });
    });

  return (
    <section className="card" aria-labelledby="funds-title">
      <h2 id="funds-title">{title}</h2>
      {!address ? (
        <p className="muted">Connect a wallet to see your balances.</p>
      ) : !deployment ? (
        <p className="muted">Obscura is not deployed on this chain.</p>
      ) : (
        <>
          <dl className="kv">
            <dt>In your wallet</dt>
            <dd>
              {fmt(balances?.wallet.tkn)} TKN
              <br />
              {fmt(balances?.wallet.musd)} mUSD
            </dd>
            <dt>Free in Obscura</dt>
            <dd>
              {fmt(balances?.free.tkn)} TKN
              <br />
              {fmt(balances?.free.musd)} mUSD
            </dd>
            <dt>Locked in batches</dt>
            <dd>
              {fmt(balances?.locked.tkn)} TKN
              <br />
              {fmt(balances?.locked.musd)} mUSD
            </dd>
            <dt>ETH for bonds and gas</dt>
            <dd>{balances ? Number(formatEther(balances.eth)).toFixed(4) : "…"}</dd>
          </dl>
          <p className="small muted" style={{ marginTop: "0.75rem" }}>
            A deposit is not tied to any order, so it reveals nothing about what you will trade.
          </p>
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <label className="field" style={{ flex: "0 0 6.5rem" }}>
              <span className="label">Token</span>
              <select
                id="funds-token"
                value={token}
                onChange={(e) => setToken(e.target.value as "tkn" | "musd")}
              >
                <option value="musd">mUSD</option>
                <option value="tkn">TKN</option>
              </select>
            </label>
            <label className="field">
              <span className="label">Amount</span>
              <input
                id="funds-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          </div>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <button className="btn" disabled={!value || !!busy} onClick={deposit}>
              Deposit
            </button>
            <button className="btn ghost" disabled={!value || !!busy} onClick={withdraw}>
              Withdraw
            </button>
            <button
              className="btn ghost"
              disabled={!!busy}
              onClick={faucet}
              title="Mints 1,000 TKN and 100,000 mUSD"
            >
              Get test tokens
            </button>
          </div>
          {busy && <p className="small muted">{busy}</p>}
          {error && <p className="note bad">{error}</p>}
        </>
      )}
    </section>
  );
}
