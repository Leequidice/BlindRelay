/**
 * BlindRelay — single config file for all chain IDs, RPC URLs, contract
 * addresses, and explorer URLs. Switch between testnet and mainnet by
 * changing ACTIVE_ENV at the top.
 *
 * No private keys are ever imported or used in this file.
 */

import { type Abi, encodeAbiParameters, keccak256 } from 'viem'
import { arcTestnet, arc } from 'viem/chains'
import BraAbi from '../../contracts/abi/BlindRelayAuction.json'
import TeAbi from '../../contracts/abi/TaskEscrow.json'

// ─── Environment switch ────────────────────────────────────────────────────
/**
 * Change ACTIVE_ENV to switch ALL of the app and both agent scripts between
 * testnet and mainnet in one place. No other file needs to change.
 *
 * MAINNET DEPLOY ORDER:
 *   1. Deploy TaskEscrow with (usdc = 0x3600000000000000000000000000000000000000)
 *      → record the deployed address as taskEscrowAddress below.
 *   2. Deploy BlindRelayAuction with (usdc = same, escrow = taskEscrowAddress from step 1).
 *      → record as blindRelayAuctionAddress below.
 *   3. Set ACTIVE_ENV = 'mainnet' and rebuild the app.
 *
 * Arc mainnet facts (from https://docs.arc.io):
 *   Chain ID:    5042    (hex: 0x13B2)
 *   RPC URL:     https://rpc.mainnet.arc.io
 *   Explorer:    https://explorer.arc.io
 *   USDC:        0x3600000000000000000000000000000000000000  (same as testnet, 6 decimals)
 *   CCTP domain: 26
 *   Gas token:   USDC (no separate native token)
 *   WebSocket:   wss://rpc.mainnet.arc.io
 *
 * WARNING: Mainnet involves real USDC. Review all addresses carefully before
 * setting ACTIVE_ENV = 'mainnet'. Arc Studio deploys contracts to testnet
 * only; mainnet contracts must be deployed from your own wallet using the
 * self-deploy script or Foundry directly.
 */
export type Env = 'testnet' | 'mainnet'

export const ACTIVE_ENV: Env = 'mainnet'

// ─── Per-environment config ────────────────────────────────────────────────

interface EnvConfig {
  chainId: number
  chainName: string
  rpcUrl: string
  explorerBase: string
  usdcAddress: `0x${string}`
  usdcDecimals: number
  /** Deploy TaskEscrow first, then BlindRelayAuction passing this address as escrow. */
  blindRelayAuctionAddress: `0x${string}`
  taskEscrowAddress: `0x${string}`
  /** Contract constant: minimum gas required at the guard point inside finalize. */
  gasFloor: bigint
  /** viem chain object for this environment. */
  viemChain: typeof arcTestnet | typeof arc
}

const TESTNET_CONFIG: EnvConfig = {
  chainId: arcTestnet.id, // 5042002
  chainName: 'Arc Testnet',
  rpcUrl: 'https://rpc.testnet.arc.io',
  explorerBase: 'https://explorer.testnet.arc.io',
  usdcAddress: '0x3600000000000000000000000000000000000000',
  usdcDecimals: 6,
  blindRelayAuctionAddress: '0x27bcab80f486030dec9702d287e354a69bab186d',
  taskEscrowAddress: '0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d',
  gasFloor: 800_000n,
  viemChain: arcTestnet,
}

/**
 * Mainnet config — fill in contract addresses after deploying, then set
 * ACTIVE_ENV = 'mainnet'. Do not flip the switch before both contracts
 * are live and verified.
 *
 * Arc mainnet chain ID: 5042  |  RPC: https://rpc.mainnet.arc.io
 * Explorer: https://explorer.arc.io
 * USDC: 0x3600000000000000000000000000000000000000 (same as testnet)
 */
