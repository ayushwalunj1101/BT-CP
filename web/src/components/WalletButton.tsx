"use client";

import { useEffect, useState } from "react";
import { useChainId, useConnection } from "wagmi";
import { connect, disconnect, switchChain } from "wagmi/actions";
import { anvil, sepolia } from "wagmi/chains";
import { errorText, short } from "@/lib/format";
import { useLocalChainUp } from "@/lib/hooks";
import { CHAINS, chainName, config, rememberLocalWallet } from "@/lib/wagmi";

export function WalletButton() {
  const { address, chainId, connector, status } = useConnection();
  const viewChainId = useChainId();
  const localUp = useLocalChainUp();
  const [error, setError] = useState<string | null>(null);
  const supported = CHAINS.some((c) => c.id === chainId);

  // Without the local chain running, show Sepolia to visitors and drop a remembered local test account.
  useEffect(() => {
    if (localUp !== false) return;
    if (status === "disconnected" && viewChainId === anvil.id) {
      switchChain(config, { chainId: sepolia.id }).catch(() => {});
    }
    if (status === "connected" && connector?.type === "mock") {
      rememberLocalWallet(false);
      disconnect(config).catch(() => {});
    }
  }, [localUp, status, viewChainId, connector]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (status === "connected" && address) {
    const offerSepolia =
      connector?.type !== "mock" && chainId !== sepolia.id && (chainId !== anvil.id || localUp === false);
    return (
      <div className="wallet">
        {supported && <span className="chip accent">{chainName(chainId!)}</span>}
        {offerSepolia && (
          <button
            className="btn small"
            onClick={() => run(() => switchChain(config, { chainId: sepolia.id }))}
          >
            Switch to Sepolia
          </button>
        )}
        {!supported && localUp && (
          <button
            className="btn ghost small"
            onClick={() => run(() => switchChain(config, { chainId: anvil.id }))}
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

  // The local test account is Anvil's account #0, so it is only offered while the local chain is running.
  const connectors = config.connectors.filter((c) => c.type !== "mock" || localUp);
  return (
    <div className="wallet">
      {connectors.map((c) => (
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
