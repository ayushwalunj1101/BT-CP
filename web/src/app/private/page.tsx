"use client";

import { EpochBar } from "@/components/EpochBar";
import { FundsPanel } from "@/components/FundsPanel";
import { TradeZk } from "@/components/TradeZk";
import { useDeployment } from "@/lib/deployment";

export default function PrivatePage() {
  const { deployment } = useDeployment();
  return (
    <>
      <div className="page-head">
        <h1>Trade without ever revealing your order</h1>
        <p>
          On this auction your order is never published, not even after it trades. Only a Poseidon hash goes
          on-chain; the order travels to the solver encrypted, and the solver proves with zero knowledge that
          it cleared the batch correctly. The chain checks the proof and settles everyone at one price.
        </p>
      </div>
      <div className="layout">
        <FundsPanel auction={deployment?.zkAuction} title="Your funds on the ZK auction" />
        <div className="stack">
          <EpochBar auction={deployment?.zkAuction} zk />
          <TradeZk />
        </div>
      </div>
    </>
  );
}
