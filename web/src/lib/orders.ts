/**
 * Sealing orders in the browser: the same commitment as the contract and the TypeScript services,
 * keccak256(abi.encode(trader, epoch, isBuy, limitPrice, amount, salt)).
 */
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
