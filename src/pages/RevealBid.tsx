import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import {
  CHAIN_CONFIG,
  BLIND_RELAY_AUCTION_ABI,
  computeCommitment,
  parseUsdc,
  formatUsdc,
} from '../lib/blindrelay'
import { loadSalt } from '../lib/salt-store'
import { parseOnchainError, checkReceipt, decodeRevertError } from '../lib/errors'
import {
  Card,
  PageWrapper,
  PageTitle,
  Label,
  Input,
  Button,
  Alert,
  TxLink,
  Row,
  Spinner,
} from '../components/ui'

const ARC = CHAIN_CONFIG

export default function RevealBid() {
  const { address, chainId } = useAccount()

  const [auctionIdStr, setAuctionIdStr] = useState('')
  const [priceStr, setPriceStr] = useState('')
  const [saltInput, setSaltInput] = useState('')
  const [saltSource, setSaltSource] = useState<'auto' | 'manual' | 'file'>('auto')

  const auctionId = (() => { try { const n = parseInt(auctionIdStr, 10); return isNaN(n) ? null : BigInt(n) } catch { return null } })()
  const priceRaw = (() => { try { return parseUsdc(priceStr) } catch { return 0n } })()

  const saltValue: `0x${string}` | null = (() => {
    const s = saltInput.trim()
    if (s.startsWith('0x') && s.length === 66) return s as `0x${string}`
    return null
  })()

  // Auto-load salt from localStorage when auction ID and address change.
  // We intentionally use auctionIdStr (not auctionId) to trigger the
  // effect when the user changes the input text, even while auctionId
  // is derived synchronously from it. The setState calls update UI state
  // derived from an external (localStorage) system, which is the correct
  // use of useEffect per React rules. eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (auctionId === null || !address) return
    const stored = loadSalt(auctionId, address)
    if (stored) {
      setSaltInput(stored)
      setSaltSource('auto')
    }
    // auctionId is derived from auctionIdStr — using auctionIdStr as the
    // dep keeps the effect stable while tracking user input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionIdStr, address])

  // Computed commitment for preview
  const commitment = (saltValue && address && auctionId !== null && priceRaw > 0n)
    ? computeCommitment(
        ARC.blindRelayAuctionAddress,
        BigInt(chainId ?? ARC.chainId),
        auctionId,
        address,
        priceRaw,
        saltValue,
      )
    : null

  const [revealRevert, setRevealRevert] = useState<{ message: string; txUrl: string } | null>(null)

  // Write hook
  const { writeContract: reveal, data: revealHash, isPending, error: revealWriteErr } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmedByWagmi, isError: isDropped, data: revealReceipt } =
    useWaitForTransactionReceipt({ hash: revealHash, chainId: ARC.chainId })

  const revealReverted = revealReceipt
    ? (() => { const o = checkReceipt(revealReceipt); if (!o.ok && !revealRevert) setRevealRevert({ message: o.message, txUrl: o.txUrl }); return !o.ok })()
    : false
  const isConfirmed = isConfirmedByWagmi && !revealReverted

  function handleReveal() {
    if (!saltValue || auctionId === null || priceRaw <= 0n) return
    setRevealRevert(null)
    reveal(
      {
        address: ARC.blindRelayAuctionAddress,
        abi: BLIND_RELAY_AUCTION_ABI,
        functionName: 'revealBid',
        args: [auctionId, priceRaw, saltValue],
        chainId: ARC.chainId,
      },
      {
        onSuccess: () => toast.success('Bid revealed!'),
        onError: (e) => { const m = decodeRevertError(e) || parseOnchainError(e); if (m) toast.error(m) },
      },
    )
  }

  // File upload handler
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as Record<string, unknown>
        const s = parsed['salt']
        if (typeof s === 'string' && s.startsWith('0x') && s.length === 66) {
          setSaltInput(s)
          setSaltSource('file')
          const p = parsed['price']
          const aid = parsed['auctionId']
          if (typeof p === 'string') setPriceStr(p)
          if (typeof aid === 'string' || typeof aid === 'number') setAuctionIdStr(String(aid))
        } else {
          toast.error('Salt file format invalid.')
        }
      } catch {
        toast.error('Could not parse salt file.')
      }
    }
    reader.readAsText(file)
  }

  const validationError: string | null = (() => {
    if (auctionId === null) return 'Enter a valid auction ID.'
    if (priceRaw <= 0n) return 'Enter your bid price.'
    if (!saltValue) return 'Enter or load your 32-byte salt (0x…).'
    return null
  })()

  const writeErrMsg = revealWriteErr ? (decodeRevertError(revealWriteErr) || parseOnchainError(revealWriteErr)) : null

  return (
    <PageWrapper>
      <PageTitle>Reveal Bid</PageTitle>
      <p className="text-sm text-slate-500">
        During the reveal phase, publish your original price and salt. They must match your
        commitment exactly or the reveal is rejected.
      </p>

      <Card className="p-5 space-y-4">
        {/* Auction ID */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="aid">Auction ID</Label>
            <Input id="aid" type="number" min="0" placeholder="0" value={auctionIdStr} onChange={setAuctionIdStr} />
          </div>
          <div>
            <Label htmlFor="price">Your bid price (USDC)</Label>
            <Input id="price" type="number" min="0" step="0.01" placeholder="80.00" value={priceStr} onChange={setPriceStr} />
          </div>
        </div>

        {/* Salt */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label htmlFor="salt">Salt</Label>
            {saltSource === 'auto' && (
              <span className="text-xs text-green-600 font-medium">Loaded from browser</span>
            )}
            {saltSource === 'file' && (
              <span className="text-xs text-blue-600 font-medium">Loaded from file</span>
            )}
          </div>
          <Input
            id="salt"
            placeholder="0x… (64 hex chars, 32 bytes)"
            value={saltInput}
            onChange={(v) => { setSaltInput(v); setSaltSource('manual') }}
          />
          {!saltValue && saltInput.length > 0 && (
            <p className="text-xs text-red-500 mt-1">Salt must be a 0x-prefixed 32-byte hex string (66 chars).</p>
          )}
        </div>

        {/* File fallback */}
        {!saltValue && (
          <div className="flex items-center gap-3 p-3 border border-dashed border-slate-300 rounded-xl">
            <Upload size={16} className="text-slate-400 shrink-0" />
            <div className="flex-1">
              <p className="text-xs text-slate-600 font-medium">No salt found in browser storage</p>
              <p className="text-xs text-slate-400">Upload your saved salt JSON file as a fallback.</p>
            </div>
            <label className="cursor-pointer px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition-colors">
              Upload file
              <input type="file" accept=".json" className="hidden" onChange={handleFileUpload} />
            </label>
          </div>
        )}

        {/* Commitment preview — shows the committed price when all inputs are ready */}
        {commitment && (
          <div className="bg-slate-50 rounded-xl p-3 space-y-1">
            <Row
              label="Committed price"
              value={
                <span className="font-semibold text-slate-900">
                  {formatUsdc(priceRaw)} USDC
                  {saltSource !== 'manual' && (
                    <span className="ml-1.5 text-xs font-normal text-green-600">
                      ({saltSource === 'auto' ? 'loaded from browser' : 'loaded from file'})
                    </span>
                  )}
                </span>
              }
            />
            <div>
              <p className="text-xs text-slate-400">Computed commitment (must match on-chain)</p>
              <p className="font-mono text-xs break-all text-slate-700">{commitment}</p>
            </div>
          </div>
        )}

        {validationError && <Alert variant="warning">{validationError}</Alert>}
        {writeErrMsg && <Alert variant="error">{writeErrMsg}</Alert>}
        {revealRevert && (
          <Alert variant="error">
            {revealRevert.message}{' '}
            <a href={revealRevert.txUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">View on explorer</a>
          </Alert>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <Button
          onClick={handleReveal}
          disabled={!!validationError || isPending || isConfirming || isConfirmed || isDropped}
          fullWidth
        >
          {isPending || isConfirming ? (
            <><Spinner /> {isPending ? 'Confirm in wallet…' : 'Confirming…'}</>
          ) : isDropped ? (
            'Transaction dropped — retry'
          ) : isConfirmed ? (
            'Bid revealed!'
          ) : (
            'Reveal bid'
          )}
        </Button>

        {revealHash && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            Transaction: <TxLink hash={revealHash} />
          </div>
        )}

        {isConfirmed && (
          <Alert variant="success">
            Reveal confirmed. After the reveal phase ends, anyone can call finalize. Go to Finalize
            to trigger it and then withdraw your bond.
          </Alert>
        )}
      </Card>
    </PageWrapper>
  )
}
