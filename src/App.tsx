import { useState, useEffect } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { CHAIN_CONFIG } from './lib/blindrelay'
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
function parseHash(): { page: Page; auctionId?: string } | null {
  const hash = window.location.hash.slice(1)
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const auctionId = params.get('auction')
  if (auctionId !== null) return { page: 'view', auctionId }
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

export default function App() {
  const [page, setPage] = useState<Page>(() => {
    const parsed = parseHash()
    if (parsed) {
      if (parsed.auctionId) _pendingHashAuctionId = parsed.auctionId
      return parsed.page
    }
    return 'view'
  })

  const { chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()

  const wrongChain    = isConnected && chainId !== TARGET_CHAIN
  const walletMissing = !hasInjectedWallet()

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
      setPage(parsed.page)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function navigate(p: Page) {
    setPage(p)
    window.history.pushState(null, '', `#page=${p}`)
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

      {/* Main content */}
      <main className="pb-20">
        <div className={wrongChain ? 'pointer-events-none opacity-60 select-none' : ''}>
          <ErrorBoundary>
            {page === 'create'   && <CreateAuction />}
            {page === 'view'     && <AuctionView />}
            {page === 'commit'   && <CommitBid />}
            {page === 'reveal'   && <RevealBid />}
            {page === 'finalize' && <FinalizeWithdraw />}
            {page === 'task'     && <TaskView />}
          </ErrorBoundary>
        </div>
      </main>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 z-30 bg-white/70 backdrop-blur-sm border-t border-slate-100 px-4 py-2">
        <div className="max-w-2xl mx-auto flex items-center justify-between text-xs text-slate-400">
          <span>
            <span className="font-medium text-slate-500">{CHAIN_CONFIG.chainName}</span>
            {' · '}
            <a
              href={`${CHAIN_CONFIG.explorerBase}/address/${CHAIN_CONFIG.blindRelayAuctionAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="hover:text-slate-600 underline"
            >auction</a>
            {' · '}
            <a
              href={`${CHAIN_CONFIG.explorerBase}/address/${CHAIN_CONFIG.taskEscrowAddress}`}
              target="_blank" rel="noopener noreferrer"
              className="hover:text-slate-600 underline"
            >escrow</a>
          </span>
          <span>built {formatBuildTs()}</span>
        </div>
      </footer>
    </div>
  )
}
