import { useState, useEffect, useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, usePublicClient } from 'wagmi'
import { toast } from 'sonner'
import { keccak256, toHex } from 'viem'
import {
  CHAIN_CONFIG,
  TASK_ESCROW_ABI,
  parseTask,
  isZeroAddress,
  formatUsdc,
  formatAddress,
  formatCountdown,
  TaskStatus,
  type Task,
} from '../lib/blindrelay'
import { consumePendingTaskId } from '../App'
import { useNow } from '../lib/useNow'
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
import { ExternalLink, Copy, Check } from 'lucide-react'

const ARC = CHAIN_CONFIG

const STATUS_LABELS: Record<number, string> = {
  0: 'Funded',
  1: 'Delivered',
  2: 'Settled',
  3: 'Reclaimed',
  4: 'Disputed',
}

const STATUS_COLORS: Record<number, string> = {
  0: 'bg-blue-100 text-blue-700',
  1: 'bg-violet-100 text-violet-700',
  2: 'bg-green-100 text-green-700',
  3: 'bg-slate-100 text-slate-500',
  4: 'bg-red-100 text-red-600',
}

const ZERO_BYTES32 = '0x' + '00'.repeat(32)

// ─── Share link ───────────────────────────────────────────────────────────────

function ShareLink({ taskId }: { taskId: bigint }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${window.location.pathname}#task=${taskId.toString()}`

  function handleCopy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
      title="Copy shareable link"
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  )
}

// ─── Next-action text ─────────────────────────────────────────────────────────

function NextAction({
  task, isBuyer, isProvider, deadlinePassed, reviewExpired, reviewDeadline,
}: {
  task: Task; isBuyer: boolean; isProvider: boolean
  deadlinePassed: boolean; reviewExpired: boolean
  reviewDeadline: number
}) {
  const s = task.status

  if (s === (TaskStatus.Funded as number)) {
    if (isProvider && !deadlinePassed)
      return <Alert variant="info">Your turn: submit your delivery before the deadline.</Alert>
    if (isProvider && deadlinePassed)
      return <Alert variant="warning">Delivery deadline has passed. The buyer can now reclaim the funds.</Alert>
    if (isBuyer && !deadlinePassed)
      return <Alert variant="info">Waiting for the provider to submit delivery. Deadline: {new Date(Number(task.deadline) * 1000).toLocaleString()}.</Alert>
    if (isBuyer && deadlinePassed)
      return <Alert variant="info">Deadline passed with no delivery. You can reclaim the funds.</Alert>
    return <Alert variant="info">Waiting for provider to deliver by {new Date(Number(task.deadline) * 1000).toLocaleString()}.</Alert>
  }

  if (s === (TaskStatus.Delivered as number)) {
    if (isBuyer && !reviewExpired)
      return <Alert variant="info">Delivered. Review and accept or reject before {new Date(reviewDeadline * 1000).toLocaleString()} ({formatCountdown(reviewDeadline)} left).</Alert>
    if (isBuyer && reviewExpired)
      return <Alert variant="info">Review window expired. Anyone can release the payment.</Alert>
    if (isProvider && !reviewExpired)
      return <Alert variant="info">Delivery submitted. Waiting for buyer to review (deadline {formatCountdown(reviewDeadline)}).</Alert>
    if (reviewExpired)
      return <Alert variant="info">Review window expired. Anyone can release the payment to the provider.</Alert>
    return <Alert variant="info">Waiting for buyer review.</Alert>
  }

  if (s === (TaskStatus.Settled as number))
    return <Alert variant="success">Settled — payment released to provider.</Alert>
  if (s === (TaskStatus.Reclaimed as number))
    return <Alert variant="success">Reclaimed — buyer recovered the funds.</Alert>
  if (s === (TaskStatus.Disputed as number))
    return <Alert variant="error">Disputed — no on-chain resolution path in v1.</Alert>

  return null
}

// ─── My Tasks scan ────────────────────────────────────────────────────────────
//
// Reads taskCount(), then walks the last 50 tasks looking for ones where the
// connected wallet is the buyer or provider.  No getLogs needed.

interface TaskEntry { id: bigint; task: Task }

