import { useState, useEffect, useCallback } from 'react'
import { useReadContract, useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import {
  CHAIN_CONFIG,
  BLIND_RELAY_AUCTION_ABI,
  TASK_ESCROW_ABI,
  parseAuction,
  parseBid,
  parseTask,
  type AuctionRecord,
  isZeroAddress,
  formatUsdc,
  formatAddress,
  derivePhase,
  formatCountdown,
} from '../lib/blindrelay'
import { useNow } from '../lib/useNow'
import { consumePendingHashAuctionId, setPendingTaskId } from '../App'
import { parseOnchainError, checkReceipt, decodeRevertError } from '../lib/errors'
import { toast } from 'sonner'
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
  TxLink,
} from '../components/ui'
import { ExternalLink, RefreshCw } from 'lucide-react'

const ARC = CHAIN_CONFIG
const ZERO = '0x0000000000000000000000000000000000000000'

// ─── Task-ID scan ─────────────────────────────────────────────────────────────
//
// We cannot use eth_getLogs over a wide range (Arc RPC rejects > ~9,000 blocks).
// Instead: read taskCount(), then walk the last 50 tasks backwards and match on
// (buyer == auction.buyer, provider == auction.bestBidder, price == auction.bestPrice,
//  task.deadline - auction.deliveryDuration >= auction.revealEnd).
//
// If the finalize happened in THIS browser session the receipt is cached in
// sessionStorage under "finalize-task:<auctionAddr>:<auctionId>".

const SESSION_KEY = (auctionId: bigint) =>
  `finalize-task:${ARC.blindRelayAuctionAddress}:${auctionId.toString()}`

export function cacheTaskIdForAuction(auctionId: bigint, taskId: bigint): void {
  try { sessionStorage.setItem(SESSION_KEY(auctionId), taskId.toString()) } catch { /* ignore */ }
}

function readCachedTaskId(auctionId: bigint): bigint | null {
  try {
    const s = sessionStorage.getItem(SESSION_KEY(auctionId))
    if (!s) return null
    const n = parseInt(s, 10)
    return isNaN(n) ? null : BigInt(n)
  } catch { return null }
}

// ─── RecentAuctions ───────────────────────────────────────────────────────────

const PHASE_COLORS: Record<string, string> = {
  Commit:    'text-blue-600',
  Reveal:    'text-violet-600',
  Ended:     'text-slate-400',
  Finalized: 'text-green-600',
  Cancelled: 'text-red-500',
  Unknown:   'text-slate-400',
}

function RecentAuctionRow({
  auctionId, now, onSelect,
}: { auctionId: bigint; now: number; onSelect: (id: bigint) => void }) {
  const { data } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getAuction',
    args: [auctionId],
    chainId: ARC.chainId,
  })
  const a: AuctionRecord | null = (() => {
    if (data === undefined) return null
    try { return parseAuction(data) } catch { return null }
  })()
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

function RecentAuctions({
  now, onSelect,
}: { now: number; onSelect: (id: bigint) => void }) {
  const {
    data: countRaw, isLoading, isError, refetch, isFetching,
  } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'auctionCount',
    chainId: ARC.chainId,
    query: { refetchInterval: 15_000 },
  })

  const count = countRaw !== undefined ? (countRaw as bigint) : null
  const ids: bigint[] = count !== null && count > 0n
    ? Array.from({ length: Math.min(20, Number(count)) }, (_, i) => count - 1n - BigInt(i))
    : []

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">
          Recent auctions
          {count !== null && (
            <span className="ml-2 text-xs font-normal text-slate-400">({count.toString()} total)</span>
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
      {isLoading && <div className="flex justify-center py-4"><Spinner size={20} /></div>}
      {isError  && <Alert variant="warning">Could not load auction count.</Alert>}
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
            <RecentAuctionRow key={id.toString()} auctionId={id} now={now} onSelect={onSelect} />
          ))}
        </div>
      )}
    </Card>
  )
}

// ─── BidderRow ────────────────────────────────────────────────────────────────

