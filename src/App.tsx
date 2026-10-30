import { useState, useEffect, useCallback } from 'react'
import { useAccount, useSwitchChain, usePublicClient } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { CHAIN_CONFIG, isZeroAddress } from './lib/blindrelay'
import { WrongChainBanner } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import CreateAuction from './pages/CreateAuction'
import AuctionView from './pages/AuctionView'
import CommitBid from './pages/CommitBid'
import RevealBid from './pages/RevealBid'
import FinalizeWithdraw from './pages/FinalizeWithdraw'
import TaskView from './pages/TaskView'

type Page = 'create' | 'view' | 'commit' | 'reveal' | 'finalize' | 'task'

const NAV: { id: Page; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'view',   label: 'Auction' },
  { id: 'commit', label: 'Commit' },
  { id: 'reveal', label: 'Reveal' },
  { id: 'finalize', label: 'Finalize' },
  { id: 'task',   label: 'Task' },
]

const TARGET_CHAIN = CHAIN_CONFIG.chainId

/** Detect whether any EIP-1193 wallet provider is injected into the page. */
function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && typeof (window as { ethereum?: unknown }).ethereum !== 'undefined'
}

/** Format the Vite build timestamp to a short human-readable string. */
function formatBuildTs(): string {
  try {
    const d = new Date(__BUILD_TIMESTAMP__)
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return __BUILD_TIMESTAMP__
  }
}

/**
 * Parse the hash fragment. Returns:
 *   { page: 'view', auctionId: '42' } for #auction=42
 *   { page: <page> }                  for #page=<name>
 *   null                              for unknown/empty hashes
 */
function parseHash(): { page: Page; auctionId?: string; taskId?: string } | null {
  const hash = window.location.hash.slice(1)
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const auctionId = params.get('auction')
  if (auctionId !== null) return { page: 'view', auctionId }
  const taskId = params.get('task')
  if (taskId !== null) return { page: 'task', taskId }
  const page = params.get('page') as Page | null
  if (page && NAV.some(n => n.id === page)) return { page }
  return null
}

/**
 * External auction ID to pre-load in AuctionView, set by hash routing.
 * We use a module-level variable (not state) so AuctionView can read it
 * without prop-drilling, then clear it after first use.
 */
let _pendingHashAuctionId: string | null = null

/** Read and clear the pending hash auction ID (one-shot). */
export function consumePendingHashAuctionId(): string | null {
  const val = _pendingHashAuctionId
  _pendingHashAuctionId = null
  return val
}

/**
 * Task ID to pre-load in TaskView — set either by clicking "Open Task" in
 * AuctionView or by a #task=N hash link in the URL. Cleared after first read.
 */
let _pendingTaskId: string | null = null

/** Set the task ID to open when navigating to the Task tab. */
export function setPendingTaskId(id: string): void {
  _pendingTaskId = id
}

/** Read and clear the pending task ID (one-shot). */
export function consumePendingTaskId(): string | null {
  const val = _pendingTaskId
  _pendingTaskId = null
  return val
}

/** Read and clear any hash-provided task ID (one-shot, called by TaskView on mount). */
export function consumePendingHashTaskId(): string | null {
  return consumePendingTaskId()
}

// ─── Contract guard ──────────────────────────────────────────────────────────
//
// Checks two things before any writes are allowed:
//   1. Neither configured contract address is the zero address.
//   2. Both contracts have deployed bytecode on the active chain (eth_getCode ≠ "0x").
//
// While checking: contractsOk = null (loading).
// On failure:     contractsOk = { ok: false, reason: '...' }.
// On success:     contractsOk = { ok: true }.

type GuardResult = { ok: true } | { ok: false; reason: string } | null

