import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Serves deployments/<chainId>.json from the repository, so a fresh local deploy needs no rebuild. */
export async function GET(_request: Request, context: { params: Promise<{ chainId: string }> }) {
  const { chainId } = await context.params;
  if (!/^\d+$/.test(chainId)) return new Response("bad chain id", { status: 400 });
  try {
    const json = await readFile(join(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8");
    return new Response(json, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return new Response("not deployed on this chain", { status: 404 });
  }
}
