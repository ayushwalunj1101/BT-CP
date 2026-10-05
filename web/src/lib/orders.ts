/**
 * Sealing orders in the browser: the same commitments as the contracts and the TypeScript services.
 * v1: keccak256(abi.encode(trader, epoch, isBuy, limitPrice, amount, salt))
 * ZK: Poseidon(trader, epoch, side, limitTicks, amountLots, salt)
 */
import { encrypt } from "eciesjs";
import { poseidon6 } from "poseidon-lite";
import { type Address, bytesToHex, encodeAbiParameters, keccak256 } from "viem";

export function commitmentHash(
  trader: Address,
  epoch: bigint,
  isBuy: boolean,
  limitPrice: bigint,
  amount: bigint,
  salt: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bool" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "bytes32" },
      ],
      [trader, epoch, isBuy, limitPrice, amount, salt],
    ),
  );
}

export function randomSalt(): `0x${string}` {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ------------------------------------------------------------------ zero-knowledge orders

/** 1 lot = 0.001 TKN; 1 tick = 0.01 mUSD per TKN. */
export const LOT = 10n ** 15n;
export const TICK = 10n ** 16n;
/** mUSD wei for 1 lot at 1 tick. */
export const QUOTE_UNIT = 10n ** 13n;

export type ZkOrder = { isBuy: boolean; limitTicks: bigint; amountLots: bigint; salt: bigint };

export function zkCommitment(trader: Address, epoch: bigint, o: ZkOrder): bigint {
  return poseidon6([BigInt(trader), epoch, o.isBuy ? 1n : 0n, o.limitTicks, o.amountLots, o.salt]);
}

/** A random salt below the SNARK field (31 bytes). */
export function randomFieldSalt(): bigint {
  return BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(31))));
}

/** Encrypt the order to the solver's public key and post it to the solver's inbox. */
export async function sendToSolver(
  inboxUrl: string,
  epoch: bigint,
  trader: Address,
  o: ZkOrder,
): Promise<void> {
  const keyRes = await fetch(`${inboxUrl}/public-key`);
  if (!keyRes.ok) throw new Error("The solver's inbox did not answer.");
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  const wire = JSON.stringify({
    epoch: epoch.toString(),
    trader,
    isBuy: o.isBuy,
    limitTicks: o.limitTicks.toString(),
    amountLots: o.amountLots.toString(),
    salt: o.salt.toString(),
  });
  const ciphertext = encrypt(publicKey, new TextEncoder().encode(wire));
  const res = await fetch(`${inboxUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: bytesToHex(ciphertext).slice(2),
  });
  if (res.status !== 202) throw new Error(`The solver refused the order (HTTP ${res.status}).`);
}
