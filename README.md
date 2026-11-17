# Obscura

An on-chain dark pool: orders are sealed before they trade, every order in a batch settles at one
uniform price, and a vault pays out automatically to anyone who proves a core rule broken.
Testnet only. No real funds at any stage.

- Project brief: `../obscura-project-brief.html`
- Implementation plan: `../obscura-implementation-plan.html`

## Status

| Stage | What | Status |
|---|---|---|
| 0 | Setup and tool checks | Done |
| 1 | Prove the problem (AMM + sandwich bot) | Done |
| 2 | Build the defence (batch auction + solver) | Done |
| 3 | Bounty vault + invariant fuzzing | Done |
| 4 | Zero-knowledge clearing | Removed to keep the project simple; kept at git tag `full-version` |
| 5 | Web app + Sepolia | Done: website built, contracts live and verified on Sepolia |

## Prerequisites

| Tool | Version used | Install |
|---|---|---|
| Node.js | 24.x (22+ works) | https://nodejs.org |
| Git | 2.50 | https://git-scm.com |
| Foundry (forge, anvil, cast) | 1.8.4 | In Git Bash: `curl -L https://foundry.paradigm.xyz \| bash`, then `foundryup` |

Add `%USERPROFILE%\.foundry\bin` to your PATH, then open a new terminal.

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
| `npm run web` | Starts the website on http://localhost:3000 (run `demo:up` first for the local chain). |
| `npm run deploy:sepolia` | Deploys everything to Sepolia and verifies it on Etherscan. Add `-- --dry-run` to rehearse on a local chain first. |
| `npm run sepolia:services` | Runs the solver and a market maker against Sepolia, for the live demo. Add `-- --no-market-maker` to run the solver only. |
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
packages/
  shared/           ABIs, deployments, Anvil accounts, chain and batch-clock helpers, AMM maths, order hashing
  bot/              The sandwich bot: sandwich.ts (pure maths) and bot.ts (live mempool watcher)
  solver/           clearing.ts (the clearing algorithm), solver.ts (submits solutions and settles batches)
  harness/          demo:up, demo:attack, demo:defence, simulated traders, the Sepolia market maker, and the
                    measurement harness
web/                The website (Next.js 16, wagmi 3, viem): src/app (pages), src/components, src/lib
scripts/            fuzz.mjs (long invariant campaign), deploy-sepolia.mjs
deployments/        Contract addresses per chain (local files are git-ignored)
results/            Harness output (CSV per run)
```

Anvil accounts: 0 deployer, 1 victim, 2 bot, 3 solver, 4 to 9 simulated traders.

## Notes on the local chain (Stage 0)

Before building, we checked that a bot can control transaction order on Anvil. It can, with one rule.

- A WebSocket subscriber sees a transaction while it is still pending, so the bot can react before it is mined.
- **Anvil ranks pending transactions by max fee per gas, not by priority fee (tip).** When max fees are
  equal, it keeps arrival order. Real Ethereum block builders rank by tip.
- So the bot raises **both** the max fee and the tip to go before the victim, and lowers **both** to go after
  it. That ordering holds with manual mining (the measurement harness) and with interval mining (the live demo).
- ethers caches identical RPC calls for 250 ms by default, which returns stale nonces. Every provider in
  this project sets `cacheTimeout: -1`.

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

## Stage 4: zero-knowledge clearing (removed)

Stage 4 added a second exchange where orders are never revealed: each batch settled from a zero-knowledge
proof (Circom circuit, Groth16, Poseidon commitments, orders sent to the solver encrypted with ECIES). It
worked, but it added most of the project's hardest concepts and about 30% of its code, and the commit-reveal
auction already stops the sandwich bot on its own. It was removed to keep the project focused.

The full version, with its circuit, contracts, tests and website page, is kept at the git tag `full-version`
(`git switch --detach full-version` to look at it, `git switch -` to come back).

## Stage 5: the website and Sepolia

### The website

| Page | What it does |
|---|---|
| Trade | Deposit, seal an order (the hash is computed in your browser), commit it with the bond, and it is revealed automatically in the reveal window while the tab is open. Your secret salt is kept in a reveal ticket you can download and restore. Shows your fill at the batch price. |
| Batches | Recent batches: clearing price, matched volume, solver, and every fill at that one price. |
| Bounty | The vault's balance, the four rules checked live, and the two-step claim. |
| Normal exchange | Act I in the browser: swap on SimpleAMM while the bot runs and see BOT, YOU, BOT in your block. |

Run it locally: `npm run demo:up` in one terminal, `npm run web` in another, open http://localhost:3000 and click
**Local test account** (Anvil's account #0, which Anvil signs for, so no key is involved). MetaMask works too.
The local test account is only offered while the local chain is running. Without it, visitors see Sepolia, and a
wallet on any other network gets a **Switch to Sepolia** button.

Tested in a real browser (Playwright) against the live local chain: connect, get test tokens, deposit; a sealed
order revealed automatically and filled at the batch price (99.75, limit 101); the batch explorer; a bounty claim refused with a plain
message; a swap on the normal exchange sandwiched by the bot (100.00 bps); and the layout at phone width.
Bugs found and fixed while testing: the test wallet disconnected on reload, and contract errors showed as raw
bytes instead of names (calls are now simulated first, so errors are decoded before anything is sent).

### Live on Sepolia

Deployed on 2026-10-05 from `0xcaa820b6b11a5855272784911a3823fc2ff8F79F` (a project-only test account) in 18
transactions, costing 0.0124 Sepolia ETH at about 1.1 gwei. All seven contracts are verified on Etherscan and
Sourcify. Addresses are in `deployments/11155111.json`; the transaction record is in `contracts/broadcast/`.
That deployment was made before the zero-knowledge edition was removed, so it also contains that edition's two
contracts (ClearingVerifier and ObscuraAuctionZK). They stay on Sepolia, but nothing in this version uses them.

| Contract | Address |
|---|---|
| TKN (MockERC20) | [0xFeE1a32C43aF0f1aCaa03696bA5Cd54a03c96820](https://sepolia.etherscan.io/address/0xFeE1a32C43aF0f1aCaa03696bA5Cd54a03c96820#code) |
| mUSD (MockERC20) | [0xA7C4e40E54EE2EDfd066e5219ebF5de2638e4021](https://sepolia.etherscan.io/address/0xA7C4e40E54EE2EDfd066e5219ebF5de2638e4021#code) |
| SimpleAMM | [0x8228d8936825C81861642e598af0acAC1b638d61](https://sepolia.etherscan.io/address/0x8228d8936825C81861642e598af0acAC1b638d61#code) |
| ObscuraAuction | [0x81854dc3F454861666775c2bDBC25FE88C2CA1E3](https://sepolia.etherscan.io/address/0x81854dc3F454861666775c2bDBC25FE88C2CA1E3#code) |
| InvariantBounty | [0xce702a588F9500a88cA10207537B438bf5dBac61](https://sepolia.etherscan.io/address/0xce702a588F9500a88cA10207537B438bf5dBac61#code) |
| ClearingVerifier | [0xced41ee853A886EF3b73581fc60335832f7512b4](https://sepolia.etherscan.io/address/0xced41ee853A886EF3b73581fc60335832f7512b4#code) |
| ObscuraAuctionZK | [0x127FDc54e93eFEeE20a03C71CC741c8d50E00f04](https://sepolia.etherscan.io/address/0x127FDc54e93eFEeE20a03C71CC741c8d50E00f04#code) |

Checked on-chain after deploying: the AMM pool holds 100,000 TKN and 10,000,000 mUSD (price 100), each auction's
fee pool holds 100,000 mUSD, and the bounty vault holds 10,000 mUSD. The website, with no wallet connected and no
local chain running, reads the Sepolia vault (10,000.00 mUSD).

### Going live on Sepolia (your steps)

1. In MetaMask, create a **new account used only for this project**. Never a personal wallet.
2. Get **0.1 to 0.3 Sepolia ETH** for it from a faucet (for example Google Cloud's Web3 faucet). The rehearsal
   used 15 M gas, about 0.03 ETH at typical Sepolia prices; the rest pays for solver transactions.
3. Create a free **Alchemy** app on Sepolia and copy its HTTPS URL; create an **Etherscan** API key.
4. Copy `.env.example` to `.env` and fill in `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (exported from that
   MetaMask account) and `ETHERSCAN_API_KEY`. Never commit `.env`, never paste it anywhere.