const MAINNET_CONFIG: EnvConfig = {
  chainId: arc.id, // 5042
  chainName: 'Arc',
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorerBase: 'https://explorer.arc.io',
  usdcAddress: '0x3600000000000000000000000000000000000000',
  usdcDecimals: 6,
  blindRelayAuctionAddress: '0x4670429744a5e82de77e7251593b25f333b8f802',
  taskEscrowAddress:        '0xd87d260b9284bd2819894859ba877104ee043049',
  gasFloor: 800_000n,
  viemChain: arc,
}

const CONFIGS: Record<Env, EnvConfig> = {
  testnet: TESTNET_CONFIG,
  mainnet: MAINNET_CONFIG,
}

export const CHAIN_CONFIG: EnvConfig = CONFIGS[ACTIVE_ENV]

// ─── ABIs ──────────────────────────────────────────────────────────────────

export const BLIND_RELAY_AUCTION_ABI = BraAbi as Abi
export const TASK_ESCROW_ABI = TeAbi as Abi

// ─── USDC ERC-20 ABI (minimal) ─────────────────────────────────────────────

export const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

// ─── Contract constants (mirrors Solidity) ─────────────────────────────────

export const CONTRACT_CONSTANTS = {
  MIN_DURATION: 60n,            // 60 s
  MAX_DURATION: 604_800n,       // 7 days
  MAX_BIDDERS: 100n,
  MIN_DELIVERY_DURATION: 60n,
  MAX_DELIVERY_DURATION: 31_536_000n, // 365 days
  MIN_REVIEW_WINDOW: 1n,
  MAX_REVIEW_WINDOW: 2_592_000n,      // 30 days
  GAS_FLOOR: CHAIN_CONFIG.gasFloor,
  /** 20% buffer over GAS_FLOOR for the gas estimate check. */
  GAS_ESTIMATE_BUFFER: (CHAIN_CONFIG.gasFloor * 120n) / 100n,
} as const

// ─── Auction status enum ───────────────────────────────────────────────────

export enum AuctionStatus {
  Active = 0,
  Finalized = 1,
  Cancelled = 2,
}

// ─── Task status enum ──────────────────────────────────────────────────────

export enum TaskStatus {
  Funded = 0,
  Delivered = 1,
  Settled = 2,
  Reclaimed = 3,
  Disputed = 4,
}

// ─── Commitment hash ───────────────────────────────────────────────────────

/**
 * Computes the sealed-bid commitment exactly as the Solidity contract does:
 *   keccak256(abi.encode(address(this), block.chainid, auctionId, bidder, price, salt))
 *
 * All parameters must match what was used during commitBid or revealBid will
 * reject the commitment with InvalidReveal.
 */
export function computeCommitment(
  contractAddress: `0x${string}`,
  chainId: bigint,
  auctionId: bigint,
  bidder: `0x${string}`,
  price: bigint,
  salt: `0x${string}`,
): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes32' },
    ],
    [contractAddress, chainId, auctionId, bidder, price, salt],
  )
  return keccak256(encoded)
}

// ─── On-chain result parsers ───────────────────────────────────────────────
//
// viem returns structs as named objects when the ABI has named outputs AND the
// ABI is typed `as const`.  We widen to `Abi` for runtime flexibility, so the
// compiler can't prove the names — call these helpers instead of casting raw
// results directly.  Each one accepts `unknown` and returns a typed object,
// throwing a clear message if the shape is wrong.

export interface Task {
  buyer:        `0x${string}`
  provider:     `0x${string}`
  price:        bigint
  deadline:     bigint
  reviewWindow: bigint
  deliveredAt:  bigint
  status:       number
  deliveryHash: `0x${string}`
}

export interface AuctionRecord {
  buyer:            `0x${string}`
  budget:           bigint
  bondAmount:       bigint
  bestPrice:        bigint
  bestBidder:       `0x${string}`
  commitEnd:        bigint
  revealEnd:        bigint
  deliveryDuration: bigint
  reviewWindow:     bigint
  taskHash:         `0x${string}`
  status:           number
  commitCounter:    number
  bidderCount:      bigint
}

