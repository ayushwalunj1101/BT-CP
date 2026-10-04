"use client";

import { useState } from "react";
import { useConnection } from "wagmi";
import { connect, disconnect, switchChain } from "wagmi/actions";
import { errorText, short } from "@/lib/format";
import { CHAINS, chainName, config, rememberLocalWallet } from "@/lib/wagmi";

export function WalletButton() {
  const { address, chainId, status } = useConnection();
  const [error, setError] = useState<string | null>(null);
  const supported = CHAINS.some((c) => c.id === chainId);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (status === "connected" && address) {
    return (
      <div className="wallet">
        {supported ? (
          <span className="chip accent">{chainName(chainId!)}</span>
        ) : (
          <button
            className="btn small"
            onClick={() => run(() => switchChain(config, { chainId: CHAINS[0].id }))}
          >
            Switch to the local chain
          </button>
        )}
        <span className="mono small" title={address}>
          {short(address)}
        </span>
        <button
          className="btn ghost small"
          onClick={() =>
            run(async () => {
              rememberLocalWallet(false);
              await disconnect(config);
            })
          }
        >
          Disconnect
        </button>
        {error && <span className="chip bad">{error}</span>}
      </div>
    );
  }

  return (
    <div className="wallet">
      {config.connectors.map((c) => (
        <button
          key={c.uid}
          className={c.type === "mock" ? "btn ghost small" : "btn small"}
          disabled={status === "connecting"}
          onClick={() =>
            run(async () => {
              await connect(config, { connector: c });
              rememberLocalWallet(c.type === "mock");
            })
          }
        >
          {c.type === "mock" ? "Local test account" : `Connect ${c.name === "Injected" ? "wallet" : c.name}`}
        </button>
      ))}
      {error && <span className="chip bad">{error}</span>}
    </div>
  );
}
