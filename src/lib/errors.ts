/**
 * Parses contract revert errors and wallet errors into user-friendly strings.
 * Handles custom BlindRelayAuction and TaskEscrow errors by name.
 */

import { type Abi, decodeErrorResult } from 'viem'
import { BLIND_RELAY_AUCTION_ABI, TASK_ESCROW_ABI, buildTxUrl } from './blindrelay'

const KNOWN_ERRORS: Record<string, string> = {
  // BlindRelayAuction
  InsufficientGasForFinalize:
    'Finalize needs more gas. Increase the gas limit in your wallet (at least 1.2 M recommended).',
  NotActive: 'This auction is no longer active.',
  NotCommitPhase: 'The commit phase for this auction has ended.',
  NotRevealPhase: 'The reveal phase is not open — check the auction timer.',
  RevealNotEnded: 'The reveal phase has not ended yet.',
  BuyerCannotBid: 'The auction buyer cannot submit a bid.',
  AlreadyCommitted: 'You have already committed a bid to this auction.',
  AlreadyRevealed: 'You have already revealed your bid.',
  NotCommitted: 'No commitment found for your address in this auction.',
  InvalidReveal: 'Reveal failed — the price or salt does not match your original commitment.',
  ZeroBidPrice: 'Bid price must be greater than zero.',
  PriceTooHigh: 'Bid price exceeds the auction budget.',
  TooManyBidders: 'This auction has reached its maximum number of bidders.',
  NothingToWithdraw: 'You have no pending balance to withdraw.',
  ZeroBudget: 'Budget must be greater than zero.',
  ZeroBond: 'Bond amount must be greater than zero.',
  DurationOutOfRange: 'Commit or reveal duration is out of the allowed range (60s – 7 days).',
  DeliveryDurationTooShort: 'Delivery duration must be at least 60 seconds.',
  DeliveryDurationTooLong: 'Delivery duration must be at most 365 days.',
  ReviewWindowTooShort: 'Review window must be at least 1 second.',
  ReviewWindowTooLong: 'Review window must be at most 30 days.',
  // TaskEscrow
  NotBuyer: 'Only the task buyer can perform this action.',
  NotProvider: 'Only the task provider can perform this action.',
  NotFunded: 'Task is not in the Funded state.',
  NotDelivered: 'Task has not been delivered yet.',
  DeadlinePassed: 'The delivery deadline has passed.',
  DeadlineNotPassed: 'The delivery deadline has not passed yet.',
  ReviewWindowExpired: 'The review window for this delivery has expired.',
  ReviewWindowNotExpired: 'The review window has not expired yet.',
  ZeroPrice: 'Task price must be greater than zero.',
  ZeroReviewWindow: 'Review window must be greater than zero.',
  DeadlineInPast: 'Deadline is in the past.',
  DeadlineTooFar: 'Deadline is too far in the future (max 365 days).',
  BuyerProviderSame: 'Buyer and provider cannot be the same address.',
}

/** Turn a wagmi/viem write error into a user-facing string. Returns '' on user cancellation. */
export function parseOnchainError(error: unknown): string {
  if (!error) return 'Unknown error.'
  const msg = (error as { message?: string })?.message ?? JSON.stringify(error)

  // Custom error name match
  for (const [name, friendly] of Object.entries(KNOWN_ERRORS)) {
    if (msg.includes(name)) return friendly
  }

  const lower = msg.toLowerCase()
  if (lower.includes('user rejected') || lower.includes('user denied') || lower.includes('4001')) {
    return '' // silent — user cancelled
  }
  if (lower.includes('insufficient funds') || lower.includes('exceeds balance')) {
    return 'Insufficient USDC balance. Check your balance and allowance.'
  }
  if (lower.includes('saferc20')) {
    return 'USDC transfer failed. Make sure you have approved enough USDC.'
  }
  if (lower.includes('network') || lower.includes('timeout')) {
    return 'Network error. Check your connection and retry.'
  }
  if (lower.includes('reverted')) {
    const reasonMatch = msg.match(/reason="([^"]+)"/)
    if (reasonMatch) return `Transaction failed: ${reasonMatch[1]}`
    return 'Transaction reverted. Check your inputs and try again.'
  }
  return 'Something went wrong. Please try again.'
}

/**
 * Try to decode a revert from raw returnData bytes.
 * Tries BRA ABI first, then TaskEscrow ABI, then falls back to a raw hex display.
 */
function tryDecodeRevert(data: `0x${string}`): string {
  const abis: Abi[] = [BLIND_RELAY_AUCTION_ABI, TASK_ESCROW_ABI]
  for (const abi of abis) {
    try {
      const result = decodeErrorResult({ abi, data })
      const friendly = KNOWN_ERRORS[result.errorName]
      if (friendly) return friendly
      const argsStr = result.args && result.args.length > 0
        ? ` (${result.args.map(String).join(', ')})`
        : ''
      return `${result.errorName}${argsStr}`
    } catch {
      // try next ABI
    }
  }
  return `Reverted with data: ${data.slice(0, 34)}…`
}

/** Receipt status variants returned by this function. */
export type ReceiptOutcome =
  | { ok: true }
  | { ok: false; message: string; txHash: string; txUrl: string }

/**
 * Inspect a transaction receipt.
 * Returns { ok: true } if status === 'success'.
 * Returns { ok: false, message, txHash, txUrl } on revert so the caller can
 * show the decoded error and a link to the explorer transaction.
 */
export function checkReceipt(receipt: {
  status: 'success' | 'reverted'
  transactionHash: `0x${string}`
}): ReceiptOutcome {
  if (receipt.status === 'success') return { ok: true }

  const txHash = receipt.transactionHash
  const txUrl  = buildTxUrl(txHash)
  // We don't have returnData from the receipt alone (viem doesn't expose it there),
  // so fall back to a clear "reverted" message with the explorer link.
  return {
    ok: false,
    message: 'Transaction was mined but reverted on-chain.',
    txHash,
    txUrl,
  }
}

/**
 * Decode a revert that we caught via simulation/estimateGas.
 * The error object may carry `cause.data` (viem ContractFunctionRevertedError).
 */
export function decodeRevertError(error: unknown): string {
  try {
    // viem wraps revert data in error.cause.data
    const data = (error as { cause?: { data?: `0x${string}` } })?.cause?.data
    if (data && data.startsWith('0x') && data.length > 10) {
      return tryDecodeRevert(data)
    }
    // Some versions put it at error.data
    const data2 = (error as { data?: `0x${string}` })?.data
    if (data2 && data2.startsWith('0x') && data2.length > 10) {
      return tryDecodeRevert(data2)
    }
  } catch {
    // fall through
  }
  return parseOnchainError(error)
}
