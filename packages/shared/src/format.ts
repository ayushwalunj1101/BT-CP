import { formatUnits } from "ethers";

/** 50000123400000000000000n → "50,000.12" (18-decimal token amounts, for display only). */
export function fmtAmount(value: bigint, digits = 2, decimals = 18): string {
  return Number(formatUnits(value, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 0x3c1e…a9f2 */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function fmtGwei(wei: bigint): string {
  return `${Number(formatUnits(wei, "gwei")).toFixed(3)} gwei`;
}
