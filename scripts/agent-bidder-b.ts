#!/usr/bin/env bun
/**
 * agent-bidder-b — same as agent-bidder-a but reads BIDDER_B_PRIVATE_KEY.
 *
 * Usage (PowerShell):
 *   $env:BIDDER_B_PRIVATE_KEY="0x..."
 *   bun run scripts/agent-bidder-b.ts --auction 0 --price 75
 *
 * Usage (bash):
 *   BIDDER_B_PRIVATE_KEY=0x... bun run scripts/agent-bidder-b.ts --auction 0 --price 75
 *
 * Required env var:
 *   BIDDER_B_PRIVATE_KEY   0x-prefixed 32-byte private key.
 *
 * CLI args:
 *   --auction <id>         Auction ID to bid on (required).
 *   --price   <usdc>       Bid price in USDC (required).
 *
 * See agent-bidder-a.ts for full documentation.
 */

import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createRequire } from 'module'
import { existsSync, readFileSync, writeFileSync } from 'fs'
// ─── Network config (single source of truth) ──────────────────────────────
// All chain facts come from src/lib/blindrelay.ts (TESTNET_CONFIG / MAINNET_CONFIG).
// To switch testnet ↔ mainnet for BOTH the app and all agent scripts,
// change ACTIVE_ENV in src/lib/blindrelay.ts — that is the only line to edit.
import { CHAIN_CONFIG } from '../src/lib/network-config'

const require = createRequire(import.meta.url)
const BRA_ABI = require('../contracts/abi/BlindRelayAuction.json') as unknown[]
const ERC20_ABI = [
  { type: 'function', name: 'approve',   inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

const CONTRACTS   = { blindRelayAuction: CHAIN_CONFIG.blindRelayAuctionAddress, usdc: CHAIN_CONFIG.usdcAddress }
const DEFAULT_RPC = CHAIN_CONFIG.rpcUrl
const CHAIN       = CHAIN_CONFIG.viemChain
const EXPLORER    = CHAIN_CONFIG.explorerBase
const USDC_DECIMALS = 6

function parseArgs(): { auctionId: bigint; price: bigint } {
  const args = process.argv.slice(2)
  let auctionRaw: string | undefined
  let priceRaw: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--auction' && args[i + 1]) auctionRaw = args[++i]
    if (args[i] === '--price'   && args[i + 1]) priceRaw   = args[++i]
  }
  if (!auctionRaw || !priceRaw) {
    console.error('Usage: bun run scripts/agent-bidder-b.ts --auction <id> --price <usdc>')
    process.exit(1)
  }
  return {
    auctionId: BigInt(auctionRaw),
    price: BigInt(Math.round(parseFloat(priceRaw) * 10 ** USDC_DECIMALS)),
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1) }
  return v
}

const PRIVATE_KEY = requireEnv('BIDDER_B_PRIVATE_KEY') as `0x${string}`
const RPC_URL = process.env['RPC_URL'] ?? DEFAULT_RPC
const { auctionId: AUCTION_ID, price: BID_PRICE_RAW } = parseArgs()

const account      = privateKeyToAccount(PRIVATE_KEY)
const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) })

console.log(`\n[agent-bidder-b] Wallet:    ${account.address}`)
console.log(`[agent-bidder-b] Auction:   #${AUCTION_ID}`)
console.log(`[agent-bidder-b] Bid price: ${Number(BID_PRICE_RAW) / 10 ** USDC_DECIMALS} USDC`)

const SALT_FILE = `scripts/.agent-salt-b-${AUCTION_ID}.json`

interface SaltRecord { salt: `0x${string}`; price: string; auctionId: string; bidder: string }

function loadSaltFile(): SaltRecord | null {
  if (!existsSync(SALT_FILE)) return null
  try { return JSON.parse(readFileSync(SALT_FILE, 'utf8')) as SaltRecord } catch { return null }
}

function saveSaltFile(record: SaltRecord) {
  writeFileSync(SALT_FILE, JSON.stringify(record, null, 2))
  console.log(`  [salt] saved to ${SALT_FILE}`)
}

