import { rmSync } from "node:fs";
import { Contract, type JsonRpcProvider } from "ethers";
import { SandwichBot } from "@obscura/bot";
import { Solver, ZkSolver } from "@obscura/solver";
import {
  ANVIL_CHAIN_ID,
  type AnvilHandle,
  type Deployment,
  InvariantBountyAbi,
  MockERC20Abi,
  type Mining,
  ObscuraAuctionAbi,
  ObscuraAuctionZKAbi,
  ROLE,
  SimpleAMMAbi,
  anvilWallet,
  deployLocal,
  read,
  setMining,
  startAnvil,
} from "@obscura/shared";
import { SimulatedTraders } from "./traders.ts";
import { ZkSimulatedTraders } from "./zkTraders.ts";
import { mulberry32 } from "./random.ts";

/** Port of the ZK solver's private order inbox in the live demo. */
export const DEMO_INBOX_PORT = 8650;

/**
 * A running local world: a fresh chain, every venue deployed, the bot watching, the solvers, and the
 * simulated traders (the v1 ones and the ZK ones).
 */
export type LocalEnv = {
  anvil: AnvilHandle;
  provider: JsonRpcProvider;
  deployment: Deployment;
  amm: Contract;
  auction: Contract;
  zkAuction: Contract;
  bounty: Contract;
  tkn: Contract;
  musd: Contract;
  bot: SandwichBot;
  solver: Solver;
  zkSolver: ZkSolver;
  /** The ZK solver's private order inbox. */
  zkInboxUrl: string;
  traders: SimulatedTraders;
  zkTraders: ZkSimulatedTraders;
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
  /** Run the solvers and the simulated traders as live loops that follow the clock (demo:up). */
  live?: boolean;
  /** Port for the ZK solver's inbox; 0 picks any free port. */
  zkInboxPort?: number;
  botLog?: (line: string) => void;
  solverLog?: (line: string) => void;
  zkSolverLog?: (line: string) => void;
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
      zkAuction: deployment.zkAuction,
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
    const zkSolver = new ZkSolver({
      provider,
      wallet: anvilWallet(ROLE.zkSolver, provider),
      auction: deployment.zkAuction,
      log: options.zkSolverLog ?? (() => {}),
    });
    const inboxPort = options.zkInboxPort ?? 0;
    const zkInboxUrl = options.live
      ? await zkSolver.start(inboxPort)
      : await zkSolver.inbox.listen(inboxPort);

    const random = mulberry32(options.seed ?? 42);
    const traders = new SimulatedTraders({
      provider,
      auction: deployment.auction,
      referencePrice: marketPrice,
      random,
      log: options.tradersLog ?? (() => {}),
    });
    const zkTraders = new ZkSimulatedTraders({
      provider,
      zkAuction: deployment.zkAuction,
      inboxUrl: zkInboxUrl,
      solverPublicKey: zkSolver.inbox.publicKey,
      referencePrice: marketPrice,
      random,
      log: options.tradersLog ?? (() => {}),
    });
    if (options.live) {
      solver.start();
      traders.start();
      zkTraders.start();
    }

    return {
      anvil,
      provider,
      deployment,
      amm,
      auction: new Contract(deployment.auction, ObscuraAuctionAbi, provider),
      zkAuction: new Contract(deployment.zkAuction, ObscuraAuctionZKAbi, provider),
      bounty: new Contract(deployment.bounty, InvariantBountyAbi, provider),
      tkn: new Contract(deployment.tkn, MockERC20Abi, provider),
      musd: new Contract(deployment.musd, MockERC20Abi, provider),
      bot,
      solver,
      zkSolver,
      zkInboxUrl,
      traders,
      zkTraders,
      symbols,
      marketPrice,
      async stop() {
        solver.stop();
        traders.stop();
        zkTraders.stop();
        await zkSolver.stop();
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
