# Obscura

An on-chain dark pool: orders are sealed before they trade, every order in a batch settles at one
uniform price, and a vault pays out automatically to anyone who proves a core rule broken.
Testnet only. No real funds at any stage.

- Project brief: `../obscura-project-brief.html`
- Implementation plan: `../obscura-implementation-plan.html`

## Status

| Stage | What | Status |
|---|---|---|
| 0 | Setup and spikes | Done |
| 1 | Prove the problem (AMM + sandwich bot) | Next |
| 2 | Build the defence (batch auction + solver) | |
| 3 | Bounty vault + invariant fuzzing | |
| 4 | Zero-knowledge clearing | |
| 5 | Web app + Sepolia | |

## Prerequisites

| Tool | Version used | Install |
|---|---|---|
| Node.js | 24.x (22+ works) | https://nodejs.org |
| Git | 2.50 | https://git-scm.com |
| Foundry (forge, anvil, cast) | 1.8.4 | In Git Bash: `curl -L https://foundry.paradigm.xyz \| bash`, then `foundryup` |
| Circom | 2.2.3 | Download `circom-windows-amd64.exe` from https://github.com/iden3/circom/releases, save it as `circom.exe` in `%USERPROFILE%\.circom\bin` |

Add `%USERPROFILE%\.foundry\bin` and `%USERPROFILE%\.circom\bin` to your PATH, then open a new terminal.

## Setup

```sh
git clone --recurse-submodules <repo-url> obscura
cd obscura
npm install
npm run test:contracts   # Solidity tests
npm test                 # TypeScript tests (starts its own Anvil chain)
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs every TypeScript test. |
| `npm run test:contracts` | Runs every Foundry test. |
| `npm run typecheck` | Type-checks all TypeScript. |
| `npm run format` | Formats TypeScript and JSON with Prettier. Use `forge fmt` inside `contracts/` for Solidity. |
| `npm run chain` | Starts a local Anvil chain with 4-second blocks. |
| `npm run spike:ordering` | Re-runs Spike A. |
| `npm run spike:zk` | Re-runs Spike B: compiles the circuit, runs a local setup, proves, and regenerates the Solidity verifier and proof fixture. |

## Layout

```
contracts/        Foundry project (src, test, script)
  test/spikes/    Spike B on-chain test and its generated verifier
  test/fixtures/  Proofs exported by the circuit scripts
circuits/spikes/  Spike B circuit and pipeline script
spikes/           Spike A test
packages/         TypeScript packages (from Stage 1)
```

## Spike results (Stage 0)

### Spike A: can the bot control transaction order on Anvil? Yes, with one rule.

`spikes/ordering.test.ts`, 4 tests, stable over repeated runs.

- A WebSocket subscriber sees a transaction while it is still pending, so the bot can react before it is mined.
- **Anvil ranks pending transactions by max fee per gas, not by priority fee (tip).** When max fees are
  equal, it keeps arrival order. Real Ethereum block builders rank by tip.
- So the bot raises **both** the max fee and the tip to go before the victim, and lowers **both** to go after
  it. That ordering holds with manual mining (the measurement harness) and with interval mining (the live demo).
- ethers caches identical RPC calls for 250 ms by default, which returns stale nonces. Every provider in
  this project sets `cacheTimeout: -1`.

### Spike B: does the ZK toolchain work end to end on our machines? Yes.

`circuits/spikes/` and `contracts/test/spikes/`, 4 Foundry tests.

- A circuit proving "I know an order and salt whose Poseidon hash is this commitment" compiles to
  517 constraints and proves in a few seconds.
- The snarkjs-generated Solidity verifier accepts the proof for **about 214,000 gas** with one public input,
  and rejects a changed commitment or a tampered proof.
- An invalid proof makes the verifier burn all the gas it is given. In Stage 4, a solver's proof must only
  ever be checked inside the solver's own transaction, so nobody else can be made to pay for a bad one.
- The spike uses a one-person local setup ceremony. Stage 4 uses a public Powers of Tau file.

## Conventions

- `main` always passes its tests. Work on a branch, open a pull request, get one review.
- Secrets live only in `.env` (copy `.env.example`). Never commit it, never paste keys into chat,
  and use a wallet made only for this project.
- Solidity: `forge fmt`, NatSpec on public functions, custom errors.
- TypeScript: strict mode, Prettier.
