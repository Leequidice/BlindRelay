import { useState } from 'react'
import { useReadContract, useAccount } from 'wagmi'
import {
  CHAIN_CONFIG,
  BLIND_RELAY_AUCTION_ABI,
  formatUsdc,
  formatAddress,
  derivePhase,
  formatCountdown,
} from '../lib/blindrelay'
import { useNow } from '../lib/useNow'
import { consumePendingHashAuctionId } from '../App'
import {
  Card,
  PageWrapper,
  PageTitle,
  Label,
  Input,
  Button,
  PhaseBadge,
  Row,
  Spinner,
  Alert,
} from '../components/ui'
import { ExternalLink, RefreshCw } from 'lucide-react'

const ARC = CHAIN_CONFIG

// ─── Types ─────────────────────────────────────────────────────────────────

interface AuctionRecord {
  buyer: string
  budget: bigint
  bondAmount: bigint
  bestPrice: bigint
  bestBidder: string
  commitEnd: bigint
  revealEnd: bigint
  deliveryDuration: bigint
  reviewWindow: bigint
  taskHash: string
  status: number
  commitCounter: number
  bidderCount: bigint
}

// ─── RecentAuctions ─────────────────────────────────────────────────────────
// Reads the latest ≤20 auction IDs via auctionCount(), then fetches each via
// getAuction(). No getLogs / block-range queries needed or used.

const PHASE_COLORS: Record<string, string> = {
  Commit:    'text-blue-600',
  Reveal:    'text-violet-600',
  Ended:     'text-slate-400',
  Finalized: 'text-green-600',
  Cancelled: 'text-red-500',
  Unknown:   'text-slate-400',
}

/** One row — fetches its own auction data via getAuction(id). */
function RecentAuctionRow({
  auctionId,
  now,
  onSelect,
}: {
  auctionId: bigint
  now: number
  onSelect: (id: bigint) => void
}) {
  const { data } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getAuction',
    args: [auctionId],
    chainId: ARC.chainId,
  })
  const a = data as AuctionRecord | undefined
  const phase = a ? derivePhase(a.status, a.commitEnd, a.revealEnd, now) : null
  const countdownTarget = a && phase
    ? phase === 'Commit' ? Number(a.commitEnd)
    : phase === 'Reveal' ? Number(a.revealEnd)
    : null
    : null

  return (
    <button
      onClick={() => onSelect(auctionId)}
      className="w-full flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-slate-50
        border border-transparent hover:border-slate-200 transition-all text-left"
    >
      <span className="font-mono text-sm font-bold text-slate-900 w-8 shrink-0">
        #{auctionId.toString()}
      </span>
      {a ? (
        <span className="font-mono text-xs text-slate-500 flex-1 truncate">
          {formatAddress(a.buyer)}
        </span>
      ) : (
        <span className="flex-1 text-xs text-slate-300">loading…</span>
      )}
      {phase && (
        <span className={`text-xs font-semibold w-16 text-right ${PHASE_COLORS[phase] ?? 'text-slate-400'}`}>
          {phase}
        </span>
      )}
      {countdownTarget !== null && (
        <span className="text-xs font-mono text-slate-400 tabular-nums w-20 text-right shrink-0">
          {formatCountdown(countdownTarget)}
        </span>
      )}
    </button>
  )
}