export interface BidRecord {
  commitOrder: number
  hasRevealed: boolean
  commitment:  `0x${string}`
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

/**
 * Maps the raw result from `tasks(id)` to a typed Task object.
 * Accepts both a positional tuple (viem with widened Abi) and a named struct
 * (viem with const Abi).  Throws a descriptive error on unexpected shapes.
 */
export function parseTask(raw: unknown): Task {
  if (raw === null || raw === undefined) throw new Error('parseTask: result is null/undefined')
  // Named object (const Abi path)
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    return {
      buyer:        (r['buyer']        as `0x${string}`) ?? ZERO_ADDR,
      provider:     (r['provider']     as `0x${string}`) ?? ZERO_ADDR,
      price:        (r['price']        as bigint) ?? 0n,
      deadline:     (r['deadline']     as bigint) ?? 0n,
      reviewWindow: (r['reviewWindow'] as bigint) ?? 0n,
      deliveredAt:  (r['deliveredAt']  as bigint) ?? 0n,
      status:       Number(r['status'] ?? 0),
      deliveryHash: (r['deliveryHash'] as `0x${string}`) ?? ('0x' + '00'.repeat(32) as `0x${string}`),
    }
  }
  // Positional tuple (widened Abi path): [buyer, provider, price, deadline, reviewWindow, deliveredAt, status, deliveryHash]
  if (Array.isArray(raw) && raw.length >= 8) {
    return {
      buyer:        (raw[0] as `0x${string}`) ?? ZERO_ADDR,
      provider:     (raw[1] as `0x${string}`) ?? ZERO_ADDR,
      price:        (raw[2] as bigint) ?? 0n,
      deadline:     (raw[3] as bigint) ?? 0n,
      reviewWindow: (raw[4] as bigint) ?? 0n,
      deliveredAt:  (raw[5] as bigint) ?? 0n,
      status:       Number(raw[6] ?? 0),
      deliveryHash: (raw[7] as `0x${string}`) ?? ('0x' + '00'.repeat(32) as `0x${string}`),
    }
  }
  throw new Error(`parseTask: unexpected shape — ${JSON.stringify(raw).slice(0, 120)}`)
}

/**
 * Maps the raw result from `getAuction(id)` to a typed AuctionRecord.
 * Handles both named-object and positional-tuple results.
 * Field order matches the Solidity struct declaration:
 *   buyer, budget, bondAmount, bestPrice, bestBidder, commitEnd, revealEnd,
 *   deliveryDuration, reviewWindow, taskHash, status, commitCounter, bidderCount
 */
export function parseAuction(raw: unknown): AuctionRecord {
  if (raw === null || raw === undefined) throw new Error('parseAuction: result is null/undefined')
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    return {
      buyer:            (r['buyer']            as `0x${string}`) ?? ZERO_ADDR,
      budget:           (r['budget']           as bigint) ?? 0n,
      bondAmount:       (r['bondAmount']       as bigint) ?? 0n,
      bestPrice:        (r['bestPrice']        as bigint) ?? 0n,
      bestBidder:       (r['bestBidder']       as `0x${string}`) ?? ZERO_ADDR,
      commitEnd:        (r['commitEnd']        as bigint) ?? 0n,
      revealEnd:        (r['revealEnd']        as bigint) ?? 0n,
      deliveryDuration: (r['deliveryDuration'] as bigint) ?? 0n,
      reviewWindow:     (r['reviewWindow']     as bigint) ?? 0n,
      taskHash:         (r['taskHash']         as `0x${string}`) ?? ('0x' + '00'.repeat(32) as `0x${string}`),
      status:           Number(r['status']     ?? 0),
      commitCounter:    Number(r['commitCounter'] ?? 0),
      bidderCount:      (r['bidderCount']      as bigint) ?? 0n,
    }
  }
  if (Array.isArray(raw) && raw.length >= 13) {
    return {
      buyer:            (raw[0]  as `0x${string}`) ?? ZERO_ADDR,
      budget:           (raw[1]  as bigint) ?? 0n,
      bondAmount:       (raw[2]  as bigint) ?? 0n,
      bestPrice:        (raw[3]  as bigint) ?? 0n,
      bestBidder:       (raw[4]  as `0x${string}`) ?? ZERO_ADDR,
      commitEnd:        (raw[5]  as bigint) ?? 0n,
      revealEnd:        (raw[6]  as bigint) ?? 0n,
      deliveryDuration: (raw[7]  as bigint) ?? 0n,
      reviewWindow:     (raw[8]  as bigint) ?? 0n,
      taskHash:         (raw[9]  as `0x${string}`) ?? ('0x' + '00'.repeat(32) as `0x${string}`),
      status:           Number(raw[10] ?? 0),
      commitCounter:    Number(raw[11] ?? 0),
      bidderCount:      (raw[12] as bigint) ?? 0n,
    }
  }
  throw new Error(`parseAuction: unexpected shape — ${JSON.stringify(raw).slice(0, 120)}`)
}

