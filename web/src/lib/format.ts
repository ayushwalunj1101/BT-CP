import { formatUnits, parseUnits } from "viem";

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
  let link = err as { data?: { errorName?: string; args?: readonly unknown[] }; cause?: unknown } | undefined;
  for (let depth = 0; link && depth < 10; depth++) {
    if (link.data?.errorName)
      return `${link.data.errorName}(${(link.data.args ?? []).map(String).join(", ")})`;
    link = link.cause as typeof link;
  }
  const e = err as { shortMessage?: string; message?: string; cause?: { reason?: string } };
  const text = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? String(err);
  return text.split("\n")[0]!.replace(/^Error: /, "");
}