function MyTasks({
  address, onSelect,
}: { address: string; onSelect: (id: bigint) => void }) {
  const publicClient = usePublicClient({ chainId: ARC.chainId })
  const now = useNow()
  const [entries, setEntries]   = useState<TaskEntry[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanned,  setScanned]  = useState(false)

  const scan = useCallback(async () => {
    if (!publicClient || !address) return
    setScanning(true)
    try {
      const countRaw = await publicClient.readContract({
        address: ARC.taskEscrowAddress,
        abi: TASK_ESCROW_ABI,
        functionName: 'taskCount',
      }) as bigint

      const scanLimit = 50n
      const start = countRaw > 0n ? countRaw - 1n : 0n
      const end   = countRaw > scanLimit ? countRaw - scanLimit : 0n
      const addrL = address.toLowerCase()

      const found: TaskEntry[] = []
      for (let i = start; i >= end; i--) {
        const raw = await publicClient.readContract({
          address: ARC.taskEscrowAddress,
          abi: TASK_ESCROW_ABI,
          functionName: 'tasks',
          args: [i],
        })
        const t = parseTask(raw)
        if (isZeroAddress(t.buyer) && t.price === 0n) continue
        if (t.buyer.toLowerCase() === addrL || t.provider.toLowerCase() === addrL) {
          found.push({ id: i, task: t })
        }
      }
      setEntries(found)
    } catch { /* RPC error — silently skip */ }
    setScanning(false)
    setScanned(true)
  }, [publicClient, address])

  useEffect(() => { void scan() }, [scan])

  if (scanning) return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner size={16} /> Scanning your recent tasks…
      </div>
    </Card>
  )

  if (scanned && entries.length === 0) return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-slate-700 mb-1">My tasks</p>
      <p className="text-sm text-slate-400">No recent tasks found for your wallet (last 50 tasks scanned).</p>
    </Card>
  )

  if (entries.length === 0) return null

  return (
    <Card className="p-5 space-y-3">
      <p className="text-sm font-semibold text-slate-700">My tasks</p>
      <div>
        {entries.map(({ id, task: t }) => {
          const addrL = address.toLowerCase()
          const role = t.buyer.toLowerCase() === addrL ? 'Buyer' : 'Provider'
          const isDeadlinePassed = now > Number(t.deadline)
          const reviewDl = Number(t.deliveredAt) + Number(t.reviewWindow)
          const isReviewExpired = t.deliveredAt > 0n && now > reviewDl

          // Next countdown
          let countdownTarget: number | null = null
          let countdownLabel = ''
          if (t.status === (TaskStatus.Funded as number) && !isDeadlinePassed) {
            countdownTarget = Number(t.deadline); countdownLabel = 'deadline'
          } else if (t.status === (TaskStatus.Delivered as number) && !isReviewExpired && t.deliveredAt > 0n) {
            countdownTarget = reviewDl; countdownLabel = 'review closes'
          }

          return (
            <button
              key={id.toString()}
              onClick={() => onSelect(id)}
              className="w-full flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-slate-50
                border border-transparent hover:border-slate-200 transition-all text-left"
            >
              <span className="font-mono text-sm font-bold text-slate-900 w-10 shrink-0">#{id.toString()}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[t.status] ?? 'bg-slate-100 text-slate-500'}`}>
                {STATUS_LABELS[t.status] ?? 'Unknown'}
              </span>
              <span className="text-xs text-slate-500 shrink-0">{role}</span>
              <span className="text-xs text-slate-500 flex-1 text-right font-mono tabular-nums truncate">
                {formatUsdc(t.price)} USDC
              </span>
              {countdownTarget !== null && (
                <span className="text-xs font-mono text-slate-400 tabular-nums shrink-0 text-right">
                  {countdownLabel} {formatCountdown(countdownTarget)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

// ─── TaskView ─────────────────────────────────────────────────────────────────

export default function TaskView() {
  const { address } = useAccount()

  const [taskIdStr, setTaskIdStr] = useState(() => consumePendingTaskId() ?? '')
  const [deliveryText, setDeliveryText] = useState('')
  const [lastTx,       setLastTx]       = useState<string | null>(null)
  const [actionRevert, setActionRevert] = useState<{ message: string; txUrl: string } | null>(null)

  const taskId = (() => {
    try { const n = parseInt(taskIdStr, 10); return isNaN(n) ? null : BigInt(n) }
    catch { return null }
  })()

  // Keep #task=N in sync with the input
  useEffect(() => {
    if (taskId !== null) {
      window.history.replaceState(null, '', `#task=${taskId.toString()}`)
    }
  }, [taskId])

  const { data: taskRaw, isLoading, isError, refetch } = useReadContract({
    address: ARC.taskEscrowAddress,
    abi: TASK_ESCROW_ABI,
    functionName: 'tasks',
    args: taskId !== null ? [taskId] : undefined,
    chainId: ARC.chainId,
    query: { enabled: taskId !== null, refetchInterval: 8_000 },
  })

  const task = (() => {
    if (taskRaw === undefined) return null
    try {
      const t = parseTask(taskRaw)
      if (isZeroAddress(t.buyer) && t.price === 0n) return null
      return t
    } catch { return null }
  })()

  const taskNotFound = taskRaw !== undefined && task === null && taskId !== null && !isError
  const now = useNow()

  const addrLower = address?.toLowerCase()
  const isBuyer    = !!task && !!addrLower && task.buyer.toLowerCase()    === addrLower
  const isProvider = !!task && !!addrLower && task.provider.toLowerCase() === addrLower

  const reviewDeadline = task ? Number(task.deliveredAt) + Number(task.reviewWindow) : 0
  const deadlinePassed = task ? now > Number(task.deadline)  : false
  const reviewExpired  = task ? (task.deliveredAt > 0n && now > reviewDeadline) : false

  const countdownTarget: number | null = (() => {
    if (!task) return null
    const s = task.status
    if (s === (TaskStatus.Funded    as number) && !deadlinePassed) return Number(task.deadline)
    if (s === (TaskStatus.Delivered as number) && !reviewExpired && task.deliveredAt > 0n) return reviewDeadline
    return null
  })()
  const countdownLabel: string | null = (() => {
    if (!task) return null
    const s = task.status
    if (s === (TaskStatus.Funded    as number) && !deadlinePassed) return 'Delivery deadline'
    if (s === (TaskStatus.Delivered as number) && !reviewExpired)  return 'Review window closes'
    return null
  })()

  const {
    writeContract: writeAction,
    data: actionHash,
    isPending: actionP,
    error: actionWriteErr,
  } = useWriteContract()
  const {
    isLoading: actionConfirming,
    isError: actionDropped,
    data: actionReceipt,
  } = useWaitForTransactionReceipt({ hash: actionHash, chainId: ARC.chainId })

  if (actionReceipt) {
    const outcome = checkReceipt(actionReceipt)
    if (!outcome.ok && !actionRevert) setActionRevert({ message: outcome.message, txUrl: outcome.txUrl })
  }

  function doWrite(functionName: string, args: unknown[] = []) {
    setActionRevert(null)
    writeAction(
      {
        address: ARC.taskEscrowAddress,
        abi: TASK_ESCROW_ABI,
        functionName,
        args,
        chainId: ARC.chainId,
      },
      {
        onSuccess: (hash) => { toast.success(`${functionName} confirmed!`); setLastTx(hash); void refetch() },
        onError: (e) => { const m = decodeRevertError(e) || parseOnchainError(e); if (m) toast.error(m) },
      },
    )
  }

  function handleSubmitDelivery() {
    if (!deliveryText.trim()) { toast.error('Enter delivery content before submitting.'); return }
    doWrite('submitDelivery', [taskId!, keccak256(toHex(deliveryText.trim()))])
  }
  function handleAccept()  { doWrite('accept',  [taskId!]) }
  function handleReject()  { doWrite('reject',  [taskId!]) }
  function handleRelease() { doWrite('release', [taskId!]) }
  function handleReclaim() { doWrite('reclaim', [taskId!]) }

  const S = task?.status
  const canSubmit  = isProvider && S === (TaskStatus.Funded    as number) && !deadlinePassed
  const canAccept  = isBuyer    && S === (TaskStatus.Delivered as number) && !reviewExpired
  const canReject  = isBuyer    && S === (TaskStatus.Delivered as number) && !reviewExpired
  const canRelease = S === (TaskStatus.Delivered as number) && reviewExpired
  const canReclaim = isBuyer    && S === (TaskStatus.Funded    as number) && deadlinePassed
  const anyBusy    = actionP || actionConfirming

  return (
    <PageWrapper>
      <PageTitle>Task View</PageTitle>
      <p className="text-sm text-slate-500">
        View and act on a TaskEscrow task. Actions are shown only for the right role and only
        when the state allows. Connect the buyer or provider wallet to see your options.
      </p>

      {!address && (
        <Alert variant="info">Connect your wallet to see role-based actions and your task list.</Alert>
      )}

      {/* Task ID input */}
      <Card className="p-5 space-y-3">
        <Label htmlFor="tid">Task ID</Label>
        <div className="flex gap-2">
          <Input id="tid" type="number" min="0" placeholder="0" value={taskIdStr} onChange={setTaskIdStr} />
          <Button variant="secondary" onClick={() => void refetch()}>Refresh</Button>
        </div>
        {taskIdStr === '' && (
          <p className="text-xs text-slate-400">Enter a task ID, click a task in My tasks below, or follow an "Open Task" link from a finalized auction.</p>
        )}
      </Card>

      {isLoading && <div className="flex justify-center py-8"><Spinner size={24} /></div>}
      {isError && taskId !== null && (
        <Alert variant="error">Could not load task {String(taskId)}. Check your RPC connection.</Alert>
      )}
      {taskNotFound && (
        <Alert variant="warning">
          Task {String(taskId)} does not exist yet. Task IDs start at 0 and are assigned by the escrow when an auction is finalized.
        </Alert>
      )}

      {task && (
        <>
          {/* Task header */}
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-xs font-mono text-slate-400">Task #{String(taskId)}</p>
                <ShareLink taskId={taskId!} />
              </div>
              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${STATUS_COLORS[task.status] ?? 'bg-slate-100 text-slate-500'}`}>
                {STATUS_LABELS[task.status] ?? 'Unknown'}
              </span>
            </div>

            {countdownTarget !== null && countdownLabel !== null && (
              <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2">
                <span className="text-xs text-slate-500">{countdownLabel}</span>
                <span className="text-sm font-mono font-bold text-slate-900 tabular-nums">
                  {formatCountdown(countdownTarget)}
                </span>
              </div>
            )}

            <div className="space-y-0.5">
              <Row label="Buyer" value={
                <a href={`${ARC.explorerBase}/address/${task.buyer}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline flex items-center gap-1 justify-end">
                  {formatAddress(task.buyer)}
                  {isBuyer && <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded-full">You</span>}
                  <ExternalLink size={10} />
                </a>
              } />
              <Row label="Provider" value={
                <a href={`${ARC.explorerBase}/address/${task.provider}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline flex items-center gap-1 justify-end">
                  {formatAddress(task.provider)}
                  {isProvider && <span className="text-xs bg-violet-100 text-violet-700 px-1 rounded-full">You</span>}
                  <ExternalLink size={10} />
                </a>
              } />
              <Row label="Price"   value={`${formatUsdc(task.price)} USDC`} />
              <Row label="Deadline" value={new Date(Number(task.deadline) * 1000).toLocaleString()} />
              <Row label="Review window" value={`${Math.round(Number(task.reviewWindow) / 3600)} h`} />
              {task.status >= (TaskStatus.Delivered as number) && task.deliveredAt > 0n && (
                <Row label="Delivered at" value={new Date(Number(task.deliveredAt) * 1000).toLocaleString()} />
              )}
              {task.status >= (TaskStatus.Delivered as number) && task.deliveryHash !== ZERO_BYTES32 && (
                <Row label="Delivery hash" value={<span className="font-mono text-xs break-all">{task.deliveryHash}</span>} />
              )}
            </div>
          </Card>

          {/* Next-action banner */}
          <NextAction
            task={task}
            isBuyer={isBuyer}
            isProvider={isProvider}
            deadlinePassed={deadlinePassed}
            reviewExpired={reviewExpired}
            reviewDeadline={reviewDeadline}
          />

          {/* Actions card */}
          <Card className="p-5 space-y-4">
            <p className="text-sm font-semibold text-slate-700">Actions</p>

            {/* Submit delivery */}
            {isProvider && task.status === (TaskStatus.Funded as number) && (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  {deadlinePassed ? 'Delivery deadline has passed.' : 'Submit a hash of your delivery content.'}
                </p>
                {!deadlinePassed && (
                  <>
                    <Label htmlFor="del">Delivery description / URL</Label>
                    <Textarea id="del" placeholder="Paste your deliverable URL, IPFS CID, or a description." value={deliveryText} onChange={setDeliveryText} />
                    {deliveryText.trim() && (
                      <p className="text-xs text-slate-400 font-mono break-all">
                        keccak256: {keccak256(toHex(deliveryText.trim()))}
                      </p>
                    )}
                    <Button onClick={handleSubmitDelivery} disabled={anyBusy || !canSubmit} fullWidth>
                      {anyBusy ? <><Spinner /> Confirming…</> : 'Submit delivery'}
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* Accept */}
            {isBuyer && task.status === (TaskStatus.Delivered as number) && !reviewExpired && (
              <Button onClick={handleAccept} disabled={anyBusy} fullWidth>
                {anyBusy ? <><Spinner /> Confirming…</> : 'Accept delivery (pay provider)'}
              </Button>
            )}

            {/* Reject */}
            {isBuyer && task.status === (TaskStatus.Delivered as number) && !reviewExpired && (
              <Button onClick={handleReject} disabled={anyBusy} variant="danger" fullWidth>
                {anyBusy ? <><Spinner /> Confirming…</> : 'Reject delivery (dispute)'}
              </Button>
            )}

            {/* Release */}
            {task.status === (TaskStatus.Delivered as number) && reviewExpired && (
              <div className="space-y-2">
                <Alert variant="info">Review window expired. Anyone can release payment to the provider.</Alert>
                <Button onClick={handleRelease} disabled={anyBusy} fullWidth>
                  {anyBusy ? <><Spinner /> Confirming…</> : 'Release payment to provider'}
                </Button>
              </div>
            )}

            {/* Reclaim */}
            {isBuyer && task.status === (TaskStatus.Funded as number) && deadlinePassed && (
              <div className="space-y-2">
                <Alert variant="info">Delivery deadline passed. You can reclaim your funds.</Alert>
                <Button onClick={handleReclaim} disabled={anyBusy} fullWidth>
                  {anyBusy ? <><Spinner /> Confirming…</> : `Reclaim ${formatUsdc(task.price)} USDC`}
                </Button>
              </div>
            )}

            {/* Nothing available */}
            {!canSubmit && !canAccept && !canReject && !canRelease && !canReclaim
              && task.status !== (TaskStatus.Settled   as number)
              && task.status !== (TaskStatus.Reclaimed as number)
              && task.status !== (TaskStatus.Disputed  as number) && (
              <p className="text-sm text-slate-400">
                {!address ? 'Connect wallet to see available actions.' : 'No actions available for your role in the current state.'}
              </p>
            )}

            {(task.status === (TaskStatus.Settled   as number) ||
              task.status === (TaskStatus.Reclaimed as number)) && (
              <Alert variant="success">This task is complete.</Alert>
            )}
            {task.status === (TaskStatus.Disputed as number) && (
              <Alert variant="error">Disputed — no on-chain resolution path in v1.</Alert>
            )}
            {actionDropped && !anyBusy && (
              <Alert variant="warning">Transaction was dropped or replaced. You can retry.</Alert>
            )}
            {actionWriteErr && !actionRevert && (
              <Alert variant="error">{decodeRevertError(actionWriteErr) || parseOnchainError(actionWriteErr)}</Alert>
            )}
            {actionRevert && (
              <Alert variant="error">
                {actionRevert.message}{' '}
                <a href={actionRevert.txUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">View on explorer</a>
              </Alert>
            )}
            {actionHash && (
              <div className="text-xs text-slate-500 flex items-center gap-1 pt-1">
                Last tx: <TxLink hash={actionHash} />
              </div>
            )}
            {lastTx && actionHash !== lastTx && (
              <div className="text-xs text-slate-500 flex items-center gap-1">
                Confirmed: <TxLink hash={lastTx} />
              </div>
            )}
          </Card>
        </>
      )}

      {/* My tasks — shows tasks where the connected wallet is buyer or provider */}
      {address && <MyTasks address={address} onSelect={(id) => { setTaskIdStr(id.toString()) }} />}
    </PageWrapper>
  )
}