/**
 * Maps the raw result from `getBid(auctionId, bidder)` to a typed BidRecord.
 * Solidity return order: (uint32 commitOrder, bool hasRevealed, bytes32 commitment)
 */
export function parseBid(raw: unknown): BidRecord {
  if (raw === null || raw === undefined) throw new Error('parseBid: result is null/undefined')
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    return {
      commitOrder: Number(r['commitOrder'] ?? 0),
      hasRevealed: Boolean(r['hasRevealed']),
      commitment:  (r['commitment'] as `0x${string}`) ?? ('0x' + '00'.repeat(32) as `0x${string}`),
    }
  }
  if (Array.isArray(raw) && raw.length >= 3) {
    return {
      commitOrder: Number(raw[0] ?? 0),
      hasRevealed: Boolean(raw[1]),
      commitment:  (raw[2] as `0x${string}`) ?? ('0x' + '00'.repeat(32) as `0x${string}`),
    }
  }
  throw new Error(`parseBid: unexpected shape — ${JSON.stringify(raw).slice(0, 120)}`)
}

/** Returns true if address is the zero address or missing. */
export function isZeroAddress(addr: string | null | undefined): boolean {
  return !addr || addr === ZERO_ADDR
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function formatUsdc(raw: bigint): string {
  const n = Number(raw) / 10 ** CHAIN_CONFIG.usdcDecimals
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

export function parseUsdc(s: string): bigint {
  // Supports up to usdcDecimals decimal places; truncates excess.
  const [int, frac = ''] = s.trim().replace(/,/g, '').split('.')
  const padded = frac.slice(0, CHAIN_CONFIG.usdcDecimals).padEnd(CHAIN_CONFIG.usdcDecimals, '0')
  return BigInt(int || '0') * 10n ** BigInt(CHAIN_CONFIG.usdcDecimals) + BigInt(padded)
}

export function formatDuration(secs: number): string {
  if (secs < 120) return `${secs}s`
  if (secs < 7200) return `${Math.round(secs / 60)}m`
  if (secs < 172_800) return `${Math.round(secs / 3600)}h`
  return `${Math.round(secs / 86_400)}d`
}

export function formatCountdown(targetTs: number): string {
  const diff = Math.max(0, targetTs - Math.floor(Date.now() / 1000))
  if (diff === 0) return 'ended'
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function buildTxUrl(txHash: string): string {
  return `${CHAIN_CONFIG.explorerBase}/tx/${txHash}`
}

export function buildAddressUrl(address: string): string {
  return `${CHAIN_CONFIG.explorerBase}/address/${address}`
}

/** Phase label derived from on-chain data without a phaseOf call. */
export function derivePhase(
  status: number,
  commitEnd: bigint,
  revealEnd: bigint,
  now: number,
): 'Commit' | 'Reveal' | 'Ended' | 'Finalized' | 'Cancelled' | 'Unknown' {
  if (status === (AuctionStatus.Finalized as number)) return 'Finalized'
  if (status === (AuctionStatus.Cancelled as number)) return 'Cancelled'
  if (now < Number(commitEnd)) return 'Commit'
  if (now < Number(revealEnd)) return 'Reveal'
  return 'Ended'
}
