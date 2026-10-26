/**
 * Shared network configuration re-exported from blindrelay.ts.
 * Both the browser app (via blindrelay.ts) and agent scripts import from here.
 *
 * This file is a thin re-export — it contains NO values of its own.
 * All chain facts live in blindrelay.ts (TESTNET_CONFIG / MAINNET_CONFIG).
 *
 * To switch all of the app AND both agent scripts between testnet and mainnet:
 *   Change ACTIVE_ENV in src/lib/blindrelay.ts — that's the only line to edit.
 *
 * Agent scripts consume:
 *   import { ACTIVE_ENV, CHAIN_CONFIG } from '../src/lib/network-config'
 *   NET.rpcUrl               → RPC endpoint
 *   NET.explorerBase         → Explorer base URL
 *   NET.usdcAddress          → USDC contract
 *   NET.blindRelayAuctionAddress → BlindRelayAuction contract
 *   NET.taskEscrowAddress    → TaskEscrow contract
 *   NET.viemChain            → viem chain object
 */

export type { Env } from './blindrelay'
export { ACTIVE_ENV, CHAIN_CONFIG } from './blindrelay'
