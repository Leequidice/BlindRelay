import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { keccak256, toHex, parseEventLogs } from 'viem'
import { toast } from 'sonner'
import {
  CHAIN_CONFIG,
  BLIND_RELAY_AUCTION_ABI,
  ERC20_APPROVE_ABI,
  parseUsdc,
  formatUsdc,
  CONTRACT_CONSTANTS,
  buildTxUrl,
} from '../lib/blindrelay'
import { parseOnchainError, checkReceipt, decodeRevertError } from '../lib/errors'
import {
  Card,
  PageWrapper,
  PageTitle,
  Label,
  Input,
  Textarea,
  Button,
  Alert,
  TxLink,
  Row,
  Spinner,
} from '../components/ui'
import { Copy, CheckCircle2, ExternalLink } from 'lucide-react'

const ARC = CHAIN_CONFIG

/** Copy text to clipboard and return true on success. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

/** Build the shareable hash-based URL for an auction ID. */
function buildShareUrl(auctionId: bigint): string {
  const base = window.location.origin + window.location.pathname
  return `${base}#auction=${auctionId.toString()}`
}

export default function CreateAuction() {
  const { address } = useAccount()

  // Form state
  const [description, setDescription] = useState('')
  const [budget, setBudget] = useState('')
  const [bond, setBond] = useState('')
  const [commitMins, setCommitMins] = useState('60')
  const [revealMins, setRevealMins] = useState('30')
  const [deliveryDays, setDeliveryDays] = useState('7')
  const [reviewDays, setReviewDays] = useState('3')

  // Post-success state
  const [createdAuctionId, setCreatedAuctionId] = useState<bigint | null>(null)
  const [copiedId, setCopiedId] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  // Revert details on-chain
  const [approveRevert, setApproveRevert] = useState<{ message: string; txUrl: string } | null>(null)
  const [createRevert, setCreateRevert]   = useState<{ message: string; txUrl: string } | null>(null)

  // Write state — two-step: approve then createAuction
  const {
    writeContract: approve,
    data: approveHash,
    isPending: approveP,
    error: approveWriteErr,
  } = useWriteContract()
  const {
    writeContract: create,
    data: createHash,
    isPending: createP,
    error: createWriteErr,
  } = useWriteContract()

  const {
    isLoading: approveConfirming,
    isSuccess: approveConfirmed,
    isError: approveDropped,
    data: approveReceipt,
  } = useWaitForTransactionReceipt({ hash: approveHash, chainId: ARC.chainId })

  const {
    isLoading: createConfirming,
    isSuccess: createConfirmedByWagmi,
    isError: createDropped,
    data: createReceipt,
  } = useWaitForTransactionReceipt({ hash: createHash, chainId: ARC.chainId })

  // Derived values
  const taskHash = description.trim() ? keccak256(toHex(description.trim())) : null
  const budgetRaw = (() => { try { return parseUsdc(budget) } catch { return 0n } })()
  const bondRaw   = (() => { try { return parseUsdc(bond)   } catch { return 0n } })()
  const commitSecs   = Math.round(parseFloat(commitMins)  * 60)    || 0
  const revealSecs   = Math.round(parseFloat(revealMins)  * 60)    || 0
  const deliverySecs = Math.round(parseFloat(deliveryDays) * 86400) || 0
  const reviewSecs   = Math.round(parseFloat(reviewDays)  * 86400) || 0

  // Check receipt status once confirmed
  if (approveReceipt) {
    const outcome = checkReceipt(approveReceipt)
    if (!outcome.ok && !approveRevert) {
      setApproveRevert({ message: outcome.message, txUrl: outcome.txUrl })
    }
  }

  const createReverted = createReceipt
    ? (() => {
        const outcome = checkReceipt(createReceipt)
        if (!outcome.ok && !createRevert) {
          setCreateRevert({ message: outcome.message, txUrl: outcome.txUrl })
        }
        return !outcome.ok
      })()
    : false

  // Read auction ID from AuctionCreated event in receipt
  const createConfirmed = createConfirmedByWagmi && !createReverted
  if (createConfirmed && createReceipt && createdAuctionId === null) {
    try {
      const logs = parseEventLogs({
        abi: BLIND_RELAY_AUCTION_ABI,
        logs: createReceipt.logs,
        eventName: 'AuctionCreated',
      })
      if (logs.length > 0) {
        const ev = logs[0] as { args: { auctionId: bigint } }
        setCreatedAuctionId(ev.args.auctionId)
      }
    } catch {
      // ignore parse failure — ID still accessible on explorer
    }
  }

  // ── Balance / allowance pre-flight ─────────────────────────────────────────
  const { data: balanceRaw } = useReadContract({
    address: ARC.usdcAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC.chainId,
    query: { enabled: !!address && budgetRaw > 0n, refetchInterval: 10_000 },
  })
  const { data: allowanceRaw } = useReadContract({
    address: ARC.usdcAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: 'allowance',
    args: address ? [address, ARC.blindRelayAuctionAddress] : undefined,
    chainId: ARC.chainId,
    query: { enabled: !!address && budgetRaw > 0n, refetchInterval: 10_000 },
  })

  const balance   = balanceRaw
  const allowance = allowanceRaw

  // Small gas margin: 0.01 USDC on Arc (USDC is gas, but 0.01 covers typical fees)
  const GAS_MARGIN = 10_000n // 0.01 USDC in 6-decimal units

  const insufficientBalance = balance !== undefined && budgetRaw > 0n
    && balance < budgetRaw + GAS_MARGIN

  const sufficientAllowance = allowance !== undefined && allowance >= budgetRaw
  const alreadyApproved = !approveConfirmed && sufficientAllowance && budgetRaw > 0n

  // ── Validation ─────────────────────────────────────────────────────────────
  const C = CONTRACT_CONSTANTS
  const validationError: string | null = (() => {
    if (!description.trim()) return 'Task description is required.'
    if (budgetRaw <= 0n) return 'Budget must be > 0.'
    if (bondRaw <= 0n) return 'Bond must be > 0.'
    if (BigInt(commitSecs) < C.MIN_DURATION || BigInt(commitSecs) > C.MAX_DURATION)
      return `Commit phase must be ${Number(C.MIN_DURATION)}s – ${Number(C.MAX_DURATION) / 86400} days.`
    if (BigInt(revealSecs) < C.MIN_DURATION || BigInt(revealSecs) > C.MAX_DURATION)
      return `Reveal phase must be ${Number(C.MIN_DURATION)}s – ${Number(C.MAX_DURATION) / 86400} days.`
    if (BigInt(deliverySecs) < C.MIN_DELIVERY_DURATION || BigInt(deliverySecs) > C.MAX_DELIVERY_DURATION)
      return `Delivery duration must be ${Number(C.MIN_DELIVERY_DURATION)}s – 365 days.`
    if (BigInt(reviewSecs) < C.MIN_REVIEW_WINDOW || BigInt(reviewSecs) > C.MAX_REVIEW_WINDOW)
      return `Review window must be 1s – 30 days.`
    return null
  })()

  const canApprove = !validationError && !!address && !approveP && !approveConfirming
    && !insufficientBalance && !approveDropped
  const canCreate = (approveConfirmed || alreadyApproved) && !createP && !createConfirming && !createDropped

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleApprove() {
    if (!address || !taskHash) return
    setApproveRevert(null)
    approve(
      {
        address: ARC.usdcAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [ARC.blindRelayAuctionAddress, budgetRaw],
        chainId: ARC.chainId,
      },
      {
        onError: (e) => {
          const msg = decodeRevertError(e) || parseOnchainError(e)
          if (msg) toast.error(msg)
        },
      },
    )
  }

  function handleCreate() {
    if (!taskHash) return
    setCreatedAuctionId(null)
    setCreateRevert(null)
    create(
      {
        address: ARC.blindRelayAuctionAddress,
        abi: BLIND_RELAY_AUCTION_ABI,
        functionName: 'createAuction',
        args: [
          budgetRaw,
          BigInt(commitSecs),
          BigInt(revealSecs),
          bondRaw,
          BigInt(deliverySecs),
          BigInt(reviewSecs),
          taskHash,
        ],
        chainId: ARC.chainId,
      },
      {
        onError: (e) => {
          const msg = decodeRevertError(e) || parseOnchainError(e)
          if (msg) toast.error(msg)
        },
      },
    )
  }

  async function handleCopyId() {
    if (createdAuctionId === null) return
    const ok = await copyText(createdAuctionId.toString())
    if (ok) { setCopiedId(true); setTimeout(() => setCopiedId(false), 2000) }
  }

  async function handleCopyLink() {
    if (createdAuctionId === null) return
    const ok = await copyText(buildShareUrl(createdAuctionId))
    if (ok) { setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000) }
  }

  const step = createConfirmed ? 3 : (approveConfirmed || alreadyApproved) ? 2 : approveHash ? 1 : 0

  return (
    <PageWrapper>
      <PageTitle>Create Auction</PageTitle>

      {/* Plain-language explainer */}
      <div className="rounded-2xl bg-blue-50/60 border border-blue-100 px-5 py-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Before you start</p>
        <ul className="space-y-1.5 text-sm text-slate-600">
          <li className="flex gap-2">
            <span className="text-blue-400 font-bold shrink-0">Budget</span>
            <span>The full budget is locked into the contract the moment you create the auction. It is not charged to bidders.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-blue-400 font-bold shrink-0">Bond</span>
            <span>Each bidder pays this as a deposit when submitting their sealed bid. Bonds are returned after the reveal — but only to bidders who reveal. A bidder who never reveals forfeits their bond to you.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-blue-400 font-bold shrink-0">Winner</span>
            <span>The lowest revealed bid wins and is paid exactly their own price from your budget. The leftover (budget minus winning price) is yours to withdraw after finalize.</span>
          </li>
        </ul>
      </div>

      <Card className="p-6 space-y-5">
        {/* Task description */}
        <div>
          <Label htmlFor="desc">Task description</Label>
          <Textarea
            id="desc"
            placeholder="Describe the deliverable clearly. This text is hashed and stored on-chain."
            value={description}
            onChange={setDescription}
            rows={4}
          />
          {taskHash && (
            <p className="mt-1.5 text-xs text-slate-400 font-mono break-all">
              keccak256: {taskHash}
            </p>
          )}
        </div>

        {/* Budget + bond */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="budget">Budget (USDC)</Label>
            <Input
              id="budget"
              type="number"
              placeholder="100.00"
              min="0"
              step="0.01"
              value={budget}
              onChange={setBudget}
            />
          </div>
          <div>
            <Label htmlFor="bond">Bidder bond (USDC)</Label>
            <Input
              id="bond"
              type="number"
              placeholder="5.00"
              min="0"
              step="0.01"
              value={bond}
              onChange={setBond}
            />
          </div>
        </div>

        {/* Durations */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="commit">Commit phase (minutes)</Label>
            <Input id="commit" type="number" placeholder="60" min="1" value={commitMins} onChange={setCommitMins} />
          </div>
          <div>
            <Label htmlFor="reveal">Reveal phase (minutes)</Label>
            <Input id="reveal" type="number" placeholder="30" min="1" value={revealMins} onChange={setRevealMins} />
          </div>
          <div>
            <Label htmlFor="delivery">Delivery window (days)</Label>
            <Input id="delivery" type="number" placeholder="7" min="1" value={deliveryDays} onChange={setDeliveryDays} />
          </div>
          <div>
            <Label htmlFor="review">Review window (days)</Label>
            <Input id="review" type="number" placeholder="3" min="1" value={reviewDays} onChange={setReviewDays} />
          </div>
        </div>

        {validationError && <Alert variant="warning">{validationError}</Alert>}

        {/* Balance / allowance warnings */}
        {insufficientBalance && (
          <Alert variant="error">
            Your USDC balance ({balance !== undefined ? formatUsdc(balance) : '…'} USDC) is less
            than the budget ({formatUsdc(budgetRaw)} USDC) plus gas margin. Top up your wallet
            before creating this auction.
          </Alert>
        )}
        {alreadyApproved && !approveConfirmed && (
          <Alert variant="info">
            The auction contract already has sufficient allowance ({formatUsdc(allowance ?? 0n)} USDC).
            You can skip the approve step and go straight to Create.
          </Alert>
        )}

        {/* Summary */}
        {!validationError && budgetRaw > 0n && (
          <Card className="p-4 bg-slate-50/80 space-y-1">
            <Row label="Budget" value={`${formatUsdc(budgetRaw)} USDC`} />
            <Row label="Bond per bidder" value={`${formatUsdc(bondRaw)} USDC`} />
            <Row label="Commit phase" value={`${commitMins} min`} />
            <Row label="Reveal phase" value={`${revealMins} min`} />
            <Row label="Delivery window" value={`${deliveryDays} days`} />
            <Row label="Review window" value={`${reviewDays} days`} />
            {balance !== undefined && (
              <Row
                label="Your balance"
                value={
                  <span className={insufficientBalance ? 'text-red-600 font-semibold' : ''}>
                    {formatUsdc(balance)} USDC
                  </span>
                }
              />
            )}
          </Card>
        )}
      </Card>

      {/* Step 1: Approve */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
            ${step >= 1 || alreadyApproved ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
            1
          </span>
          <span className="text-sm font-semibold text-slate-800">Approve USDC</span>
          {approveHash && (
            <span className="text-xs text-slate-400 ml-auto">
              <TxLink hash={approveHash} />
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 pl-8">
          Approves the auction contract to pull {budget || '0'} USDC from your wallet.
        </p>
        {approveWriteErr && !approveRevert && (
          <Alert variant="error">
            {decodeRevertError(approveWriteErr) || parseOnchainError(approveWriteErr)}
          </Alert>
        )}
        {approveRevert && (
          <Alert variant="error">
            {approveRevert.message}{' '}
            <a href={approveRevert.txUrl} target="_blank" rel="noopener noreferrer"
              className="underline font-medium">View on explorer</a>
          </Alert>
        )}
        <div className="pl-8">
          <Button
            onClick={handleApprove}
            disabled={!canApprove || !!approveConfirmed || alreadyApproved}
            fullWidth
          >
            {approveP || approveConfirming ? (
              <><Spinner /> {approveP ? 'Confirm in wallet…' : 'Confirming…'}</>
            ) : approveDropped ? (
              'Transaction dropped — retry'
            ) : approveConfirmed ? (
              'Approved ✓'
            ) : alreadyApproved ? (
              'Already approved'
            ) : (
              `Approve ${budget || '0'} USDC`
            )}
          </Button>
        </div>
      </Card>

      {/* Step 2: Create */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
            ${step >= 3 ? 'bg-green-500 text-white' : step >= 2 ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
            2
          </span>
          <span className="text-sm font-semibold text-slate-800">Create auction</span>
          {createHash && (
            <span className="text-xs text-slate-400 ml-auto">
              <TxLink hash={createHash} />
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 pl-8">
          Transfers the budget into the contract and opens the commit phase.
        </p>

        {createWriteErr && !createRevert && (
          <Alert variant="error">
            {decodeRevertError(createWriteErr) || parseOnchainError(createWriteErr)}
          </Alert>
        )}
        {createRevert && (
          <Alert variant="error">
            {createRevert.message}{' '}
            <a href={createRevert.txUrl} target="_blank" rel="noopener noreferrer"
              className="underline font-medium">View on explorer <ExternalLink size={11} className="inline" /></a>
          </Alert>
        )}

        <div className="pl-8">
          <Button onClick={handleCreate} disabled={!canCreate || createConfirmed} fullWidth>
            {createP || createConfirming ? (
              <><Spinner /> {createP ? 'Confirm in wallet…' : 'Confirming…'}</>
            ) : createDropped ? (
              'Transaction dropped — retry'
            ) : createConfirmed ? (
              'Created ✓'
            ) : (
              'Create auction'
            )}
          </Button>
        </div>

        {/* ── Auction created success ───────────────────────────────────── */}
        {createConfirmed && (
          <div className="pl-0 pt-2 space-y-3">
            <Alert variant="success">Auction created successfully!</Alert>

            {createdAuctionId !== null && (
              <div className="bg-green-50 border border-green-200 rounded-2xl p-4 space-y-3">
                {/* Prominent ID display */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-green-700 uppercase tracking-wider">
                    Auction ID
                  </span>
                  <span className="text-3xl font-bold font-mono text-green-900 tabular-nums">
                    #{createdAuctionId.toString()}
                  </span>
                </div>

                {/* Copy ID button */}
                <button
                  onClick={() => void handleCopyId()}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
                    border border-green-300 bg-white text-green-800 text-sm font-semibold
                    hover:bg-green-50 transition-colors"
                >
                  {copiedId ? <CheckCircle2 size={15} /> : <Copy size={15} />}
                  {copiedId ? 'Copied!' : `Copy ID: ${createdAuctionId.toString()}`}
                </button>

                {/* Shareable link */}
                <div className="space-y-1.5">
                  <p className="text-xs text-green-700 font-medium">Shareable link</p>
                  <div className="flex gap-2">
                    <code className="flex-1 text-xs bg-white border border-green-200 rounded-lg px-2 py-1.5
                      text-slate-600 font-mono break-all">
                      {buildShareUrl(createdAuctionId)}
                    </code>
                    <button
                      onClick={() => void handleCopyLink()}
                      className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg
                        border border-green-300 bg-white text-green-800 text-xs font-semibold
                        hover:bg-green-50 transition-colors"
                    >
                      {copiedLink ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                      {copiedLink ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>

                {/* Explorer link */}
                {createHash && (
                  <a
                    href={buildTxUrl(createHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-green-700 hover:text-green-900 underline"
                  >
                    <ExternalLink size={12} />
                    View transaction on {ARC.chainName} explorer
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </Card>
    </PageWrapper>
  )
}
