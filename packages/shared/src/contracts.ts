import type { Contract } from "ethers";

/**
 * Call a view function and name its result type: read<bigint>(amm, "reserve0").
 * ethers types contract methods loosely, so this keeps call sites type-safe under strict settings.
 */
export async function read<T>(contract: Contract, method: string, ...args: unknown[]): Promise<T> {
  return (await contract.getFunction(method)(...args)) as T;
}
