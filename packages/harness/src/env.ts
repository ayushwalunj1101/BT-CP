import { rmSync } from "node:fs";
import { Contract, type JsonRpcProvider } from "ethers";
import { SandwichBot } from "@obscura/bot";
import {
  ANVIL_CHAIN_ID,
  type AnvilHandle,
  type Deployment,
  MockERC20Abi,
  type Mining,
  ROLE,
  SimpleAMMAbi,
  anvilWallet,
  deployLocal,
  setMining,
  startAnvil,
} from "@obscura/shared";

/** A running Stage 1 world: a fresh chain, the deployed contracts, and the bot watching the mempool. */
export type Stage1Env = {
  anvil: AnvilHandle;
  provider: JsonRpcProvider;
  deployment: Deployment;
  amm: Contract;
  tkn: Contract;
  musd: Contract;
  bot: SandwichBot;
  symbols: Record<string, string>;
  stop(): Promise<void>;
};

export type Stage1Options = {
  port: number;
  mining: Mining;
  deploymentFile: string;
  /** Delete the deployment file on stop (tests and the harness use throwaway files). */
  removeDeploymentOnStop?: boolean;
  botLog?: (line: string) => void;
};

export async function startStage1(options: Stage1Options): Promise<Stage1Env> {
  const anvil = await startAnvil(options.port);
  try {
    const deployment = await deployLocal(anvil.httpUrl, options.deploymentFile);
    await setMining(anvil.provider, options.mining);

    const provider = anvil.provider;
    const symbols = { [deployment.tkn.toLowerCase()]: "TKN", [deployment.musd.toLowerCase()]: "mUSD" };
    const bot = new SandwichBot({
      provider,
      wsUrl: anvil.wsUrl,
      chainId: ANVIL_CHAIN_ID,
      wallet: anvilWallet(ROLE.bot, provider),
      amm: deployment.amm,
      symbols,
      log: options.botLog,
    });
    await bot.start();

    return {
      anvil,
      provider,
      deployment,
      amm: new Contract(deployment.amm, SimpleAMMAbi, provider),
      tkn: new Contract(deployment.tkn, MockERC20Abi, provider),
      musd: new Contract(deployment.musd, MockERC20Abi, provider),
      bot,
      symbols,
      async stop() {
        await bot.stop();
        await anvil.stop();
        if (options.removeDeploymentOnStop) rmSync(options.deploymentFile, { force: true });
      },
    };
  } catch (err) {
    await anvil.stop();
    throw err;
  }
}