/** Read auctionCount() once; display the last ≤20 IDs. */
function RecentAuctions({
  now,
  onSelect,
}: {
  now: number
  onSelect: (id: bigint) => void
}) {
  const {
    data: countRaw,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'auctionCount',
    chainId: ARC.chainId,
    query: { refetchInterval: 15_000 },
  })

  const count = countRaw !== undefined ? (countRaw as bigint) : null

  // Build array of the last ≤20 auction IDs (newest first)
  const ids: bigint[] = count !== null && count > 0n
    ? Array.from(
        { length: Math.min(20, Number(count)) },
        (_, i) => count - 1n - BigInt(i),
      )
    : []

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">
          Recent auctions
          {count !== null && (
            <span className="ml-2 text-xs font-normal text-slate-400">
              ({count.toString()} total)
            </span>
          )}
        </p>
        <button
          onClick={() => void refetch()}
          disabled={isFetching}
          className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors text-slate-400 hover:text-slate-600 disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-4"><Spinner size={20} /></div>
      )}
      {isError && (
        <Alert variant="warning">Could not load auction count. Check your RPC connection.</Alert>
      )}
      {!isLoading && !isError && count === 0n && (
        <p className="text-sm text-slate-400 text-center py-3">No auctions created yet.</p>
      )}
      {ids.length > 0 && (
        <div>
          <div className="flex items-center gap-3 px-3 pb-1 text-xs text-slate-400 font-medium">
            <span className="w-8">ID</span>
            <span className="flex-1">Buyer</span>
            <span className="w-16 text-right">Phase</span>
            <span className="w-20 text-right">Countdown</span>
          </div>
          {ids.map(id => (
            <RecentAuctionRow
              key={id.toString()}
              auctionId={id}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

// ─── BidderRow ───────────────────────────────────────────────────────────────

function BidderRow({
  auctionId,
  bidder,
  bestBidder,
  status,
}: {
  auctionId: bigint
  bidder: string
  bestBidder: string
  status: number
}) {
  const { data } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getBid',
    args: [auctionId, bidder as `0x${string}`],
    chainId: ARC.chainId,
  })

  const hasRevealed = data ? (data as readonly [unknown, unknown, unknown, boolean])[3] : false
  const isWinner = bidder.toLowerCase() === bestBidder.toLowerCase() && status === 1

  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
      <span className="font-mono text-xs text-slate-700 flex-1">{formatAddress(bidder)}</span>
      <a
        href={`${ARC.explorerBase}/address/${bidder}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-600"
        title="View on explorer"
      >
        <ExternalLink size={12} />
      </a>
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          isWinner
            ? 'bg-green-100 text-green-700'
            : hasRevealed
              ? 'bg-violet-100 text-violet-700'
              : 'bg-slate-100 text-slate-500'
        }`}
      >
        {isWinner ? 'Winner' : hasRevealed ? 'Revealed' : 'Committed'}
      </span>
    </div>
  )
}

// ─── AuctionView (main) ──────────────────────────────────────────────────────

export default function AuctionView() {
  const { address } = useAccount()
  const now = useNow()

  // Consume any auction ID that was set via a hash link (#auction=N).
  // Read once at mount time — consumePendingHashAuctionId clears the value after reading.
  const _initialId = consumePendingHashAuctionId()
  const [idInput,   setIdInput]   = useState<string>(_initialId ?? '')
  const [auctionId, setAuctionId] = useState<bigint | null>(() => {
    if (_initialId === null) return null
    const n = parseInt(_initialId, 10)
    return isNaN(n) ? null : BigInt(n)
  })

  const { data: auction, isLoading, isError } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getAuction',
    args: auctionId !== null ? [auctionId] : undefined,
    chainId: ARC.chainId,
    query: { enabled: auctionId !== null, refetchInterval: 10_000 },
  })

  const { data: bidders } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getBidders',
    args: auctionId !== null ? [auctionId] : undefined,
    chainId: ARC.chainId,
    query: { enabled: auctionId !== null },
  })

  const a = auction as AuctionRecord | undefined
  const phase = a ? derivePhase(a.status, a.commitEnd, a.revealEnd, now) : null

  const countdownTarget = a
    ? phase === 'Commit' ? Number(a.commitEnd)
    : phase === 'Reveal' ? Number(a.revealEnd)
    : null
    : null

  const isMyAuction = a && address && a.buyer.toLowerCase() === address.toLowerCase()

  function handleLookup() {
    const n = parseInt(idInput.trim(), 10)
    if (!isNaN(n) && n >= 0) {
      setAuctionId(BigInt(n))
      // Update hash so URL is shareable
      window.history.replaceState(null, '', `#auction=${n}`)
    }
  }

  function handleSelectFromRecent(id: bigint) {
    setIdInput(id.toString())
    setAuctionId(id)
    window.history.replaceState(null, '', `#auction=${id.toString()}`)
  }

  return (
    <PageWrapper>
      <PageTitle>Auction View</PageTitle>

      {/* Look-up card */}
      <Card className="p-5 space-y-3">
        <Label htmlFor="aid">Auction ID</Label>
        <div className="flex gap-2">
          <Input
            id="aid"
            type="number"
            placeholder="0"
            min="0"
            value={idInput}
            onChange={setIdInput}
          />
          <Button onClick={handleLookup} variant="secondary">
            Load
          </Button>
        </div>
      </Card>

      {isLoading && (
        <div className="flex justify-center py-8">
          <Spinner size={24} />
        </div>
      )}

      {isError && auctionId !== null && (
        <Alert variant="error">Could not load auction {String(auctionId)}.</Alert>
      )}

      {a && phase && (
        <>
          {/* Header */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-400 font-mono">Auction #{String(auctionId)}</p>
                <PhaseBadge phase={phase} />
              </div>
              {countdownTarget !== null && (
                <div className="text-right">
                  <p className="text-xs text-slate-400">
                    {phase === 'Commit' ? 'Commit ends in' : 'Reveal ends in'}
                  </p>
                  <p className="text-lg font-mono font-bold text-slate-900 tabular-nums">
                    {formatCountdown(countdownTarget)}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-0.5">
              <Row label="Buyer" value={
                <a
                  href={`${ARC.explorerBase}/address/${a.buyer}`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-blue-600 hover:underline flex items-center gap-1 justify-end"
                >
                  {formatAddress(a.buyer)}
                  {isMyAuction && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 rounded-full">You</span>}
                  <ExternalLink size={11} />
                </a>
              } />
              <Row label="Budget"   value={`${formatUsdc(a.budget)} USDC`} />
              <Row label="Bond"     value={`${formatUsdc(a.bondAmount)} USDC`} />
              <Row label="Commit ends" value={new Date(Number(a.commitEnd) * 1000).toLocaleString()} />
              <Row label="Reveal ends" value={new Date(Number(a.revealEnd) * 1000).toLocaleString()} />
              <Row label="Delivery window" value={`${Math.round(Number(a.deliveryDuration) / 86400)} days`} />
              <Row label="Review window"   value={`${Math.round(Number(a.reviewWindow) / 86400)} days`} />
              <Row label="Task hash" value={
                <span className="font-mono text-xs break-all">{a.taskHash}</span>
              } />
            </div>
          </Card>

          {/* Winner */}
          {a.status === 1 && a.bestBidder !== '0x0000000000000000000000000000000000000000' && (
            <Card className="p-5 space-y-3">
              <p className="text-sm font-semibold text-green-700">Auction finalized</p>
              <Row label="Winner" value={
                <a
                  href={`${ARC.explorerBase}/address/${a.bestBidder}`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-blue-600 hover:underline flex items-center gap-1 justify-end"
                >
                  {formatAddress(a.bestBidder)} <ExternalLink size={11} />
                </a>
              } />
              <Row label="Winning price" value={`${formatUsdc(a.bestPrice)} USDC`} />
            </Card>
          )}

          {/* Bidders */}
          <Card className="p-5">
            <p className="text-sm font-semibold text-slate-700 mb-3">
              Bidders ({String(a.bidderCount)})
            </p>
            {!bidders || (bidders as string[]).length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center">No bidders yet.</p>
            ) : (
              <div>
                {(bidders as string[]).map((b) => (
                  <BidderRow
                    key={b}
                    auctionId={auctionId!}
                    bidder={b}
                    bestBidder={a.bestBidder}
                    status={a.status}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Recent auctions list — always shown */}
      <RecentAuctions now={now} onSelect={handleSelectFromRecent} />
    </PageWrapper>
  )
}
