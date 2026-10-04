/**
 * The private order channel (task 4.7). On the ZK path a trader's order never goes on-chain: only its
 * Poseidon commitment does. The order itself travels to the solver over HTTP, encrypted to the solver's
 * public key (ECIES on secp256k1), so nobody on the network or in the mempool can read it.
 *
 * The solver checks every received order against the commitment on-chain before using it, so a wrong or
 * forged order is simply ignored.
 */
import { type IncomingMessage, type Server, createServer } from "node:http";
import { PrivateKey, decrypt, encrypt } from "eciesjs";
import type { ZkOrder } from "@obscura/shared";

/** An order, and the batch and trader it was sealed for. */
export type Opening = { epoch: bigint; trader: string; order: ZkOrder };

type Wire = {
  epoch: string;
  trader: string;
  isBuy: boolean;
  limitTicks: string;
  amountLots: string;
  salt: string;
};

const MAX_BODY = 4_096;

function parseOpening(json: string): Opening {
  const w = JSON.parse(json) as Partial<Wire>;
  if (
    typeof w.epoch !== "string" ||
    typeof w.trader !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(w.trader) ||
    typeof w.isBuy !== "boolean" ||
    typeof w.limitTicks !== "string" ||
    typeof w.amountLots !== "string" ||
    typeof w.salt !== "string"
  ) {
    throw new Error("malformed order");
  }
  const order: ZkOrder = {
    isBuy: w.isBuy,
    limitTicks: BigInt(w.limitTicks),
    amountLots: BigInt(w.amountLots),
    salt: BigInt(w.salt),
  };
  if (order.limitTicks <= 0n || order.limitTicks >= 1n << 32n) throw new Error("limit out of range");
  if (order.amountLots <= 0n || order.amountLots >= 1n << 40n) throw new Error("amount out of range");
  return { epoch: BigInt(w.epoch), trader: w.trader, order };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error("body too large");
  }
  return body;
}

/** The solver's side: an HTTP endpoint that decrypts incoming orders and hands them on. */
export class OrderInbox {
  readonly publicKey: string;
  private readonly secret: Uint8Array;
  private server?: Server;

  constructor(
    privateKeyHex: string,
    private readonly onOpening: (opening: Opening) => void,
  ) {
    const key = PrivateKey.fromHex(privateKeyHex.replace(/^0x/, ""));
    this.secret = key.secret;
    this.publicKey = key.publicKey.toHex();
  }

  /** Start listening on 127.0.0.1:`port` (0 = any free port). Resolves to the inbox URL. */
  listen(port: number): Promise<string> {
    this.server = createServer(async (req, res) => {
      // The website posts here from another origin. The inbox only ever receives ciphertext, so any origin is fine.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      try {
        if (req.method === "GET" && req.url === "/public-key") {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ publicKey: this.publicKey }));
          return;
        }
        if (req.method === "POST" && req.url === "/orders") {
          const ciphertext = Buffer.from((await readBody(req)).trim(), "hex");
          const opening = parseOpening(Buffer.from(decrypt(this.secret, ciphertext)).toString("utf8"));
          this.onOpening(opening);
          res.writeHead(202).end();
          return;
        }
        res.writeHead(404).end();
      } catch {
        res.writeHead(400).end("could not read the order");
      }
    });
    return new Promise((resolve) => {
      this.server!.listen(port, "127.0.0.1", () => {
        const address = this.server!.address();
        resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** The trader's side: encrypt an order to the solver's public key and send it. */
export async function sendOrderToSolver(
  inboxUrl: string,
  solverPublicKey: string,
  opening: Opening,
): Promise<void> {
  const wire: Wire = {
    epoch: opening.epoch.toString(),
    trader: opening.trader,
    isBuy: opening.order.isBuy,
    limitTicks: opening.order.limitTicks.toString(),
    amountLots: opening.order.amountLots.toString(),
    salt: opening.order.salt.toString(),
  };
  const ciphertext = encrypt(solverPublicKey, Buffer.from(JSON.stringify(wire), "utf8"));
  const res = await fetch(`${inboxUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: Buffer.from(ciphertext).toString("hex"),
  });
  if (res.status !== 202) throw new Error(`the solver refused the order (HTTP ${res.status})`);
}

export async function fetchSolverPublicKey(inboxUrl: string): Promise<string> {
  const res = await fetch(`${inboxUrl}/public-key`);
  return ((await res.json()) as { publicKey: string }).publicKey;
}
