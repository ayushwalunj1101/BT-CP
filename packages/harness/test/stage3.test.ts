/**
 * Stage 3 on a live chain: the deployed bounty vault is funded, watches the real auction, and refuses to pay
 * while every rule holds. (The planted-bug payouts are Foundry tests: contracts/test/bounty.)
 */
import { join } from "node:path";
import { Contract, keccak256, toUtf8Bytes } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOYMENTS_DIR, InvariantBountyAbi, type SealedOrder, anvilWallet, read } from "@obscura/shared";
import { runManualBatch } from "../src/batch.ts";
import { type LocalEnv, startLocalEnv } from "../src/env.ts";
import { mulberry32 } from "../src/random.ts";
import { TRADER_ACCOUNTS, randomOrders, seededSalt } from "../src/traders.ts";

const PORT = 8591;
const e18 = 10n ** 18n;
let env: LocalEnv;

beforeAll(async () => {
  env = await startLocalEnv({
    port: PORT,
    mining: { mode: "manual" },
    deploymentFile: join(DEPLOYMENTS_DIR, `test-${PORT}.json`),
    removeDeploymentOnStop: true,
    botLog: () => {},
  });
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe("the bounty vault on a live chain", () => {
  it("is funded and watches the deployed auction", async () => {
    expect(await read<bigint>(env.bounty, "vaultBalance")).toBe(10_000n * e18);
    expect((await read<string>(env.bounty, "target")).toLowerCase()).toBe(
      env.deployment.auction.toLowerCase(),
    );
    expect(await read<boolean>(env.bounty, "paid")).toBe(false);
  });

  it("finds no broken rule after a real batch, and refuses a claim", async () => {
    const random = mulberry32(3);
    const victim: SealedOrder = {
      isBuy: true,
      amount: 300n * e18,
      limitPrice: 101n * e18,
      salt: seededSalt(random),
    };
    const { epoch } = await runManualBatch(
      env,
      { traders: randomOrders(random, 100n * e18, TRADER_ACCOUNTS.length), victim },
      false,
    );

    for (const id of [1, 2, 3, 4]) {
      expect(await read<boolean>(env.bounty, "isViolated", id, epoch), `I${id}`).toBe(false);
    }
    expect(await read<boolean>(env.auction, "checkI1")).toBe(true);

    // A researcher goes through the full claim procedure anyway; the vault checks and says no.
    const researcher = anvilWallet(5, env.provider);
    const bounty = new Contract(env.deployment.bounty, InvariantBountyAbi, researcher);
    const salt = keccak256(toUtf8Bytes("no bug here"));
    const hash = await read<string>(bounty, "claimHash", researcher.address, 2, epoch, salt);
    await bounty.getFunction("commitClaim")(hash);
    await env.provider.send("anvil_mine", ["0x3"]);
    await expect(bounty.getFunction("claim").staticCall(2, epoch, salt)).rejects.toThrow(
      /NoViolation|reverted/,
    );
    expect(await read<bigint>(env.bounty, "vaultBalance")).toBe(10_000n * e18);
  });
});
