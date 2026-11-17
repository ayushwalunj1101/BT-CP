import { createConfig, http } from "wagmi";
import { anvil, sepolia } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";

export const LOCAL_RPC_URL = process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
export const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
/** Offer Anvil's account #0 as a one-click test wallet (local chain only). Set to "0" to hide it. */
export const LOCAL_ACCOUNTS_ENABLED = process.env.NEXT_PUBLIC_LOCAL_ACCOUNTS !== "0";
/** Anvil's public development account #0. Anvil signs for it, so no key is ever handled here. */
export const LOCAL_TEST_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export const CHAINS = [anvil, sepolia] as const;

// wagmi's test connector forgets on every page load that it was connected, so remember the choice here.
const LOCAL_WALLET_FLAG = "obscura:local-wallet";

function rememberedLocalWallet(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(LOCAL_WALLET_FLAG) === "1";
  } catch {
    return false;
  }
}

export function rememberLocalWallet(on: boolean): void {
  try {
    if (on) localStorage.setItem(LOCAL_WALLET_FLAG, "1");
    else localStorage.removeItem(LOCAL_WALLET_FLAG);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

export const config = createConfig({
  chains: CHAINS,
  connectors: [
    injected(),
    ...(LOCAL_ACCOUNTS_ENABLED
      ? [
          mock({
            accounts: [LOCAL_TEST_ACCOUNT],
            features: { reconnect: true, defaultConnected: rememberedLocalWallet() },
          }),
        ]
      : []),
  ],
  transports: {
    [anvil.id]: http(LOCAL_RPC_URL),
    [sepolia.id]: http(SEPOLIA_RPC_URL),
  },
  ssr: true,
});

/** Rough seconds per block, for countdowns. */
export function blockSeconds(chainId: number): number {
  return chainId === sepolia.id ? 12 : 2;
}

export function chainName(chainId: number): string {
  if (chainId === anvil.id) return "Local chain";
  if (chainId === sepolia.id) return "Sepolia";
  return `Chain ${chainId}`;
}

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