function useContractGuard(): GuardResult {
  const publicClient = usePublicClient()
  const [result, setResult] = useState<GuardResult>(null)

  const check = useCallback(async () => {
    const bra = CHAIN_CONFIG.blindRelayAuctionAddress
    const te  = CHAIN_CONFIG.taskEscrowAddress

    // 1. Zero-address check (static, no RPC needed)
    if (isZeroAddress(bra) || isZeroAddress(te)) {
      setResult({ ok: false, reason: `Contract address not configured for ${CHAIN_CONFIG.chainName}.` })
      return
    }
    if (!publicClient) return  // wagmi not ready yet

    // 2. eth_getCode check
    try {
      const [braBytecode, teBytecode] = await Promise.all([
        publicClient.getCode({ address: bra }),
        publicClient.getCode({ address: te }),
      ])
      const braEmpty = !braBytecode || braBytecode === '0x'
      const teEmpty  = !teBytecode  || teBytecode  === '0x'
      if (braEmpty || teEmpty) {
        const missing = [braEmpty && 'BlindRelayAuction', teEmpty && 'TaskEscrow']
          .filter(Boolean).join(' and ')
        setResult({
          ok: false,
          reason: `${missing} ${braEmpty && teEmpty ? 'have' : 'has'} no bytecode on ${CHAIN_CONFIG.chainName} (chain ${CHAIN_CONFIG.chainId}). The contract may not be deployed on this network.`,
        })
        return
      }
      setResult({ ok: true })
    } catch (e) {
      // RPC error — be optimistic rather than blocking the user on a transient failure
      setResult({ ok: true })
      console.warn('Contract guard RPC check failed:', e)
    }
  }, [publicClient])

  useEffect(() => { void check() }, [check])

  return result
}

// ─── ContractErrorScreen ─────────────────────────────────────────────────────

