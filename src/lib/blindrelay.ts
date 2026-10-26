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

export const ACTIVE_ENV: Env = 'testnet'

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
  // TODO: fill these in after mainnet deploy (TaskEscrow first, then BlindRelayAuction)
  blindRelayAuctionAddress: '0x0000000000000000000000000000000000000000',
  taskEscrowAddress:        '0x0000000000000000000000000000000000000000',
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
