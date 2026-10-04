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
| 2 | Build the defence (batch auction + solver) | Done |
| 3 | Bounty vault + invariant fuzzing | Done |
| 4 | Zero-knowledge clearing | Next |
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
| `npm run demo:up` | Starts a local chain (a block every 2 s), deploys both venues, and runs the sandwich bot, the solver and six simulated traders. Leave it running. |
| `npm run demo:attack` | Act I: a victim trade on SimpleAMM. Needs `demo:up` running in another terminal. Options: `-- --side sell --amount 500 --slippage 50` |
| `npm run demo:defence` | Act II: the same trade as a sealed order through Obscura. Same options as `demo:attack`. |
| `npm run demo:bounty` | Act III: four planted bugs, one per rule, each making the bounty vault pay out automatically; the real contract never does. |
| `npm run fuzz` | The long invariant campaign (1,000 runs × 300 random calls, about 10 minutes). Writes `results/fuzz-report.md`. |
| `npm run harness` | Measures extraction over 100 random trades on both venues, with and without the bot, and writes CSVs to `results/`. Options: `-- --venue both --trades 100 --seed 1 --slippage 100 --min-size 50 --max-size 500` |
| `npm run bot` | Runs only the bot, against a chain that is already running. |
| `npm run solver` | Runs only the solver, against a chain that is already running. |
| `npm run vectors` | Regenerates the commitment-hash test vectors that both the TypeScript and Solidity suites check. |
| `npm run deploy:local` | Runs only the deploy script, against a chain on port 8545. |
| `npm run abis` | Rebuilds the contracts and regenerates the TypeScript ABIs in `packages/shared/src/abis/`. Run after changing a contract's interface. |
| `npm run chain` | Starts a bare Anvil chain with 4-second blocks. |
| `npm run spike:ordering` | Re-runs Spike A. |
| `npm run spike:zk` | Re-runs Spike B: compiles the circuit, runs a local setup, proves, and regenerates the Solidity verifier and proof fixture. |

## Running the demo

Two terminals, both in this folder:

1. `npm run demo:up` and wait for "Ready". This terminal shows what the bot, the solver and the traders do.
2. Act I: `npm run demo:attack` makes an ordinary trade on SimpleAMM and prints the block: bot, victim, bot.
3. Act II: `npm run demo:defence` makes the same trade as a sealed Obscura order and follows it through one
   batch (about 22 s): what the bot sees, the clearing price, every fill at that price, and the bot's zero.
4. Act III: `npm run demo:bounty` (needs no chain) runs the four planted bugs against the bounty vault.
   `demo:up` also deploys the real vault with 10,000 mUSD and prints its address.

Stop with Ctrl+C in the first terminal.

**Troubleshooting:** if `demo:up` says port 8545 is already used, another chain is running there. Use
`npm run demo:up -- --port 8546` and `npm run demo:attack -- --rpc http://127.0.0.1:8546`, or stop the
leftover chain (PowerShell: `Stop-Process -Name anvil`).

## Layout

