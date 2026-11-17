import { rmSync } from "node:fs";
import { Contract, type JsonRpcProvider } from "ethers";
import { SandwichBot } from "@obscura/bot";
import { Solver } from "@obscura/solver";
import {
  ANVIL_CHAIN_ID,
  type AnvilHandle,
  type Deployment,
  InvariantBountyAbi,
  MockERC20Abi,
  type Mining,
  ObscuraAuctionAbi,
  ROLE,
  SimpleAMMAbi,
  anvilWallet,
  deployLocal,
  read,
  setMining,
  startAnvil,
} from "@obscura/shared";
import { SimulatedTraders } from "./traders.ts";
import { mulberry32 } from "./random.ts";

/**
 * A running local world: a fresh chain, both venues deployed, the bot watching, the solver, and the
 * simulated traders.
 */
export type LocalEnv = {
  anvil: AnvilHandle;
  provider: JsonRpcProvider;
  deployment: Deployment;
  amm: Contract;
  auction: Contract;
  bounty: Contract;
  tkn: Contract;
  musd: Contract;
  bot: SandwichBot;
  solver: Solver;
  traders: SimulatedTraders;
  symbols: Record<string, string>;
  /** The AMM's current price, mUSD per TKN with 18 decimals. Simulated traders quote around it. */
  marketPrice(): Promise<bigint>;
  stop(): Promise<void>;
};

export type LocalEnvOptions = {
  port: number;
  mining: Mining;
  deploymentFile: string;
  /** Delete the deployment file on stop (tests and the harness use throwaway files). */
  removeDeploymentOnStop?: boolean;
  /** Run the solver and the simulated traders as live loops that follow the clock (demo:up). */
  live?: boolean;
  botLog?: (line: string) => void;
  solverLog?: (line: string) => void;
  tradersLog?: (line: string) => void;
  seed?: number;
};

export async function startLocalEnv(options: LocalEnvOptions): Promise<LocalEnv> {
  const anvil = await startAnvil(options.port);
  try {
    const deployment = await deployLocal(anvil.httpUrl, options.deploymentFile);
    await setMining(anvil.provider, options.mining);

    const provider = anvil.provider;
    const amm = new Contract(deployment.amm, SimpleAMMAbi, provider);
    const symbols = { [deployment.tkn.toLowerCase()]: "TKN", [deployment.musd.toLowerCase()]: "mUSD" };
    const marketPrice = async () => {
      const [tkn, musd] = await Promise.all([read<bigint>(amm, "reserve0"), read<bigint>(amm, "reserve1")]);
      return (musd * 10n ** 18n) / tkn;
    };

    const bot = new SandwichBot({
      provider,
      wsUrl: anvil.wsUrl,
      chainId: ANVIL_CHAIN_ID,
      wallet: anvilWallet(ROLE.bot, provider),
      amm: deployment.amm,
      auction: deployment.auction,
      symbols,
      log: options.botLog,
    });
    await bot.start();
    const solver = new Solver({
      provider,
      wallet: anvilWallet(ROLE.solver, provider),
      auction: deployment.auction,
      log: options.solverLog ?? (() => {}),
    });

    const random = mulberry32(options.seed ?? 42);
    const traders = new SimulatedTraders({
      provider,
      auction: deployment.auction,
      referencePrice: marketPrice,
      random,
      log: options.tradersLog ?? (() => {}),
    });
    if (options.live) {
      solver.start();
      traders.start();
    }

    return {
      anvil,
      provider,
      deployment,
      amm,
      auction: new Contract(deployment.auction, ObscuraAuctionAbi, provider),
      bounty: new Contract(deployment.bounty, InvariantBountyAbi, provider),
      tkn: new Contract(deployment.tkn, MockERC20Abi, provider),
      musd: new Contract(deployment.musd, MockERC20Abi, provider),
      bot,
      solver,
      traders,
      symbols,
      marketPrice,
      async stop() {
        solver.stop();
        traders.stop();
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