async function waitForTx(hash: `0x${string}`, label: string) {
  console.log(`  [${label}] tx sent: ${EXPLORER}/tx/${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status === 'reverted') { console.error(`  [${label}] REVERTED`); process.exit(1) }
  console.log(`  [${label}] confirmed in block ${receipt.blockNumber}`)
  return receipt
}

function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

function computeCommitment(
  contractAddress: `0x${string}`, chainId: bigint, auctionId: bigint,
  bidder: `0x${string}`, price: bigint, salt: `0x${string}`,
): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
    [contractAddress, chainId, auctionId, bidder, price, salt],
  ))
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const txHashes: Record<string, `0x${string}`> = {}

  const auction = await publicClient.readContract({
    address: CONTRACTS.blindRelayAuction, abi: BRA_ABI,
    functionName: 'getAuction', args: [AUCTION_ID],
  }) as { bondAmount: bigint; budget: bigint; status: number; commitEnd: bigint; revealEnd: bigint }

  if (auction.status !== 0) { console.error('Auction is not Active.'); process.exit(1) }
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (now >= auction.commitEnd) { console.error('Commit phase has ended.'); process.exit(1) }
  if (BID_PRICE_RAW > auction.budget) { console.error('Bid price exceeds budget'); process.exit(1) }

  const bondAmount = auction.bondAmount
  console.log(`  Bond required: ${Number(bondAmount) / 10 ** USDC_DECIMALS} USDC`)

  // ── Step 1: approve bond if allowance insufficient ───────────────────────
  const allowance = await publicClient.readContract({
    address: CONTRACTS.usdc, abi: ERC20_ABI,
    functionName: 'allowance', args: [account.address, CONTRACTS.blindRelayAuction],
  })

  if (allowance < bondAmount) {
    console.log(`\n[1/4] Approving bond (current allowance: ${Number(allowance) / 10 ** USDC_DECIMALS} USDC)`)
    const approveHash = await walletClient.writeContract({
      address: CONTRACTS.usdc, abi: ERC20_ABI,
      functionName: 'approve', args: [CONTRACTS.blindRelayAuction, bondAmount],
    })
    txHashes['approve'] = approveHash
    await waitForTx(approveHash, 'approve')
  } else {
    console.log(`\n[1/4] Bond already approved — skipping`)
  }

  // ── Step 2: commit — reload salt if file exists, then verify on-chain ──
  let salt: `0x${string}`
  const existing    = loadSaltFile()
  const saltFromFile = existing && existing.bidder.toLowerCase() === account.address.toLowerCase()
    ? existing.salt : null

  if (saltFromFile) {
    const bidRecord = await publicClient.readContract({
      address: CONTRACTS.blindRelayAuction,
      abi: [{ type: 'function', name: 'getBid', inputs: [{ name: 'auctionId', type: 'uint256' }, { name: 'bidder', type: 'address' }], outputs: [{ name: 'commitment', type: 'bytes32' }, { name: 'committedAt', type: 'uint64' }, { name: 'price', type: 'uint256' }, { name: 'revealed', type: 'bool' }], stateMutability: 'view' }],
      functionName: 'getBid',
      args: [AUCTION_ID, account.address],
    }) as unknown as { commitment: `0x${string}`; committedAt: bigint }
    const isZero = bidRecord.commitment === '0x0000000000000000000000000000000000000000000000000000000000000000'
    if (!isZero) {
      salt = saltFromFile
      console.log(`\n[2/4] On-chain commitment found — skipping commit`)
      console.log(`  salt:       ${salt}`)
      console.log(`  commitment: ${bidRecord.commitment}`)
    } else {
      salt = saltFromFile
      const commitment = computeCommitment(
        CONTRACTS.blindRelayAuction, BigInt(CHAIN.id), AUCTION_ID, account.address, BID_PRICE_RAW, salt,
      )
      console.log(`\n[2/4] Salt file found but no on-chain commitment — re-committing with saved salt`)
      const commitHash = await walletClient.writeContract({
        address: CONTRACTS.blindRelayAuction, abi: BRA_ABI,
        functionName: 'commitBid', args: [AUCTION_ID, commitment],
      })
      txHashes['commit'] = commitHash
      await waitForTx(commitHash, 'commitBid')
    }
  } else {
    salt = generateSalt()
    const commitment = computeCommitment(
      CONTRACTS.blindRelayAuction, BigInt(CHAIN.id), AUCTION_ID, account.address, BID_PRICE_RAW, salt,
    )
    console.log(`\n[2/4] Committing bid`)
    console.log(`  salt:       ${salt}`)
    console.log(`  commitment: ${commitment}`)
    const commitHash = await walletClient.writeContract({
      address: CONTRACTS.blindRelayAuction, abi: BRA_ABI,
      functionName: 'commitBid', args: [AUCTION_ID, commitment],
    })
    txHashes['commit'] = commitHash
    saveSaltFile({ salt, price: String(BID_PRICE_RAW), auctionId: String(AUCTION_ID), bidder: account.address })
    await waitForTx(commitHash, 'commitBid')
  }

  // ── Step 3: wait for reveal phase ────────────────────────────────────────
  const nowAfterCommit = BigInt(Math.floor(Date.now() / 1000))
  const waitMs = Number((auction.commitEnd - nowAfterCommit + 2n) * 1000n)
  if (waitMs > 0) {
    console.log(`\n[3/4] Waiting ${Math.ceil(waitMs / 1000)}s for reveal phase…`)
    await sleep(waitMs)
  } else {
    console.log(`\n[3/4] Already in reveal phase`)
  }

  const auctionNow = await publicClient.readContract({
    address: CONTRACTS.blindRelayAuction, abi: BRA_ABI,
    functionName: 'getAuction', args: [AUCTION_ID],
  }) as { commitEnd: bigint; revealEnd: bigint }
  const nowReveal = BigInt(Math.floor(Date.now() / 1000))
  if (nowReveal < auctionNow.commitEnd || nowReveal >= auctionNow.revealEnd) {
    console.error('Not in reveal phase — check timing.'); process.exit(1)
  }

  // ── Step 4: reveal ───────────────────────────────────────────────────────
  console.log(`\n[4/4] Revealing bid`)
  const revealHash = await walletClient.writeContract({
    address: CONTRACTS.blindRelayAuction, abi: BRA_ABI,
    functionName: 'revealBid', args: [AUCTION_ID, BID_PRICE_RAW, salt],
  })
  txHashes['reveal'] = revealHash
  await waitForTx(revealHash, 'revealBid')

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  agent-bidder-b — transaction summary                        ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  for (const [label, hash] of Object.entries(txHashes)) {
    console.log(`  ${label.padEnd(10)} ${EXPLORER}/tx/${hash}`)
  }
  console.log(`\n  Salt file: ${SALT_FILE}`)
  console.log(`  Salt:      ${salt}`)
}

main().catch(e => { console.error(e); process.exit(1) })