5. `npm run deploy:sepolia -- --dry-run` (rehearsal), then `npm run deploy:sepolia`. Commit the new
   `deployments/11155111.json`.
6. `npm run sepolia:services` to run the solver, and `npm run web`. In MetaMask switch to Sepolia; visitors
   press **Get test tokens** on the site, since anyone can mint the test tokens.

On Sepolia a batch takes about 2 minutes (11 blocks of 12 s). Trade from a MetaMask account other than the
deployer: the deployer is also the solver, and its transactions would compete with yours.

### Trading alone: the market maker

A batch needs a buyer and a seller. Locally the six simulated traders provide them; on Sepolia,
`sepolia:services` runs a market maker instead, so one person can trade alone and still be filled.

- It wakes up when someone else commits to a batch, and in that same batch quotes 100 TKN each side, 0.5%
  either side of the AMM price (99.50 and 100.50 while the pool sits at 100). It keeps quoting for the next
  two batches, then goes quiet. While nobody trades it sends nothing, so it costs nothing.
- Its buy and sell never cross each other, so it only trades with other people, at the auction's price. A buy
  with a limit of 100.50 or more, or a sell at 99.50 or less, is filled.
- It uses two accounts derived from the deployer's key (one buys, one sells), topped up with 0.01 ETH each
  when low.
- It needs your order early enough in the commit window to answer in the same batch: commit while at least
  two blocks (about 25 s) remain. A later order is not lost; it is refunded unfilled, and the market maker is
  already quoting in the next two batches.

When nothing crosses in a batch, the solver submits nothing (a zero-volume solution would lock a 0.01 ETH bond
and cost gas). The batch settles as voided and every order's funds and bond are released.

The first live order on Sepolia (batch 23) was committed before depositing, so it could not be revealed (a
reveal locks the order's funds from the Obscura balance) and its 0.0005 ETH bond was forfeited. The order
forms now check the free balance and refuse to seal an order it cannot cover, saying how much to deposit.

Tested on a local chain (`packages/harness/test/marketMaker.test.ts`): it sends nothing while nobody else
trades; and a lone buy of 10 TKN at limit 101 is filled at the market maker's ask (100.50).

## Conventions

- `main` always passes its tests. Work on a branch, open a pull request, get one review.
- Secrets live only in `.env` (copy `.env.example`). Never commit it, never paste keys into chat,
  and use a wallet made only for this project.
- Solidity: `forge fmt`, NatSpec on public functions, custom errors.
- TypeScript: strict mode, Prettier.
