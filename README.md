# BlindRelay

Sealed-bid reverse auction with USDC escrow on Arc. Buyers post a task with a budget; bidders
submit sealed bids backed by a refundable bond; the lowest revealed price wins and a TaskEscrow
task is created automatically on-chain. Built with [Arc Studio](https://studio.arc.io).

---

## What it does

- **CreateAuction** — buyer approves and locks a USDC budget; the auction opens a commit phase.
- **CommitBid** — bidders hash their price with a random salt and submit the commitment; bond is locked.
- **RevealBid** — bidders publish their price and salt; the contract verifies the hash.
- **Finalize** — anyone calls `finalize` after the reveal phase; lowest price wins; TaskEscrow task is created; surplus and bonds are credited to pending balances.
- **Withdraw** — each party pulls their pending USDC balance.
- **TaskEscrow** — winner (provider) submits a delivery hash; buyer accepts (pays), rejects (disputes), or auto-release fires after the review window.

---

## Tech stack

- **Contracts**: Solidity 0.8.28, OpenZeppelin 5, Foundry (tests only)
- **Frontend**: React 18, Vite, wagmi v2, viem v2, ConnectKit, Tailwind CSS
- **Scripts**: Bun, viem (no Foundry required for deploy or agent scripts)
- **Chain**: Arc Testnet / Arc Mainnet — USDC is the native gas token

---

## Deployed contracts

### Arc Testnet

| Contract | Address | Explorer |
|---|---|---|
| TaskEscrow | `0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d` | [view](https://explorer.testnet.arc.io/address/0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d) |
| BlindRelayAuction | `0x27bcab80f486030dec9702d287e354a69bab186d` | [view](https://explorer.testnet.arc.io/address/0x27bcab80f486030dec9702d287e354a69bab186d) |

### Arc Mainnet

| Contract | Address | Explorer |
|---|---|---|
| TaskEscrow | `0xd87d260b9284bd2819894859ba877104ee043049` | [view](https://explorer.arc.io/address/0xd87d260b9284bd2819894859ba877104ee043049) |
| BlindRelayAuction | `0x4670429744a5e82de77e7251593b25f333b8f802` | [view](https://explorer.arc.io/address/0x4670429744a5e82de77e7251593b25f333b8f802) |

---

## Prerequisites

- [Bun](https://bun.sh) v1.x
- [Foundry](https://getfoundry.sh) — for running tests **only** (not required for deploy or agent scripts)
- A wallet with Arc Testnet USDC — use the "Get test USDC" button in the Arc Studio sidebar

---

## Environment variables

Set in `.env` (gitignored). Never pass on the command line.

```powershell
$env:DEPLOY_PRIVATE_KEY   = "0x..."   # deployer wallet
$env:BUYER_PRIVATE_KEY    = "0x..."   # E2E and agent scripts
$env:PROVIDER_PRIVATE_KEY = "0x..."   # E2E scripts
$env:BIDDER_A_PRIVATE_KEY = "0x..."   # agent-bidder-a
$env:BIDDER_B_PRIVATE_KEY = "0x..."   # agent-bidder-b
$env:RPC_URL              = "..."     # optional RPC override
```

| Variable | Purpose |
|---|---|
| `DEPLOY_PRIVATE_KEY` | Deployer key for `self-deploy.ts` |
| `BUYER_PRIVATE_KEY` | Buyer key for E2E scripts |
| `PROVIDER_PRIVATE_KEY` | Provider key for E2E scripts |
| `BIDDER_A_PRIVATE_KEY` | Bidder A key for agent scripts |
| `BIDDER_B_PRIVATE_KEY` | Bidder B key for agent scripts |
| `RPC_URL` | Override RPC (optional) |

---

## Development

```powershell
bun install
bun run dev
```

Open the URL shown in the terminal. Connect MetaMask or Rabby to Arc Testnet
(Chain ID 5042002, RPC https://rpc.testnet.arc.io).

### Lint and typecheck

```powershell
bun run check
```

---

## Switch between testnet and mainnet

One change, everything updates. In `src/lib/blindrelay.ts`:

```ts
export const ACTIVE_ENV: Env = 'mainnet'  // was 'testnet'
```

This switches the frontend app, both agent scripts, and the self-deploy script simultaneously.

---

## Contract tests (requires Foundry)

```powershell
forge test -v
forge test --gas-report
forge test --match-path "contracts/test/*.t.sol" --no-match-test "Fork"
```

---

## Deploy (no Foundry required)

### Dry run

```powershell
bun run scripts/self-deploy.ts --dry-run
```

Prints compiler settings and constructor args without sending any transactions.

### Testnet deploy

```powershell
$env:DEPLOY_PRIVATE_KEY = "0x<your-key>"
bun run scripts/self-deploy.ts
```

### Mainnet deploy

```powershell
$env:ACTIVE_ENV = "mainnet"
$env:DEPLOY_PRIVATE_KEY = "0x<your-key>"
bun run scripts/self-deploy.ts
```

The script deploys TaskEscrow first, then BlindRelayAuction (passing the new escrow address).
After success it writes addresses to `deployed-addresses.json` and prints the exact lines to
paste into `src/lib/blindrelay.ts`.

---

## Source verification

**Compiler settings:** solc `0.8.28+commit.7893614a`, EVM `paris`, optimizer 200 runs, viaIR `false`.

Standard JSON input files are committed at `contracts/verify-input/`.
Full step-by-step instructions: `contracts/verify-input/README-verify.md`.

Short version:
1. Open the contract on the explorer.
2. Contract tab → Verify & Publish → Standard JSON Input.
3. Upload `TaskEscrow-standard-input.json` or `BlindRelayAuction-standard-input.json`.

---

## Agent scripts

Automated bidder agents that read from environment variables.

### Run bidder A

```powershell
$env:BIDDER_A_PRIVATE_KEY = "0x<key>"
bun run scripts/agent-bidder-a.ts --auction 0 --price 80
```

### Run bidder B

```powershell
$env:BIDDER_B_PRIVATE_KEY = "0x<key>"
bun run scripts/agent-bidder-b.ts --auction 0 --price 75
```

### Run both in parallel (PowerShell 7+)

```powershell
$env:BIDDER_A_PRIVATE_KEY = "0x<key-a>"
$env:BIDDER_B_PRIVATE_KEY = "0x<key-b>"

$a = Start-Job { bun run scripts/agent-bidder-a.ts --auction 0 --price 80 }
$b = Start-Job { bun run scripts/agent-bidder-b.ts --auction 0 --price 75 }
Receive-Job $a, $b -Wait
```

Each script:
- Checks on-chain allowance before approving the bond (skips approve if already sufficient).
- Saves the salt immediately after commit to `scripts/.agent-salt-<x>-<id>.json`.
- On restart, reads the salt file and checks on-chain commitment before deciding to re-commit.
- Prints every tx hash with an explorer link at the end.

---

## Integration tests (E2E, live testnet)

```powershell
$env:BUYER_PRIVATE_KEY    = "0x<key>"
$env:PROVIDER_PRIVATE_KEY = "0x<key>"
bun run contracts/test-integration/TaskEscrowE2E.ts

$env:BUYER_PRIVATE_KEY    = "0x<key>"
$env:BIDDER_A_PRIVATE_KEY = "0x<key>"
$env:BIDDER_B_PRIVATE_KEY = "0x<key>"
bun run contracts/test-integration/BlindRelayAuctionE2E.ts
```

---

## Mainnet runbook

> **Warning:** mainnet transactions involve real USDC and are irreversible.
> Use testnet first. Have both contracts independently audited before mainnet.
> The `reject` action permanently locks funds (disputed state has no on-chain resolution in v1).
> Do NOT call `reject` on mainnet.

### Small-amount test: budget 2 USDC, bond 0.5 USDC, 3-minute windows

**Step 1 — Deploy**

```powershell
$env:ACTIVE_ENV = "mainnet"
$env:DEPLOY_PRIVATE_KEY = "0x<your-key>"
bun run scripts/self-deploy.ts --dry-run    # inspect first
bun run scripts/self-deploy.ts              # deploy
```

Copy the printed addresses into `src/lib/blindrelay.ts` (`MAINNET_CONFIG`) and into
`src/lib/network-config.ts`. Set `ACTIVE_ENV = 'mainnet'` in `blindrelay.ts`.

**Step 2 — Verify both contracts**

Upload `contracts/verify-input/TaskEscrow-standard-input.json` and
`contracts/verify-input/BlindRelayAuction-standard-input.json` to the Blockscout
"Verify & Publish" page on https://explorer.arc.io using Standard JSON Input.

**Step 3 — Full flow (small amounts)**

1. Open the app. Connect a mainnet wallet with > 2.5 USDC.
2. **Create** — budget 2 USDC, bond 0.5 USDC, 3-minute commit phase, 3-minute reveal phase,
   1-day delivery window, 1-hour review window.
3. **Commit (bidder A)** — generate salt, save it, approve 0.5 USDC, commit at price 1.80 USDC.
4. **Commit (bidder B)** — approve 0.5 USDC, commit at price 1.60 USDC.
5. Wait 3 minutes for reveal phase.
6. **Reveal both bidders** — each reveals price + salt. Bidder B wins (lower price).
7. Wait 3 minutes for reveal phase to end.
8. **Finalize** — anyone calls finalize. TaskEscrow task #N is created.
   Bidder A gets 0.5 USDC bond back; buyer gets 0.40 USDC surplus (2.00 − 1.60) back;
   bidder B gets 0.5 USDC bond back.
9. **Withdraw** — each party calls withdraw to receive pending USDC.
10. **Task tab** — enter the task ID. Bidder B (provider) submits a delivery hash.
11. Buyer reviews and clicks **Accept delivery** (pays provider 1.60 USDC).
    *(Do NOT click Reject — this permanently disputes and locks funds.)*

---

## Known limitations

- **Disputed funds are permanently locked.** The `reject` action sets the task to Disputed with no
  on-chain resolution path in v1. Never call it on mainnet unless you intend to lock the funds.
- **100-bidder cap.** The `finalize` loop is bounded to 100 bidders. Auctions with exactly 100
  bidders consume ~2.5 M gas at finalize.
- **Shill bidding.** A buyer could bid on their own auction to inflate the apparent demand or
  force a specific winner. The contract prevents the buyer from committing a bid, but a buyer
  controlling a second wallet is not prevented.
- **Blacklisted USDC recipients.** If the winning bidder or buyer is on the USDC blocklist, all
  USDC transfers to their address will revert and their funds will be stuck. There is no recovery
  path for blacklisted addresses.
- **No audit.** These contracts have not been independently audited. Use on mainnet at your own risk.

---

## Project layout

```
contracts/
  BlindRelayAuction.sol      sealed-bid reverse auction
  TaskEscrow.sol             USDC task escrow
  abi/                       committed ABI files
  bytecode/                  compiled bytecode + compiler settings
  verify-input/              standard JSON input for source verification
  test/                      Foundry unit + fork tests (140 tests)
  test-integration/          E2E scripts (live testnet)
src/
  lib/
    blindrelay.ts            ALL chain config + ABIs — change ACTIVE_ENV here
    network-config.ts        config re-export for agent scripts
  pages/                     six app pages
  components/                shared UI + ErrorBoundary
scripts/
  self-deploy.ts             deploy both contracts with viem (no Foundry)
  agent-bidder-a.ts          automated bidder A
  agent-bidder-b.ts          automated bidder B
```
