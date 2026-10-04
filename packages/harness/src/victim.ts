import {
  Contract,
  Interface,
  type ContractTransactionResponse,
  type TransactionReceipt,
  type Wallet,
} from "ethers";
import { type Deployment, SimpleAMMAbi, minOutWithSlippage } from "@obscura/shared";

/** buy = pay mUSD for TKN; sell = pay TKN for mUSD. */
export type Side = "buy" | "sell";

export type VictimTrade = { side: Side; amountIn: bigint; slippageBps: bigint };

export type SentSwap = {
  tx: ContractTransactionResponse;
  tokenIn: string;
  tokenOut: string;
  /** What the victim would receive if nobody traded first. */
  quote: bigint;
  /** The least the victim accepts: quote minus their slippage allowance. */
  minOut: bigint;
};

const ammInterface = new Interface(SimpleAMMAbi);

export function tokensFor(deployment: Deployment, side: Side): { tokenIn: string; tokenOut: string } {
  return side === "buy"
    ? { tokenIn: deployment.musd, tokenOut: deployment.tkn }
    : { tokenIn: deployment.tkn, tokenOut: deployment.musd };
}

/** An ordinary trader: quote the trade, allow some slippage, send it. Exactly what a DEX front-end does. */
export async function sendVictimSwap(
  deployment: Deployment,
  wallet: Wallet,
  trade: VictimTrade,
): Promise<SentSwap> {
  const amm = new Contract(deployment.amm, SimpleAMMAbi, wallet);
  const { tokenIn, tokenOut } = tokensFor(deployment, trade.side);
  const quote = (await amm.getFunction("getAmountOut")(tokenIn, trade.amountIn)) as bigint;
  const minOut = minOutWithSlippage(quote, trade.slippageBps);
  const tx = (await amm.getFunction("swapExactIn")(
    tokenIn,
    trade.amountIn,
    minOut,
    wallet.address,
  )) as ContractTransactionResponse;
  return { tx, tokenIn, tokenOut, quote, minOut };
}

/** The amount the swap actually paid out, read from its Swap event. Null if the transaction reverted. */
export function swapOutput(receipt: TransactionReceipt, amm: string): bigint | null {
  if (receipt.status !== 1) return null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== amm.toLowerCase()) continue;
    const parsed = ammInterface.parseLog(log);
    if (parsed?.name === "Swap") return parsed.args.amountOut as bigint;
  }
  return null;
}