```
contracts/
  src/ObscuraBase.sol       Deposit ledger, epoch clock, ETH bonds, settlement maths (no admin)
  src/ObscuraAuction.sol    Commit, reveal, submitSolution, settle, and the checks for I2 to I4
  src/InvariantBounty.sol   The vault that pays whoever proves I1 to I4 broken (commit-reveal claims)
  src/interfaces/           IObscuraInvariants: checkI1 to checkI4
  src/libraries/Clearing.sol  The rules a batch solution must obey, checked in one pass
  src/tokens/       MockERC20 (TKN and mUSD)
  src/amm/          SimpleAMM, the "normal exchange"
  script/           DeployLocal.s.sol
  test/unit/        Unit and fuzz tests per contract
  test/bounty/      The vault's tests, including the four planted bugs
  test/invariant/   The fuzzing handler, a Solidity reference solver, and the invariant suite
  test/vectors/     Commitment-hash vectors shared with the TypeScript tests
  test/spikes/      Spike B on-chain test and its generated verifier
  test/fixtures/    Proofs exported by the circuit scripts
packages/
  shared/           ABIs, deployments, Anvil accounts, chain and batch-clock helpers, AMM maths, order hashing
  bot/              The sandwich bot: sandwich.ts (pure maths) and bot.ts (live mempool watcher)
  solver/           clearing.ts (the clearing algorithm) and solver.ts (solve and settle each batch)
  harness/          demo:up, demo:attack, demo:defence, simulated traders, and the measurement harness
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

## Stage 2 results: the defence, measured

The same 100 trades as Stage 1 (same seed, same sides, same sizes relative to the pool, the victim's
slippage allowance becoming their limit price), each placed as a sealed order into an Obscura batch with
six simulated traders, run once with the bot paused and once active.

| Victim slippage | Trade size | SimpleAMM extraction | Obscura extraction | Obscura: victim filled | Same result with and without the bot |
|---|---|---|---|---|---|
| 1% | 0.5% to 5% | 100.00 bps (100 / 100 sandwiched) | **0.00 bps** (0 / 100) | 99 / 100, median 44% of the order | 100 / 100 |
| 0.5% | 0.5% to 5% | 50.00 bps (100 / 100) | **0.00 bps** (0 / 100) | 78 / 100, median 21% | 100 / 100 |
| 1% | 0.01% to 0.5% | 41.00 bps (41 / 100) | **0.00 bps** (0 / 100) | 99 / 100, median 100% | 100 / 100 |

What this shows:

- **The bot takes nothing on Obscura.** It sees every commit (a hash) and every reveal (too late: the batch is
  closed and everyone gets one price), sends no transactions, and every victim's result is identical with
  the bot running or not.
- **Honest caveat: thin liquidity means partial fills.** Six simulated traders posting 100 to 600 TKN each
  cannot absorb victim orders of 500 to 5,000 TKN, so large orders fill partly; a tighter limit (0.5%)
  crosses fewer of them. On the AMM every trade fills, just at a worse price. A batch auction needs enough
  counterparties per batch: that is its real trade-off against a pool, and the report should say so.

Correctness evidence:

- 71 Foundry tests and 30 TypeScript tests. Line coverage 98% on ObscuraAuction, 99% on ObscuraBase.
- The solver's answer for 1,000 random order books passes the deployed contract's own `checkClearing`, and
  adding one wei to any fill is always rejected.
- `test_RevealOrderChangesNobodysResult`: the same orders revealed in opposite orders give every trader
  exactly the same result. Position in a batch is worth nothing.
- After every settlement test, the contract's token and ETH balances equal everything it owes.
- Commitment hashes match between TypeScript and Solidity on 16 shared vectors.

Settlement gas grows linearly, about 94,000 per order:

| Orders in batch | 8 | 16 | 32 | 64 |
|---|---|---|---|---|
| `settle()` gas | 0.99 M | 1.75 M | 3.25 M | 6.26 M |

Design fixes made while building (also in the implementation plan):

- **Self-slashing.** A slashed bond is split, half to whoever called `settle()` and half burned. If the
  caller got the whole bond, a cheating solver could call `settle()` itself and lose nothing.
- **Mistimed commits.** `commit(epoch, hash)` takes the batch number, so a transaction that lands one block
  late reverts instead of being filed under the next batch, where its reveal would fail.
- **Pull payments.** ETH owed to people is credited and withdrawn by them, so a solver that refuses ETH
  cannot block settlement for everyone.
- **No overflow on huge orders.** Recorded fills use full 256-bit amounts, because anyone can mint the
  test tokens and a giant order would otherwise not fit.

## Stage 3 results: money on it

### The four rules, checked on-chain

| Rule | `checkIx` returns true when |
|---|---|
| I1 Conservation | The contract really holds at least what its ledger owes, in TKN, mUSD and ETH. "At least", so a donation cannot fake a violation. |
| I2 Uniform price | Every fill in the batch moved exactly base × p* in mUSD, rounded up for buyers and down for sellers. |
| I3 Limit respect | No buyer paid more than their limit allows, no seller received less, no fill exceeded its order. |
| I4 Solver honesty | Across settlement, the winning solver's ledger gained no more than the declared reward (10 mUSD). |

### The bounty vault

`InvariantBounty` holds 10,000 mUSD of test funds and pays all of it to the first person who proves a rule
broken. Nobody approves or can stop the payout: the vault calls the check itself. Claims are commit-reveal
(attack A6): commit a hash that includes your address, then claim at least 2 blocks later. A bot copying
the claim comes from another address, so its hash matches nothing.

| Test (`npm run demo:bounty`) | Result |
|---|---|
| Correct auction after a real batch | No rule broken, every claim refused |
| Tokens and ETH sent straight to the contract | No rule broken (I1 uses "at least") |
| Planted I1 bug: a withdrawal that skips the ledger | Vault pays 10,000 mUSD |
| Planted I2 bug: buyers charged their own limit, not p* | Vault pays 10,000 mUSD |
| Planted I3 bug: sellers paid half the batch price | Vault pays 10,000 mUSD |
| Planted I4 bug: solver pays itself double the reward | Vault pays 10,000 mUSD |
| A bot copies a pending claim, and its commitment | Gets nothing; the researcher is paid |

### Invariant fuzzing

The fuzzer calls 13 random actions in random order (deposit, withdraw, commit, reveal, reveal all, honest
solution, corrupted solution, settle, withdraw ETH, skip blocks, jump to the next window, donate, and a
whole batch at once), and after every single call checks I1 to I4 plus three checks against bookkeeping
the contract cannot influence: token and ETH balances against the full deposit and withdrawal history,
the ledger total against that history exactly, and every person's balance adding up to the totals.

From [`results/fuzz-report.md`](results/fuzz-report.md) (`npm run fuzz`):

| | |
|---|---|
| Calls | 300,000 (1,000 runs × 300) |
| Invariants broken | **0 of 7** |
| Batches settled with trades | 20,422 |
| Corrupted solutions submitted | 8,434 |
| Batches voided | 1,550 |
| Orders committed / revealed | 99,188 / 87,110 |

Lesson from building it: the first version of the fuzzer "passed" while reaching settlement almost never
(zero solutions in 65 runs), because random time jumps skipped the 2-block reveal window. A passing fuzzer
proves nothing until you check how deep it got. The campaign now records that for every run.

## Conventions

- `main` always passes its tests. Work on a branch, open a pull request, get one review.
- Secrets live only in `.env` (copy `.env.example`). Never commit it, never paste keys into chat,
  and use a wallet made only for this project.
- Solidity: `forge fmt`, NatSpec on public functions, custom errors.
- TypeScript: strict mode, Prettier.
