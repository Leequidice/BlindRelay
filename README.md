# USDC Task Escrow + Blind Relay Auction

Two-contract USDC escrow system on Arc Testnet. A sealed-bid reverse auction selects the lowest-price provider, then automatically creates a task in an escrow contract. The buyer funds the task with USDC; the provider submits a delivery hash; the buyer accepts, rejects, or lets the review window expire for auto-release.

Built with [Arc Studio](https://studio.arc.io)

## Contracts

| Contract | Address (Arc Testnet) | Explorer |
|---|---|---|
| TaskEscrow | `0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d` | [View](https://explorer.testnet.arc.io/address/0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d) |
| BlindRelayAuction (v4) | `0x27bcab80f486030dec9702d287e354a69bab186d` | [View](https://explorer.testnet.arc.io/address/0x27bcab80f486030dec9702d287e354a69bab186d) |

Both contracts use USDC at `0x3600000000000000000000000000000000000000` (Arc Testnet/Mainnet native predeploy, 6 decimals).

## Tech Stack

- Solidity 0.8.28 + Foundry
- OpenZeppelin Contracts 5.x (`SafeERC20`, `ReentrancyGuard`)
- Arc Testnet (chain ID 5042002) — USDC is the native gas token
- TypeScript integration scripts: viem v2, Bun

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- [Bun](https://bun.sh/) v1.x

## Install

```bash
bun install
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `BUYER_PRIVATE_KEY` | Private key for the buyer wallet (TaskEscrow E2E and Auction E2E) |
| `PROVIDER_PRIVATE_KEY` | Private key for the provider wallet (TaskEscrow E2E) |
| `BIDDER_A_PRIVATE_KEY` | Private key for bidder A (Auction E2E) |
| `BIDDER_B_PRIVATE_KEY` | Private key for bidder B (Auction E2E) |

Copy `.env.example` to `.env` and fill in the values. `.env` is gitignored.

All wallets must hold USDC on Arc Testnet. Use the "Get test USDC" button in Arc Studio's sidebar to fund them.

## Build and Test

```bash
# Compile contracts
bun run contracts:build

# Run all unit + fuzz + invariant tests (140 tests)
bun run contracts:test

# Run with gas report
forge test --gas-report
```

## Integration Scripts

```bash
# TaskEscrow end-to-end (3 scenarios: accept, release, reclaim)
BUYER_PRIVATE_KEY=0x... PROVIDER_PRIVATE_KEY=0x... \
  bun run contracts/test-integration/TaskEscrowE2E.ts

# BlindRelayAuction end-to-end (full auction → delivery → accept)
BUYER_PRIVATE_KEY=0x... BIDDER_A_PRIVATE_KEY=0x... BIDDER_B_PRIVATE_KEY=0x... \
  bun run contracts/test-integration/BlindRelayAuctionE2E.ts
```

## Source Verification

If Blockscout verification needs to be retried:

```bash
forge verify-contract 0x27bcab80f486030dec9702d287e354a69bab186d \
  contracts/BlindRelayAuction.sol:BlindRelayAuction \
  --chain-id 5042002 \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.arc.io/api/ \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x3600000000000000000000000000000000000000 \
    0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d) \
  --compiler-version 0.8.28 \
  --num-of-optimizations 200 \
  --evm-version paris
```
