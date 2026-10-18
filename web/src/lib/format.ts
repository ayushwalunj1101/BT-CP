import {
  InvariantBountyAbi,
  MockERC20Abi,
  ObscuraAuctionAbi,
  ObscuraAuctionZKAbi,
  SimpleAMMAbi,
} from "@obscura/shared/abis";
import { type Abi, type Hex, decodeErrorResult, formatUnits, parseUnits, toFunctionSelector } from "viem";

const ABIS = [
  ObscuraAuctionAbi,
  ObscuraAuctionZKAbi,
  InvariantBountyAbi,
  SimpleAMMAbi,
  MockERC20Abi,
] as Abi[];

/** Contract errors a person can hit by timing alone, in plain words. */
const PLAIN: Record<string, string> = {
  WrongPhase:
    "The batch moved to its next window before your transaction landed, so it was refused. Try again in the next commit window.",
};

/** 18-decimal amount → "1,234.56" */
export function fmt(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return "…";
  return Number(formatUnits(value, 18)).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function short(value: string, keep = 4): string {
  return value.length <= 2 + keep * 2 ? value : `${value.slice(0, 2 + keep)}…${value.slice(-keep)}`;
}

/** Parse a user-typed decimal into 18-decimal units; null if it is not a positive number. */
export function parseAmount(text: string): bigint | null {
  const clean = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{0,18})?$/.test(clean)) return null;
  const value = parseUnits(clean, 18);
  return value > 0n ? value : null;
}

/** The short, readable part of a viem/wagmi error. A decoded contract error comes back as Name(args). */
export function errorText(err: unknown): string {
  if ((err as { name?: string } | undefined)?.name === "ProviderNotFoundError")
    return "No wallet in this browser. Open this page in the browser where MetaMask is installed.";
  type Link = {
    data?: { errorName?: string; args?: readonly unknown[] } | string;
    message?: string;
    cause?: unknown;
  };
  let link = err as Link | undefined;
  for (let depth = 0; link && depth < 10; depth++) {
    // A simulated call comes back decoded; a mined revert comes back as raw bytes, which we decode here.
    if (typeof link.data === "object" && link.data.errorName)
      return named(link.data.errorName, link.data.args);
    if (typeof link.data === "string" && /^0x[0-9a-fA-F]{8}/.test(link.data)) {
      const decoded = decodeRevert(link.data as Hex);
      if (decoded) return decoded;
    }
    const selector = link.message?.match(/custom error (0x[0-9a-fA-F]{8})/)?.[1];
    if (selector) {
      const name = errorNameFor(selector);
      if (name) return named(name);
    }
    link = link.cause as Link | undefined;
  }
  const e = err as { shortMessage?: string; message?: string; cause?: { reason?: string } };
  const text = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? String(err);
  return text.split("\n")[0]!.replace(/^Error: /, "");
}

function named(name: string, args?: readonly unknown[]): string {
  return PLAIN[name] ?? `${name}(${(args ?? []).map(String).join(", ")})`;
}

function decodeRevert(data: Hex): string | null {
  for (const abi of ABIS) {
    try {
      const { errorName, args } = decodeErrorResult({ abi, data });
      return named(errorName, args);
    } catch {
      // not this contract's error
    }
  }
  return null;
}

function errorNameFor(selector: string): string | null {
  for (const abi of ABIS) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const signature = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (toFunctionSelector(signature) === selector.toLowerCase()) return item.name;
    }
  }
  return null;
}
