"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useChainId } from "wagmi";

export type Deployment = {
  chainId: number;
  tkn: Address;
  musd: Address;
  amm: Address;
  auction: Address;
  bounty: Address;
};

/** Contract addresses for the connected chain, from deployments/<chainId>.json (null if not deployed). */
export function useDeployment() {
  const chainId = useChainId();
  const query = useQuery({
    queryKey: ["deployment", chainId],
    queryFn: async (): Promise<Deployment | null> => {
      const res = await fetch(`/api/deployments/${chainId}`, { cache: "no-store" });
      return res.ok ? ((await res.json()) as Deployment) : null;
    },
    refetchInterval: 15_000,
  });
  return { chainId, deployment: query.data ?? null, loading: query.isLoading };
}
