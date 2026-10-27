import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { toast } from 'sonner'
import { AlertTriangle, Download, Copy, Check } from 'lucide-react'
import {
  CHAIN_CONFIG,
  BLIND_RELAY_AUCTION_ABI,
  ERC20_APPROVE_ABI,
  parseAuction,
  computeCommitment,
  parseUsdc,
  formatUsdc,
  formatAddress,
} from '../lib/blindrelay'
import { generateSalt, saveSalt } from '../lib/salt-store'
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

export default function CommitBid() {
  const { address, chainId } = useAccount()

  const [auctionIdStr, setAuctionIdStr] = useState('')
  const [priceStr, setPriceStr] = useState('')
  const [salt, setSalt] = useState<`0x${string}` | null>(null)
  const [saltCopied, setSaltCopied] = useState(false)
  const [saltAcknowledged, setSaltAcknowledged] = useState(false)
  const [approveRevert, setApproveRevert] = useState<{ message: string; txUrl: string } | null>(null)
  const [commitRevert, setCommitRevert]   = useState<{ message: string; txUrl: string } | null>(null)
  // Confirmation gate: true when the user has clicked "Commit bid" and seen the
  // summary dialog but not yet clicked the final "Yes, commit" button.
  const [confirmPending, setConfirmPending] = useState(false)

  const auctionId = (() => { try { const n = parseInt(auctionIdStr, 10); return isNaN(n) ? null : BigInt(n) } catch { return null } })()
  const priceRaw = (() => { try { return parseUsdc(priceStr) } catch { return 0n } })()

  // Load auction bond amount
  const { data: auctionData } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'getAuction',
    args: auctionId !== null ? [auctionId] : undefined,
    chainId: ARC.chainId,
    query: { enabled: auctionId !== null },
  })

  const auction = (() => {
    if (auctionData === undefined) return null
    try { return parseAuction(auctionData) } catch { return null }
  })()
  const bondRaw = auction?.bondAmount ?? 0n

  // Compute commitment
  const commitment = (salt && address && auctionId !== null && priceRaw > 0n)
    ? computeCommitment(
        ARC.blindRelayAuctionAddress,
        BigInt(chainId ?? ARC.chainId),
        auctionId,
        address,
        priceRaw,
        salt,
      )
    : null

  // Write hooks — approve bond then commitBid
  const { writeContract: approve, data: approveHash, isPending: approveP, error: approveWriteErr } = useWriteContract()
  const { writeContract: commit,  data: commitHash,  isPending: commitP,  error: commitWriteErr  } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveConfirmedByWagmi, isError: approveDropped, data: approveReceipt } =
    useWaitForTransactionReceipt({ hash: approveHash })
  const { isLoading: commitConfirming,  isSuccess: commitConfirmedByWagmi,  isError: commitDropped,  data: commitReceipt  } =
    useWaitForTransactionReceipt({ hash: commitHash })

  // ── Allowance pre-flight ──────────────────────────────────────────────────
  // Always compare against the CURRENT bondAmount, not a stale value.
  const { data: currentAllowanceRaw } = useReadContract({
    address: ARC.usdcAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: 'allowance',
    args: address ? [address, ARC.blindRelayAuctionAddress] : undefined,
    chainId: ARC.chainId,
    query: { enabled: !!address && bondRaw > 0n, refetchInterval: 8_000 },
  })
  const currentAllowance = currentAllowanceRaw
  const alreadyApprovedBond = currentAllowance !== undefined && bondRaw > 0n && currentAllowance >= bondRaw

  const approveReverted = approveReceipt
    ? (() => { const o = checkReceipt(approveReceipt); if (!o.ok && !approveRevert) setApproveRevert({ message: o.message, txUrl: o.txUrl }); return !o.ok })()
    : false
  const commitReverted = commitReceipt
    ? (() => { const o = checkReceipt(commitReceipt); if (!o.ok && !commitRevert) setCommitRevert({ message: o.message, txUrl: o.txUrl }); return !o.ok })()
    : false
  const approveConfirmed = approveConfirmedByWagmi && !approveReverted
  const commitConfirmed  = commitConfirmedByWagmi  && !commitReverted

  // Save salt to localStorage after successful commit
  useEffect(() => {
    if (commitConfirmed && salt && auctionId !== null && address) {
      saveSalt(auctionId, address, salt)
    }
  }, [commitConfirmed, salt, auctionId, address])

  function handleGenerateSalt() {
    setSalt(generateSalt())
    setSaltAcknowledged(false)
    setSaltCopied(false)
  }

  async function handleCopySalt() {
    if (!salt) return
    await navigator.clipboard.writeText(salt)
    setSaltCopied(true)
    setTimeout(() => setSaltCopied(false), 2000)
  }

  function handleDownloadSalt() {
    if (!salt || auctionId === null || !address) return
    const payload = JSON.stringify(
      { auctionId: String(auctionId), bidder: address, price: priceStr, salt, chainId: ARC.chainId },
      null,
      2,
    )
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `blindrelay-salt-auction${auctionId}-${address.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setSaltAcknowledged(true)
  }

  function handleApprove() {
    if (!address || bondRaw === 0n) return
    setApproveRevert(null)
    approve(
      {
        address: ARC.usdcAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [ARC.blindRelayAuctionAddress, bondRaw],
        chainId: ARC.chainId,
      },
      { onError: (e) => { const m = decodeRevertError(e) || parseOnchainError(e); if (m) toast.error(m) } },
    )
  }

  /** First click: show the confirmation dialog. */
  function handleCommitRequest() {
    if (!commitment) return
    setConfirmPending(true)
  }

  /** Second click: actually send the transaction. */
  function handleCommitConfirm() {
    if (!commitment) return
    setConfirmPending(false)
    setCommitRevert(null)
    commit(
      {
        address: ARC.blindRelayAuctionAddress,
        abi: BLIND_RELAY_AUCTION_ABI,
        functionName: 'commitBid',
        args: [auctionId!, commitment],
        chainId: ARC.chainId,
      },
      {
        onSuccess: () => toast.success('Bid committed! Keep your salt safe.'),
        onError: (e) => { const m = decodeRevertError(e) || parseOnchainError(e); if (m) toast.error(m) },
      },
    )
  }

  function handleCommitCancel() {
    setConfirmPending(false)
  }

  const step = commitConfirmed ? 3 : approveConfirmed ? 2 : approveHash ? 1 : 0

  const validationError: string | null = (() => {
    if (auctionId === null) return 'Enter a valid auction ID.'
    if (priceRaw <= 0n) return 'Enter a bid price > 0.'
    if (!salt) return 'Generate a salt first.'
    return null
  })()

  const canApprove = !validationError && saltAcknowledged && !approveP && !approveConfirming
    && !approveConfirmed && !approveDropped && !alreadyApprovedBond
  const canCommit = (approveConfirmed || alreadyApprovedBond) && saltAcknowledged && !!commitment
    && !commitP && !commitConfirming && !commitConfirmed && !commitDropped

  return (
    <PageWrapper>
      <PageTitle>Commit Bid</PageTitle>
      <p className="text-sm text-slate-500">
        Submit a sealed bid. Your price is hidden until the reveal phase — generate a salt,
        <strong className="text-amber-700"> save it now</strong>, then commit.
      </p>

      <Card className="p-5 space-y-4">
        {/* Auction ID + price */}
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

        {auction && (
          <div className="bg-slate-50 rounded-xl p-3 space-y-1">
            <Row label="Bond required" value={`${formatUsdc(bondRaw)} USDC`} />
            <Row label="Budget ceiling" value={`${formatUsdc(auction.budget)} USDC`} />
          </div>
        )}

        {/* Salt */}
        <div>
          <Label htmlFor="salt">Salt (32-byte random secret)</Label>
          <div className="flex gap-2 mt-1">
            <input
              id="salt"
              readOnly
              value={salt ?? ''}
              placeholder="Click Generate to create a salt"
              className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Button variant="secondary" onClick={handleGenerateSalt}>
              Generate
            </Button>
          </div>
        </div>

        {/* Salt warning */}
        {salt && !saltAcknowledged && (
          <div className="border border-amber-300 rounded-xl p-4 bg-amber-50 space-y-3">
            <div className="flex gap-2 items-start text-amber-800">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <div className="text-sm font-medium">
                <strong>You must save this salt before you can commit.</strong>
                <p className="font-normal mt-1">
                  If you lose it you cannot reveal your bid, and your bond will be forfeited to the
                  auction buyer. It is stored in this browser automatically, but download it as a
                  backup.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void handleCopySalt()}>
                {saltCopied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy salt</>}
              </Button>
              <Button onClick={handleDownloadSalt}>
                <Download size={14} /> Download salt file
              </Button>
            </div>
          </div>
        )}

        {salt && saltAcknowledged && (
          <Alert variant="success">Salt saved. Your browser will load it automatically on the Reveal page.</Alert>
        )}

        {/* Commitment preview */}
        {commitment && (
          <div className="bg-slate-50 rounded-xl p-3">
            <p className="text-xs text-slate-400 mb-1">Commitment hash (sent on-chain)</p>
            <p className="font-mono text-xs break-all text-slate-700">{commitment}</p>
          </div>
        )}

        {validationError && salt && <Alert variant="warning">{validationError}</Alert>}

        {address && (
          <div className="bg-slate-50 rounded-xl p-3">
            <Row label="Your address" value={<span className="font-mono text-xs">{formatAddress(address)}</span>} />
          </div>
        )}
      </Card>

      {/* Step 1: approve bond */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step >= 1 ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-600'}`}>1</span>
          <span className="text-sm font-semibold text-slate-800">Approve bond ({auction ? formatUsdc(bondRaw) : '?'} USDC)</span>
          {approveHash && <span className="ml-auto text-xs"><TxLink hash={approveHash} /></span>}
        </div>
        <div className="pl-8">
          {alreadyApprovedBond && !approveConfirmed && (
            <p className="text-xs text-green-700 font-medium pb-1">
              Allowance already covers the bond ({auction ? formatUsdc(bondRaw) : '?'} USDC) — approve step skipped.
            </p>
          )}
          <Button onClick={handleApprove} disabled={!canApprove} fullWidth>
            {approveP || approveConfirming ? (
              <><Spinner /> {approveP ? 'Confirm in wallet…' : 'Confirming…'}</>
            ) : approveDropped ? (
              'Transaction dropped — retry'
            ) : approveConfirmed || alreadyApprovedBond ? (
              'Bond approved ✓'
            ) : (
              'Approve bond'
            )}
          </Button>
        </div>
        {approveWriteErr && !approveRevert && (
          <Alert variant="error">{decodeRevertError(approveWriteErr) || parseOnchainError(approveWriteErr)}</Alert>
        )}
        {approveRevert && (
          <Alert variant="error">
            {approveRevert.message}{' '}
            <a href={approveRevert.txUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">View on explorer</a>
          </Alert>
        )}
      </Card>

      {/* Confirmation dialog — shown between clicking "Commit bid" and final confirmation */}
      {confirmPending && address && auctionId !== null && priceRaw > 0n && (
        <Card className="p-5 space-y-4 border-2 border-amber-300 bg-amber-50/60">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Confirm your commitment</p>
              <p className="text-xs text-amber-700 mt-1">
                This cannot be changed after committing. If you lose your salt, your bond will be
                forfeited to the buyer.
              </p>
            </div>
          </div>
          <div className="bg-white rounded-xl p-3 space-y-1 border border-amber-200">
            <Row label="Auction"    value={`#${auctionId.toString()}`} />
            <Row label="Bid price"  value={`${formatUsdc(priceRaw)} USDC`} />
            <Row label="Bond"       value={`${formatUsdc(bondRaw)} USDC`} />
            <Row label="Your wallet" value={<span className="font-mono text-xs">{formatAddress(address)}</span>} />
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleCommitCancel} fullWidth>
              Cancel
            </Button>
            <Button onClick={handleCommitConfirm} fullWidth>
              Yes, commit this bid
            </Button>
          </div>
        </Card>
      )}

      {/* Step 2: commit */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step >= 3 ? 'bg-green-500 text-white' : step >= 2 ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-600'}`}>2</span>
          <span className="text-sm font-semibold text-slate-800">Submit commitment</span>
          {commitHash && <span className="ml-auto text-xs"><TxLink hash={commitHash} /></span>}
        </div>
        <div className="pl-8">
          <Button onClick={handleCommitRequest} disabled={!canCommit} fullWidth>
            {commitP || commitConfirming ? (
              <><Spinner /> {commitP ? 'Confirm in wallet…' : 'Confirming…'}</>
            ) : commitDropped ? (
              'Transaction dropped — retry'
            ) : commitConfirmed ? (
              'Bid committed!'
            ) : (
              'Commit bid'
            )}
          </Button>
        </div>
        {commitWriteErr && !commitRevert && (
          <Alert variant="error">{decodeRevertError(commitWriteErr) || parseOnchainError(commitWriteErr)}</Alert>
        )}
        {commitRevert && (
          <Alert variant="error">
            {commitRevert.message}{' '}
            <a href={commitRevert.txUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">View on explorer</a>
          </Alert>
        )}
        {commitConfirmed && (
          <Alert variant="success">
            Committed. Wait for the reveal phase, then go to Reveal Bid and your salt will be
            pre-loaded.
          </Alert>
        )}
      </Card>
    </PageWrapper>
  )
}