function BidderRow({
  auctionId, bidder, bestBidder, status, isMe,
}: {
  auctionId: bigint; bidder: string; bestBidder: string; status: number; isMe: boolean
}) {
  const { data } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getBid',
    args: [auctionId, bidder as `0x${string}`],
    chainId: ARC.chainId,
  })

  const bid = (() => { try { return data !== undefined ? parseBid(data) : null } catch { return null } })()
  const hasRevealed = bid?.hasRevealed ?? false
  const isWinner = !isZeroAddress(bestBidder) && bidder.toLowerCase() === bestBidder.toLowerCase() && status === 1

  return (
    <div className={`flex items-center gap-3 py-2 border-b border-slate-100 last:border-0 ${isWinner ? 'bg-green-50/60 rounded-xl px-2' : ''}`}>
      <span className="font-mono text-xs text-slate-700 flex-1">
        {formatAddress(bidder)}
        {isMe && <span className="ml-1.5 text-xs bg-blue-100 text-blue-700 px-1 rounded-full">You</span>}
      </span>
      <a
        href={`${ARC.explorerBase}/address/${bidder}`}
        target="_blank" rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-600"
        title="View on explorer"
      >
        <ExternalLink size={12} />
      </a>
      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
        isWinner        ? 'bg-green-100 text-green-700'
        : hasRevealed   ? 'bg-violet-100 text-violet-700'
        :                 'bg-slate-100 text-slate-500'
      }`}>
        {isWinner ? '🏆 Winner' : hasRevealed ? 'Revealed' : 'Committed'}
      </span>
    </div>
  )
}

// ─── Task-ID scan hook ────────────────────────────────────────────────────────
//
// Reads taskCount(), then walks tasks backwards (up to 50) looking for the
// task that matches this finalized auction.  Falls back gracefully to null.

function useTaskIdForAuction(
  a: AuctionRecord | null,
  auctionId: bigint | null,
): { taskId: bigint | null; scanning: boolean; noMatch: boolean } {
  const [taskId,  setTaskId]  = useState<bigint | null>(null)
  const [scanning, setScanning] = useState(false)
  const [noMatch,  setNoMatch]  = useState(false)
  const publicClient = usePublicClient()

  const scan = useCallback(async () => {
    if (!a || a.status !== 1 || isZeroAddress(a.bestBidder) || auctionId === null) return

    // 1. Check sessionStorage first (set by this browser when finalize was sent)
    const cached = readCachedTaskId(auctionId)
    if (cached !== null) { setTaskId(cached); return }

    // 2. Scan taskCount() + tasks(i)
    if (!publicClient) return
    setScanning(true)
    setNoMatch(false)
    try {
      const countRaw = await publicClient.readContract({
        address: ARC.taskEscrowAddress,
        abi: TASK_ESCROW_ABI,
        functionName: 'taskCount',
      }) as bigint

      const scanLimit = 50n
      const start = countRaw > 0n ? countRaw - 1n : 0n
      const end   = countRaw > scanLimit ? countRaw - scanLimit : 0n

      for (let i = start; i >= end; i--) {
        const raw = await publicClient.readContract({
          address: ARC.taskEscrowAddress,
          abi: TASK_ESCROW_ABI,
          functionName: 'tasks',
          args: [i],
        })
        const t = parseTask(raw)

        // Match: buyer, provider (= winner), price must match auction values.
        // Timing guard: task.deadline - deliveryDuration >= revealEnd  (task was created after reveal).
        const buyerMatch    = t.buyer.toLowerCase()    === a.buyer.toLowerCase()
        const providerMatch = t.provider.toLowerCase() === a.bestBidder.toLowerCase()
        const priceMatch    = t.price === a.bestPrice
        const earliest      = t.deadline - a.deliveryDuration
        const timingOk      = earliest >= a.revealEnd

        if (buyerMatch && providerMatch && priceMatch && timingOk) {
          cacheTaskIdForAuction(auctionId, i)
          setTaskId(i)
          setScanning(false)
          return
        }
      }
      setNoMatch(true)
    } catch { /* RPC error — leave taskId null */ }
    setScanning(false)
  }, [a, auctionId, publicClient]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (taskId !== null) return
    void scan()
  }, [scan, taskId])

  return { taskId, scanning, noMatch }
}

// ─── AuctionView (main) ───────────────────────────────────────────────────────

export default function AuctionView({ onNavigate }: { onNavigate?: (page: 'task') => void }) {
  const { address } = useAccount()
  const now = useNow()

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

  // Pending balance for the connected wallet
  const { data: pendingRaw, refetch: refetchPending } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'pendingBalances',
    args: address ? [address] : undefined,
    chainId: ARC.chainId,
    query: { enabled: !!address, refetchInterval: 10_000 },
  })
  const pending = pendingRaw as bigint | undefined

  // Withdraw write
  const [withdrawRevert, setWithdrawRevert] = useState<{ message: string; txUrl: string } | null>(null)
  const { writeContract: doWithdraw, data: withdrawHash, isPending: withdrawP, error: withdrawErr } = useWriteContract()
  const { isLoading: withdrawConfirming, isSuccess: withdrawDoneByWagmi, isError: withdrawDropped, data: withdrawReceipt } =
    useWaitForTransactionReceipt({ hash: withdrawHash })
  if (withdrawReceipt) {
    const o = checkReceipt(withdrawReceipt)
    if (!o.ok && !withdrawRevert) setWithdrawRevert({ message: o.message, txUrl: o.txUrl })
  }
  const withdrawDone = withdrawDoneByWagmi && !withdrawRevert

  function handleWithdraw() {
    setWithdrawRevert(null)
    doWithdraw(
      { address: ARC.blindRelayAuctionAddress, abi: BLIND_RELAY_AUCTION_ABI, functionName: 'withdraw', chainId: ARC.chainId },
      {
        onSuccess: () => { toast.success('Withdrawn!'); void refetchPending() },
        onError: (e) => { const m = decodeRevertError(e) || parseOnchainError(e); if (m) toast.error(m) },
      },
    )
  }

  const a: AuctionRecord | null = (() => {
    if (auction === undefined) return null
    try { return parseAuction(auction) } catch { return null }
  })()

  const phase = a ? derivePhase(a.status, a.commitEnd, a.revealEnd, now) : null
  const countdownTarget = a
    ? phase === 'Commit' ? Number(a.commitEnd)
    : phase === 'Reveal' ? Number(a.revealEnd)
    : null
    : null

  const addrLower   = address?.toLowerCase()
  const isMyAuction = !!a && !!addrLower && a.buyer.toLowerCase() === addrLower
  const isWinner    = !!a && !!addrLower && !isZeroAddress(a.bestBidder) && a.bestBidder.toLowerCase() === addrLower
  const isLosingBidder = !!a && !!addrLower && !isWinner && !isMyAuction
    && !!(bidders as string[] | undefined)?.some(b => b.toLowerCase() === addrLower)

  // Task ID for finalized auctions — no getLogs, uses taskCount+tasks scan
  const { taskId: finalizedTaskId, scanning: taskScanning, noMatch: taskNoMatch } =
    useTaskIdForAuction(a, auctionId)

  function handleViewTask() {
    if (finalizedTaskId === null) return
    setPendingTaskId(finalizedTaskId.toString())
    onNavigate?.('task')
  }

  function handleLookup() {
    const n = parseInt(idInput.trim(), 10)
    if (!isNaN(n) && n >= 0) {
      setAuctionId(BigInt(n))
      window.history.replaceState(null, '', `#auction=${n}`)
    }
  }

  function handleSelectFromRecent(id: bigint) {
    setIdInput(id.toString())
    setAuctionId(id)
    window.history.replaceState(null, '', `#auction=${id.toString()}`)
  }

  const isFinalized = a?.status === 1

  return (
    <PageWrapper>
      <PageTitle>Auction View</PageTitle>

      {/* How it works */}
      <div className="rounded-2xl bg-blue-50/60 border border-blue-100 px-5 py-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">How it works</p>
        <ul className="space-y-1.5 text-sm text-slate-600">
          <li className="flex gap-2"><span className="text-blue-400 font-bold shrink-0">1.</span><span>The buyer locks the full budget into the contract when creating the auction.</span></li>
          <li className="flex gap-2"><span className="text-blue-400 font-bold shrink-0">2.</span><span>Each bidder posts a sealed commitment and pays the bond — the bond prevents spam.</span></li>
          <li className="flex gap-2"><span className="text-blue-400 font-bold shrink-0">3.</span><span>In the reveal phase bidders publish their price and salt. Bidders who <em>do not</em> reveal forfeit their bond to the buyer.</span></li>
          <li className="flex gap-2"><span className="text-blue-400 font-bold shrink-0">4.</span><span>The lowest revealed price wins. Finalize creates an escrow task paying exactly that price to the winner.</span></li>
          <li className="flex gap-2"><span className="text-blue-400 font-bold shrink-0">5.</span><span>After finalize, use <strong>Withdraw</strong> to claim: buyer gets leftover budget, revealing bidders get their bonds back.</span></li>
        </ul>
      </div>

      {/* Look-up */}
      <Card className="p-5 space-y-3">
        <Label htmlFor="aid">Auction ID</Label>
        <div className="flex gap-2">
          <Input id="aid" type="number" placeholder="0" min="0" value={idInput} onChange={setIdInput} />
          <Button onClick={handleLookup} variant="secondary">Load</Button>
        </div>
      </Card>

      {isLoading && <div className="flex justify-center py-8"><Spinner size={24} /></div>}
      {isError && auctionId !== null && (
        <Alert variant="error">Could not load auction {String(auctionId)}.</Alert>
      )}

      {a && phase && (
        <>
          {/* ── Role banners ─────────────────────────────────────────────── */}
          {isFinalized && isWinner && finalizedTaskId !== null && (
            <div className="rounded-2xl bg-green-600 text-white px-5 py-4 flex flex-col gap-2">
              <p className="font-bold text-base">🏆 You won this auction at {formatUsdc(a.bestPrice)} USDC!</p>
              <p className="text-sm text-green-100">
                Next: submit your delivery on{' '}
                <button
                  onClick={handleViewTask}
                  className="underline font-semibold hover:text-white cursor-pointer"
                >
                  Task #{finalizedTaskId.toString()}
                </button>
              </p>
            </div>
          )}
          {isFinalized && isWinner && finalizedTaskId === null && !taskScanning && (
            <div className="rounded-2xl bg-green-600 text-white px-5 py-4">
              <p className="font-bold text-base">🏆 You won this auction at {formatUsdc(a.bestPrice)} USDC!</p>
              <p className="text-sm text-green-100 mt-1">
                {taskNoMatch
                  ? 'Could not locate the escrow task automatically — check the Task tab.'
                  : 'Looking up escrow task…'}
              </p>
            </div>
          )}
          {isFinalized && isLosingBidder && (
            <div className="rounded-2xl bg-amber-50 border border-amber-200 px-5 py-4">
              <p className="font-semibold text-amber-800">You didn't win this auction.</p>
              <p className="text-sm text-amber-700 mt-1">
                Your bond is claimable on the{' '}
                <a href="#page=finalize" className="underline font-medium">Finalize &amp; Withdraw</a> page.
              </p>
            </div>
          )}
          {isFinalized && isMyAuction && finalizedTaskId !== null && (
            <div className="rounded-2xl bg-blue-50 border border-blue-200 px-5 py-4">
              <p className="font-semibold text-blue-800">Auction finalized.</p>
              <p className="text-sm text-blue-700 mt-1">
                Task #{finalizedTaskId.toString()} is waiting for delivery from the winner.{' '}
                <button onClick={handleViewTask} className="underline font-medium cursor-pointer">Open task →</button>
              </p>
            </div>
          )}

          {/* ── Header card ──────────────────────────────────────────────── */}
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
                <a href={`${ARC.explorerBase}/address/${a.buyer}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-blue-600 hover:underline flex items-center gap-1 justify-end">
                  {formatAddress(a.buyer)}
                  {isMyAuction && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 rounded-full">You</span>}
                  <ExternalLink size={11} />
                </a>
              } />
              <Row label="Budget"          value={`${formatUsdc(a.budget)} USDC`} />
              <Row label="Bond"            value={`${formatUsdc(a.bondAmount)} USDC`} />
              <Row label="Commit ends"     value={new Date(Number(a.commitEnd)       * 1000).toLocaleString()} />
              <Row label="Reveal ends"     value={new Date(Number(a.revealEnd)       * 1000).toLocaleString()} />
              <Row label="Delivery window" value={`${Math.round(Number(a.deliveryDuration) / 86400)} days`} />
              <Row label="Review window"   value={`${Math.round(Number(a.reviewWindow)     / 86400)} days`} />
              <Row label="Task hash"       value={<span className="font-mono text-xs break-all">{a.taskHash}</span>} />
            </div>
          </Card>

          {/* ── Finalized result card ─────────────────────────────────────── */}
          {isFinalized && !isZeroAddress(a.bestBidder) && (
            <Card className="p-5 space-y-3 border-green-200 bg-green-50/40">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <p className="text-sm font-semibold text-green-800">Auction finalized</p>
              </div>
              <div className="space-y-0.5">
                <Row label="Winner" value={
                  <a href={`${ARC.explorerBase}/address/${a.bestBidder}`} target="_blank" rel="noopener noreferrer"
                    className="font-mono text-blue-600 hover:underline flex items-center gap-1 justify-end">
                    {formatAddress(a.bestBidder)} <ExternalLink size={11} />
                  </a>
                } />
                <Row label="Winning price" value={`${formatUsdc(a.bestPrice)} USDC`} />
                {taskScanning && (
                  <Row label="Escrow task" value={<span className="text-xs text-slate-400 flex items-center gap-1"><Spinner size={12} /> scanning…</span>} />
                )}
                {!taskScanning && finalizedTaskId !== null && (
                  <Row label="Escrow task" value={
                    <span className="font-mono font-bold text-slate-800">#{finalizedTaskId.toString()}</span>
                  } />
                )}
                {!taskScanning && taskNoMatch && finalizedTaskId === null && (
                  <Row label="Escrow task" value={
                    <span className="text-xs text-amber-600">Not found in last 50 tasks — try the Task tab</span>
                  } />
                )}
              </div>
              {finalizedTaskId !== null && onNavigate && (
                <button
                  onClick={handleViewTask}
                  className="w-full mt-1 flex items-center justify-center gap-2 px-4 py-2.5
                    rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-semibold
                    transition-colors cursor-pointer"
                >
                  Open Task #{finalizedTaskId.toString()} →
                </button>
              )}
            </Card>
          )}

          {/* ── Pending balance + Withdraw ───────────────────────────────── */}
          {isFinalized && address && pending !== undefined && (
            <Card className="p-5 space-y-3">
              <p className="text-sm font-semibold text-slate-700">Your pending balance</p>
              <div className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                {formatUsdc(pending)} <span className="text-base font-medium text-slate-400">USDC</span>
              </div>
              {pending > 0n && (
                <>
                  <Button
                    onClick={handleWithdraw}
                    disabled={withdrawP || withdrawConfirming || withdrawDone || withdrawDropped}
                    fullWidth
                  >
                    {withdrawP || withdrawConfirming ? (
                      <><Spinner /> {withdrawP ? 'Confirm in wallet…' : 'Confirming…'}</>
                    ) : withdrawDropped ? 'Transaction dropped — retry'
                    : withdrawDone ? 'Withdrawn!'
                    : `Withdraw ${formatUsdc(pending)} USDC`}
                  </Button>
                  {withdrawHash && <div className="text-xs text-slate-500 flex items-center gap-1">Tx: <TxLink hash={withdrawHash} /></div>}
                </>
              )}
              {pending === 0n && <p className="text-sm text-slate-400">Nothing to withdraw.</p>}
              {withdrawErr && !withdrawRevert && (
                <Alert variant="error">{decodeRevertError(withdrawErr) || parseOnchainError(withdrawErr)}</Alert>
              )}
              {withdrawRevert && (
                <Alert variant="error">
                  {withdrawRevert.message}{' '}
                  <a href={withdrawRevert.txUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">View on explorer</a>
                </Alert>
              )}
            </Card>
          )}

          {/* ── Bidders ─────────────────────────────────────────────────── */}
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
                    bestBidder={a.bestBidder ?? ZERO}
                    status={a.status}
                    isMe={!!addrLower && b.toLowerCase() === addrLower}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <RecentAuctions now={now} onSelect={handleSelectFromRecent} />
    </PageWrapper>
  )
}