function ContractErrorScreen({ reason }: { reason: string }) {
  return (
    <div className="min-h-dvh bg-gradient-to-br from-slate-50 to-red-50/30 flex items-center justify-center px-4">
      <div className="max-w-lg w-full bg-white rounded-2xl border border-red-200 shadow-lg p-8 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-lg font-bold text-red-800">Contract not available</h1>
        </div>

        <p className="text-sm text-slate-600">{reason}</p>

        <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-xs font-mono text-slate-500">
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">Network</span>
            <span className="font-semibold text-slate-700">{CHAIN_CONFIG.chainName} (chain {CHAIN_CONFIG.chainId})</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">Auction</span>
            <a
              href={`${CHAIN_CONFIG.explorerBase}/address/${CHAIN_CONFIG.blindRelayAuctionAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline truncate max-w-xs"
            >
              {CHAIN_CONFIG.blindRelayAuctionAddress}
            </a>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">Escrow</span>
            <a
              href={`${CHAIN_CONFIG.explorerBase}/address/${CHAIN_CONFIG.taskEscrowAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline truncate max-w-xs"
            >
              {CHAIN_CONFIG.taskEscrowAddress}
            </a>
          </div>
        </div>

        <p className="text-xs text-slate-400">
          All write actions are disabled. Connect to {CHAIN_CONFIG.chainName} to continue,
          or check the contract addresses in the configuration.
        </p>
      </div>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>(() => {
    const parsed = parseHash()
    if (parsed) {
      if (parsed.auctionId) _pendingHashAuctionId = parsed.auctionId
      if (parsed.taskId)    _pendingTaskId        = parsed.taskId
      return parsed.page
    }
    return 'view'
  })

  const { chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const guard = useContractGuard()

  const wrongChain    = isConnected && chainId !== TARGET_CHAIN
  const walletMissing = !hasInjectedWallet()
  const contractsOk   = guard === null ? null : guard.ok  // null=loading, true=ok, false=error

  // Keep URL hash in sync with current page
  useEffect(() => {
    const current = window.location.hash
    const expected = `#page=${page}`
    // Don't clobber an #auction= link we just navigated from
    if (current && current.startsWith('#auction=') && page === 'view') return
    if (current !== expected) {
      window.history.replaceState(null, '', expected)
    }
  }, [page])

  // Handle browser back/forward and external hash links
  useEffect(() => {
    function onHashChange() {
      const parsed = parseHash()
      if (!parsed) return
      if (parsed.auctionId) _pendingHashAuctionId = parsed.auctionId
      if (parsed.taskId)    _pendingTaskId        = parsed.taskId
      setPage(parsed.page)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function navigate(p: Page) {
    setPage(p)
    window.history.pushState(null, '', `#page=${p}`)
  }

  // Contract not deployed on this chain — show full-page error, all writes disabled
  if (guard !== null && !guard.ok) {
    return <ContractErrorScreen reason={guard.reason} />
  }

  return (
    <div className="min-h-dvh bg-gradient-to-br from-slate-50 to-blue-50/30 font-body">
      {/* Wrong-chain banner */}
      {wrongChain && (
        <WrongChainBanner
          chainName={CHAIN_CONFIG.chainName}
          onSwitch={() => switchChain({ chainId: TARGET_CHAIN })}
        />
      )}

      {/* Wallet not detected banner */}
      {walletMissing && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center gap-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="flex-shrink-0">
            <path
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
          <span className="text-sm text-amber-800 font-medium">
            No wallet detected.{' '}
            <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer"
              className="underline hover:text-amber-900">Install MetaMask</a>
            {' '}or{' '}
            <a href="https://rabby.io/" target="_blank" rel="noopener noreferrer"
              className="underline hover:text-amber-900">Rabby</a>
            {' '}to interact with BlindRelay.
          </span>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-slate-900 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="3"  y="3"  width="8" height="8" rx="1.5" fill="white" />
                <rect x="13" y="3"  width="8" height="8" rx="1.5" fill="white" opacity="0.6" />
                <rect x="3"  y="13" width="8" height="8" rx="1.5" fill="white" opacity="0.6" />
                <rect x="13" y="13" width="8" height="8" rx="1.5" fill="white" opacity="0.3" />
              </svg>
            </div>
            <span className="font-display font-bold text-slate-900 tracking-tight text-sm">BlindRelay</span>
            <span className="hidden sm:inline text-xs text-slate-400 font-medium px-2 py-0.5 bg-slate-100 rounded-full">
              {CHAIN_CONFIG.chainName}
            </span>
          </div>
          <ConnectKitButton />
        </div>

        {/* Nav tabs */}
        <div className="max-w-2xl mx-auto px-4 pb-0 flex gap-0 overflow-x-auto scrollbar-none">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors cursor-pointer
                ${page === item.id
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main content — each page has its own ErrorBoundary so one tab's crash
          doesn't take down the others. The outer ErrorBoundary catches anything
          that escapes (e.g. a crash in the nav itself).
          Writes are also disabled while the contract guard is still loading (contractsOk=null). */}
      <main className="pb-20">
        <div className={(wrongChain || contractsOk === null) ? 'pointer-events-none opacity-60 select-none' : ''}>
          <ErrorBoundary>
            {page === 'create'   && <ErrorBoundary><CreateAuction /></ErrorBoundary>}
            {page === 'view'     && <ErrorBoundary><AuctionView onNavigate={navigate} /></ErrorBoundary>}
            {page === 'commit'   && <ErrorBoundary><CommitBid /></ErrorBoundary>}
            {page === 'reveal'   && <ErrorBoundary><RevealBid /></ErrorBoundary>}
            {page === 'finalize' && <ErrorBoundary><FinalizeWithdraw /></ErrorBoundary>}
            {page === 'task'     && <ErrorBoundary><TaskView /></ErrorBoundary>}
          </ErrorBoundary>
        </div>
      </main>

      {/* Footer — network name, chain ID, both contract addresses */}
      <footer className="fixed bottom-0 left-0 right-0 z-30 bg-white/70 backdrop-blur-sm border-t border-slate-100 px-4 py-2">
        <div className="max-w-2xl mx-auto space-y-0.5 text-xs text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-slate-600">
              {CHAIN_CONFIG.chainName}
              <span className="ml-1.5 font-normal text-slate-400">chain {CHAIN_CONFIG.chainId}</span>
            </span>
            <span>built {formatBuildTs()}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="text-slate-300">Auction:</span>
            <a
              href={`${CHAIN_CONFIG.explorerBase}/address/${CHAIN_CONFIG.blindRelayAuctionAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="font-mono hover:text-slate-600 underline truncate max-w-[160px] sm:max-w-none"
              title={CHAIN_CONFIG.blindRelayAuctionAddress}
            >
              {CHAIN_CONFIG.blindRelayAuctionAddress}
            </a>
            <span className="text-slate-300 hidden sm:inline">·</span>
            <span className="text-slate-300">Escrow:</span>
            <a
              href={`${CHAIN_CONFIG.explorerBase}/address/${CHAIN_CONFIG.taskEscrowAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="font-mono hover:text-slate-600 underline truncate max-w-[160px] sm:max-w-none"
              title={CHAIN_CONFIG.taskEscrowAddress}
            >
              {CHAIN_CONFIG.taskEscrowAddress}
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
