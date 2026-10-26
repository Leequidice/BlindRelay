/**
 * Local salt storage — persists bid salts in localStorage keyed by
 * `blindrelay:salt:{chainId}:{auctionId}:{bidderAddress}`.
 *
 * Salts are stored as 0x-prefixed hex strings (32 bytes = 64 hex chars).
 * Nothing here touches private keys.
 */

import { CHAIN_CONFIG } from './blindrelay'

function key(auctionId: string | bigint, bidder: string): string {
  return `blindrelay:salt:${CHAIN_CONFIG.chainId}:${auctionId}:${bidder.toLowerCase()}`
}

export function saveSalt(auctionId: string | bigint, bidder: string, salt: `0x${string}`): void {
  try {
    localStorage.setItem(key(auctionId, bidder), salt)
  } catch {
    // Storage quota exceeded or private browsing — silently ignore
  }
}

export function loadSalt(auctionId: string | bigint, bidder: string): `0x${string}` | null {
  try {
    const v = localStorage.getItem(key(auctionId, bidder))
    if (v && v.startsWith('0x') && v.length === 66) return v as `0x${string}`
    return null
  } catch {
    return null
  }
}

export function clearSalt(auctionId: string | bigint, bidder: string): void {
  try {
    localStorage.removeItem(key(auctionId, bidder))
  } catch {
    // ignore
  }
}

/** Returns a cryptographically random 32-byte salt as a 0x-prefixed hex string. */
export function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}
