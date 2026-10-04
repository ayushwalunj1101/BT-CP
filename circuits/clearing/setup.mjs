// Trusted setup for the ZK clearing circuit (task 4.5).
//
//   1. compile circuits/clearing/clearing.circom
//   2. phase 1: the public Perpetual Powers of Tau file (PSE, 80 contributions), checked against a pinned hash
//   3. phase 2: our own contribution with fresh random entropy, which is never stored
//   4. export the proving key, the verification key, and the Solidity verifier contract
//
// Usage: npm run zk:setup
// Outputs: circuits/keys/clearing.zkey, circuits/keys/clearing.wasm, circuits/keys/clearing_vkey.json,
//          contracts/src/zk/ClearingVerifier.sol

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const build = join(root, "circuits", "build", "clearing");
const keys = join(root, "circuits", "keys");
const ptauDir = join(root, "circuits", "ptau");
const snarkjsCli = join(root, "node_modules", "snarkjs", "build", "cli.cjs");

const PTAU_NAME = "ppot_0080_15.ptau";
const PTAU_URL = `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/${PTAU_NAME}`;
const PTAU_SHA256 = "4a8eb5a754ed4710d6ad603c2e1a89c72325a448e4474f8694d2c71c7c272f3d";

const circom = (() => {
  const exe = process.platform === "win32" ? "circom.exe" : "circom";
  const local = join(homedir(), ".circom", "bin", exe);
  return existsSync(local) ? local : "circom";
})();

const run = (label, cmd, args) => {
  console.log(`\n> ${label}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
};
const snarkjs = (label, ...args) => run(label, process.execPath, [snarkjsCli, ...args]);

mkdirSync(build, { recursive: true });
mkdirSync(keys, { recursive: true });
mkdirSync(ptauDir, { recursive: true });

run("compile circuit", circom, [
  join(root, "circuits", "clearing", "clearing.circom"),
  "--r1cs",
  "--wasm",
  "-o",
  build,
  "-l",
  join(root, "node_modules"),
]);

const ptau = join(ptauDir, PTAU_NAME);
if (!existsSync(ptau)) {
  console.log(`\n> download ${PTAU_NAME} (about 38 MB)`);
  execFileSync("curl", ["-sSfL", "-o", ptau, PTAU_URL], { stdio: "inherit" });
}
const hash = createHash("sha256").update(readFileSync(ptau)).digest("hex");
if (hash !== PTAU_SHA256) {
  rmSync(ptau);
  throw new Error(`${PTAU_NAME} does not match its pinned hash; deleted it. Run again to re-download.`);
}
console.log(`\n> ${PTAU_NAME}: hash matches the pinned value`);

const zkey0 = join(build, "clearing_0.zkey");
const zkey = join(keys, "clearing.zkey");
snarkjs("phase 2: circuit-specific setup", "groth16", "setup", join(build, "clearing.r1cs"), ptau, zkey0);
snarkjs(
  "phase 2: our contribution (random entropy, never saved)",
  "zkey",
  "contribute",
  zkey0,
  zkey,
  "--name=obscura",
  `-e=${randomBytes(32).toString("hex")}`,
);
rmSync(zkey0);
snarkjs(
  "export verification key",
  "zkey",
  "export",
  "verificationkey",
  zkey,
  join(keys, "clearing_vkey.json"),
);
copyFileSync(join(build, "clearing_js", "clearing.wasm"), join(keys, "clearing.wasm"));

const verifierOut = join(root, "contracts", "src", "zk", "ClearingVerifier.sol");
const rawVerifier = join(build, "verifier.sol");
snarkjs("export Solidity verifier", "zkey", "export", "solidityverifier", zkey, rawVerifier);
mkdirSync(dirname(verifierOut), { recursive: true });
writeFileSync(
  verifierOut,
  readFileSync(rawVerifier, "utf8").replace(/contract Groth16Verifier/, "contract ClearingVerifier"),
);

const mb = (f) => (statSync(f).size / 1e6).toFixed(1);
console.log(`\nSetup done.
  proving key       circuits/keys/clearing.zkey (${mb(zkey)} MB)
  witness generator circuits/keys/clearing.wasm (${mb(join(keys, "clearing.wasm"))} MB)
  verifier          contracts/src/zk/ClearingVerifier.sol
Regenerate the test fixture now: npm run zk:fixture`);
