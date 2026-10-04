"use client";

import type { Abi, TransactionReceipt } from "viem";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { config } from "./wagmi";

export type Call = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** Set explicitly for auction calls: estimating against the current block can see the wrong window. */
  gas?: bigint;
};

/**
 * Send a contract call and wait until it is mined. Throws if it reverts.
 * Calls without an explicit gas limit are simulated first: a failure then comes back as a decoded contract
 * error (for example NoViolation) before anything is sent. Calls with a gas limit are the auction's
 * window-sensitive ones, where simulating against the current block would see the wrong window.
 */
export async function send(call: Call): Promise<TransactionReceipt> {
  // Call is this app's own simplified shape; viem's full union of transaction types is not needed here.
  if (call.gas === undefined) await simulateContract(config, call as never);
  const hash = await writeContract(config, call as never);
  const receipt = await waitForTransactionReceipt(config, { hash });
  if (receipt.status !== "success") throw new Error("The transaction was reverted on-chain.");
  return receipt;
}

/** Read a view function and name its result type. */
export async function read<T>(call: Omit<Call, "value" | "gas">): Promise<T> {
  return (await readContract(config, call as never)) as T;
}
