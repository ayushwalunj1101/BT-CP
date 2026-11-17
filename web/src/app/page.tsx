"use client";

import { EpochBar } from "@/components/EpochBar";
import { FundsPanel } from "@/components/FundsPanel";
import { Trade } from "@/components/Trade";
import { useDeployment } from "@/lib/deployment";

export default function TradePage() {
  const { deployment } = useDeployment();
  return (
    <>
      <div className="page-head">
        <h1>Trade without being front-run</h1>
        <p>
          Your order goes on-chain only as a sealed hash. When the commit window closes you reveal it, nobody
          can add orders any more, and everyone in the batch trades at one clearing price. Going first is
          worth nothing.
        </p>
      </div>
      <div className="layout">
        <FundsPanel auction={deployment?.auction} title="Your funds" />
        <div className="stack">
          <EpochBar auction={deployment?.auction} />
          <Trade />
        </div>
      </div>
    </>
  );
}
