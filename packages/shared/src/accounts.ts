import { HDNodeWallet, Mnemonic, Wallet, type Provider } from "ethers";

/** Anvil's public development mnemonic. Its accounts only ever hold test ETH on a local chain. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Which account plays which part. Accounts 4 to 9 are simulated traders on the v1 auction, 11 to 16 on the
 * ZK auction. Accounts above 9 are derived from the same mnemonic; the deploy script gives them ETH.
 */
export const ROLE = { deployer: 0, victim: 1, bot: 2, solver: 3, zkSolver: 10 } as const;

const keyCache = new Map<number, string>();

export function anvilPrivateKey(index: number): string {
  let key = keyCache.get(index);
  if (!key) {
    key = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(ANVIL_MNEMONIC),
      `m/44'/60'/0'/0/${index}`,
    ).privateKey;
    keyCache.set(index, key);
  }
  return key;
}

export function anvilWallet(index: number, provider?: Provider): Wallet {
  return new Wallet(anvilPrivateKey(index), provider);
}
