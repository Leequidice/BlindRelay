# [App Name]

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

USDC task escrow on Arc. A buyer funds a task with USDC; the provider submits a delivery hash before a deadline; the buyer can accept (pays provider), reject (Disputed, funds locked), or do nothing (anyone can trigger auto-release after the review window). If the provider never delivers, the buyer can reclaim. No admin role — only named buyer and provider control their task.

## Deployed Contracts

### TaskEscrow (v2 — current)
- **Network:** Arc Testnet
- **Address:** `0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d`
- **Explorer:** https://explorer.testnet.arc.io/address/0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d
- **Source verified:** yes (Blockscout)
- **USDC constructor arg:** `0x3600000000000000000000000000000000000000` (Arc Testnet/Mainnet USDC, 6 decimals)
- **Source:** `contracts/TaskEscrow.sol`
- **Design doc:** `contracts/TaskEscrow-design.md`
- **Tests:** `contracts/test/TaskEscrow.t.sol` (56 unit tests) + `contracts/test/TaskEscrowFork.t.sol` (8 fork tests) = 64 total, all passing
- **Constants:** `MAX_REVIEW_WINDOW = 30 days`, `MAX_DEADLINE_HORIZON = 365 days`

### BlindRelayAuction (v4 — current)
- **Network:** Arc Testnet
- **Address:** `0x27bcab80f486030dec9702d287e354a69bab186d`
- **Explorer:** https://explorer.testnet.arc.io/address/0x27bcab80f486030dec9702d287e354a69bab186d
- **Source verified:** not yet — Blockscout testnet API returning "Too many requests" (rate-limited from v3 deploy cycle); retry the verify command below after a few hours
- **Constructor args:** usdc=`0x3600000000000000000000000000000000000000`, escrow=`0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d`
- **Source:** `contracts/BlindRelayAuction.sol`
- **Design doc:** `contracts/BlindRelayAuction-design.md`
- **ABI:** `contracts/abi/BlindRelayAuction.json`
- **Tests:** `contracts/test/BlindRelayAuction.t.sol` (68 unit/fuzz/invariant) + `contracts/test/BlindRelayAuctionFork.t.sol` (7 fork) = 75 total, all passing (140 total across both contracts)
- **Constants:** `MAX_BIDDERS=100`, `GAS_FLOOR=800_000`, `MIN_DURATION=60s`, `MAX_DURATION=7 days`, `MIN_DELIVERY_DURATION=60s`, `MAX_DELIVERY_DURATION=365 days`, `MIN_REVIEW_WINDOW=1s`, `MAX_REVIEW_WINDOW=30 days`
- **Key change:** gas guard moved to AFTER `a.status = Finalized`, BEFORE forceApprove; floor resized 1.5M → 800k (sized from catch-path + 63/64 createTask cost)
- **Verify command:** `forge verify-contract 0x27bcab80f486030dec9702d287e354a69bab186d contracts/BlindRelayAuction.sol:BlindRelayAuction --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ --constructor-args $(cast abi-encode "constructor(address,address)" 0x3600000000000000000000000000000000000000 0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d) --compiler-version 0.8.28 --num-of-optimizations 200 --evm-version paris`

### BlindRelayAuction (v3 — superseded)
- **Network:** Arc Testnet
- **Address:** `0x021a8260652342c5866cacf81a9c0f5921f91f7b`
- **Explorer:** https://explorer.testnet.arc.io/address/0x021a8260652342c5866cacf81a9c0f5921f91f7b

### BlindRelayAuction (v2 — superseded)
- **Network:** Arc Testnet
- **Address:** `0x7c6446cf8107723dc16e45023491f6b7091fd345`
- **Explorer:** https://explorer.testnet.arc.io/address/0x7c6446cf8107723dc16e45023491f6b7091fd345

### BlindRelayAuction (v1 — superseded)
- **Network:** Arc Testnet
- **Address:** `0x7ea51a659e48711bf7c060fd0027ec2f83d08569`
- **Explorer:** https://explorer.testnet.arc.io/address/0x7ea51a659e48711bf7c060fd0027ec2f83d08569

### TaskEscrow (v1 — superseded)
- **Network:** Arc Testnet
- **Address:** `0xbb256a082f76fcb56240873105ae2b9e06c2c6bd`
- **Explorer:** https://explorer.testnet.arc.io/address/0xbb256a082f76fcb56240873105ae2b9e06c2c6bd

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
