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
| 1 | Prove the problem (AMM + sandwich bot) | Done |
| 2 | Build the defence (batch auction + solver) | Next |
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
| `npm test` | Runs every TypeScript test, including end-to-end tests on a fresh local chain. |
| `npm run test:contracts` | Runs every Foundry test. |
| `npm run typecheck` | Type-checks all TypeScript. |
| `npm run format` | Formats TypeScript and JSON with Prettier. Use `forge fmt` inside `contracts/` for Solidity. |
| `npm run demo:up` | Starts a local chain (a block every 4 s), deploys the contracts, and runs the sandwich bot. Leave it running. |
| `npm run demo:attack` | Act I: a victim trade on SimpleAMM. Needs `demo:up` running in another terminal. Options: `-- --side sell --amount 500 --slippage 50` |
| `npm run harness` | Measures extraction over 100 random trades, with and without the bot, and writes a CSV to `results/`. Options: `-- --trades 100 --seed 1 --slippage 100 --min-size 50 --max-size 500` |
| `npm run bot` | Runs only the bot, against a chain that is already running. |
| `npm run deploy:local` | Runs only the deploy script, against a chain on port 8545. |
| `npm run abis` | Rebuilds the contracts and regenerates the TypeScript ABIs in `packages/shared/src/abis/`. Run after changing a contract's interface. |
| `npm run chain` | Starts a bare Anvil chain with 4-second blocks. |
| `npm run spike:ordering` | Re-runs Spike A. |
| `npm run spike:zk` | Re-runs Spike B: compiles the circuit, runs a local setup, proves, and regenerates the Solidity verifier and proof fixture. |

## Running the Act I demo

Two terminals, both in this folder:

1. `npm run demo:up` and wait for "Ready". This terminal shows what the bot sees and does.
2. `npm run demo:attack` makes an ordinary trade and prints the block: bot, victim, bot.

Stop with Ctrl+C in the first terminal.

**Troubleshooting:** if `demo:up` says port 8545 is already used, another chain is running there. Use
`npm run demo:up -- --port 8546` and `npm run demo:attack -- --rpc http://127.0.0.1:8546`, or stop the
leftover chain (PowerShell: `Stop-Process -Name anvil`).

## Layout

```
contracts/
  src/tokens/       MockERC20 (TKN and mUSD)
  src/amm/          SimpleAMM, the "normal exchange"
  script/           DeployLocal.s.sol
  test/unit/        Unit and fuzz tests per contract
  test/spikes/      Spike B on-chain test and its generated verifier
  test/fixtures/    Proofs exported by the circuit scripts
packages/
  shared/           ABIs, deployments, Anvil accounts, chain helpers, AMM maths
  bot/              The sandwich bot: sandwich.ts (pure maths) and bot.ts (live mempool watcher)
  harness/          demo:up, demo:attack, and the measurement harness
circuits/spikes/    Spike B circuit and pipeline script
spikes/             Spike A test
deployments/        Contract addresses per chain (local files are git-ignored)
results/            Harness output (CSV per run)
```

Anvil accounts: 0 deployer, 1 victim, 2 bot, 3 solver (Stage 2), 4 to 9 simulated traders (Stage 2).

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

## Stage 1 results: the attack, measured

Pool: 100,000 TKN / 10,000,000 mUSD (100 mUSD per TKN). 100 random trades per run, each run once with
the bot paused and once with it active, from the same chain snapshot. Seed 1. Fully repeatable.

| Victim slippage | Trade size (share of pool) | Trades sandwiched | Mean extraction | When sandwiched | Victims lost | Bot earned |
|---|---|---|---|---|---|---|
| 1% | 0.5% to 5% | 100 / 100 | **100.00 bps** | 100.00 bps | 268,432 mUSD | 254,778 mUSD |
| 0.5% | 0.5% to 5% | 100 / 100 | **50.00 bps** | 50.00 bps | 134,181 mUSD | 127,396 mUSD |
| 1% | 0.01% to 0.5% | 41 / 100 | **41.00 bps** | 100.00 bps | 16,878 mUSD | 4,604 mUSD |

What this shows:

- **A sandwiched victim loses their entire slippage allowance.** The bot sizes its front-run so the victim
  lands exactly on their minimum output, so extraction equals the slippage setting. The brief's "87 bps"
  should be replaced by these measured figures, quoted together with the slippage setting.
- **Small trades are left alone** when the 0.3% fee on the bot's two trades outweighs the gain. In the
  third run the bot skipped 59 of 100 trades, and on the ones it did attack, most of what the victim lost
  went to the pool as fees rather than to the bot.
- The gap between "victims lost" and "bot earned" is the exchange fee on the bot's own trades.
- Both money columns are valued in mUSD at the pool price before each trade. On a single trade the two
  can differ slightly because the amounts are in different tokens; the extraction figure in bps is exact.

Lessons from building it:

- The victim's slippage limit caps the attack. A front-run that is too large makes the victim's trade
  revert and leaves the bot with nothing (`test_Sandwich_OversizedFrontrunMakesVictimRevert`), so the bot
  binary-searches the largest front-run the victim will still tolerate.
- AMM rounding lets a dust-sized front-run "profit" a few wei even against a victim who allows zero
  slippage. The bot ignores anything at or below 0.01 of a token (`DUST_PROFIT`).
- The off-chain model matches the contract to the wei: the TypeScript sandwich reproduces the Solidity
  test's profit of 156.937522897291873389 mUSD exactly, and the live bot earns exactly what it planned.

## Conventions

- `main` always passes its tests. Work on a branch, open a pull request, get one review.
- Secrets live only in `.env` (copy `.env.example`). Never commit it, never paste keys into chat,
  and use a wallet made only for this project.
- Solidity: `forge fmt`, NatSpec on public functions, custom errors.
- TypeScript: strict mode, Prettier.
