import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
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
import { ExternalLink } from 'lucide-react'

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

export default function TaskView() {
  const { address } = useAccount()

  // consumePendingTaskId() reads a module-level variable set by "View Task" in AuctionView.
  // Calling it in the useState initializer is safe — it runs once at component mount.
  const [taskIdStr, setTaskIdStr] = useState(() => consumePendingTaskId() ?? '')

  const [deliveryText, setDeliveryText] = useState('')
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [actionRevert, setActionRevert] = useState<{ message: string; txUrl: string } | null>(null)

  const taskId = (() => {
    try { const n = parseInt(taskIdStr, 10); return isNaN(n) ? null : BigInt(n) }
    catch { return null }
  })()

  const { data: taskRaw, isLoading, isError, refetch } = useReadContract({
    address: ARC.taskEscrowAddress,
    abi: TASK_ESCROW_ABI,
    functionName: 'tasks',
    args: taskId !== null ? [taskId] : undefined,
    chainId: ARC.chainId,
    query: { enabled: taskId !== null, refetchInterval: 8_000 },
  })

  // Parse the raw result — handles both named-object and positional-tuple returns.
  // Returns null if the data isn't loaded yet, or if the task doesn't exist
  // (detected by zero buyer address or zero price).
  const task = (() => {
    if (taskRaw === undefined) return null
    try {
      const t = parseTask(taskRaw)
      // A task that doesn't exist returns all-zero values from the contract.
      if (isZeroAddress(t.buyer) && t.price === 0n) return null
      return t
    } catch {
      return null
    }
  })()

  // Distinguish "exists but hasn't loaded" from "loaded but empty"
  const taskNotFound = taskRaw !== undefined && task === null && taskId !== null && !isError

  const now = useNow()

  // Null-safe role checks — never call .toLowerCase() on a missing address
  const addrLower = address?.toLowerCase()
  const isBuyer    = !!task && !!addrLower && task.buyer.toLowerCase()    === addrLower
  const isProvider = !!task && !!addrLower && task.provider.toLowerCase() === addrLower

  const reviewDeadline = task ? Number(task.deliveredAt) + Number(task.reviewWindow) : 0
  const deadlinePassed = task ? now > Number(task.deadline) : false
  const reviewExpired  = task ? now > reviewDeadline : false

  // Countdown to next state change
  const countdownTarget: number | null = (() => {
    if (!task) return null
    const s = task.status
    if (s === (TaskStatus.Funded    as number) && !deadlinePassed) return Number(task.deadline)
    if (s === (TaskStatus.Delivered as number) && !reviewExpired)  return reviewDeadline
    return null
  })()
  const countdownLabel: string | null = (() => {
    if (!task) return null
    const s = task.status
    if (s === (TaskStatus.Funded    as number) && !deadlinePassed) return 'Delivery deadline'
    if (s === (TaskStatus.Delivered as number) && !reviewExpired)  return 'Review window closes'
    return null
  })()

  // Action hooks
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
  } = useWaitForTransactionReceipt({ hash: actionHash })

  // Receipt-status check
  if (actionReceipt) {
    const outcome = checkReceipt(actionReceipt)
    if (!outcome.ok && !actionRevert) {
      setActionRevert({ message: outcome.message, txUrl: outcome.txUrl })
    }
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
        onSuccess: (hash) => {
          toast.success(`${functionName} confirmed!`)
          setLastTx(hash)
          void refetch()
        },
        onError: (e) => {
          const m = decodeRevertError(e) || parseOnchainError(e)
          if (m) toast.error(m)
        },
      },
    )
  }

  function handleSubmitDelivery() {
    if (!deliveryText.trim()) { toast.error('Enter delivery content before submitting.'); return }
    const deliveryHash = keccak256(toHex(deliveryText.trim()))
    doWrite('submitDelivery', [taskId!, deliveryHash])
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
  const anyDropped = actionDropped

  return (
    <PageWrapper>
      <PageTitle>Task View</PageTitle>
      <p className="text-sm text-slate-500">
        View and act on a TaskEscrow task. Actions are shown only for the right role and only
        when the state allows. Connect the buyer or provider wallet to see your options.
      </p>

      {/* No wallet connected */}
      {!address && (
        <Alert variant="info">
          Connect your wallet to see role-based actions (buyer or provider).
        </Alert>
      )}

      <Card className="p-5 space-y-3">
        <Label htmlFor="tid">Task ID</Label>
        <div className="flex gap-2">
          <Input
            id="tid"
            type="number"
            min="0"
            placeholder="0"
            value={taskIdStr}
            onChange={setTaskIdStr}
          />
          <Button variant="secondary" onClick={() => void refetch()}>Refresh</Button>
        </div>
        {taskIdStr === '' && (
          <p className="text-xs text-slate-400">Enter a task ID and press Refresh, or click "Open Task" from a finalized auction.</p>
        )}
      </Card>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-8"><Spinner size={24} /></div>
      )}

      {/* Read error */}
      {isError && taskId !== null && (
        <Alert variant="error">
          Could not load task {String(taskId)}. Check your RPC connection.
        </Alert>
      )}

      {/* Task not found (all-zero return from contract) */}
      {taskNotFound && (
        <Alert variant="warning">
          Task {String(taskId)} does not exist yet. Task IDs start at 0 and are assigned by the
          escrow when an auction is finalized.
        </Alert>
      )}

      {/* Task found */}
      {task && (
        <>
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-mono text-slate-400">Task #{String(taskId)}</p>
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
                <a
                  href={`${ARC.explorerBase}/address/${task.buyer}`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline flex items-center gap-1 justify-end"
                >
                  {formatAddress(task.buyer)}
                  {isBuyer && <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded-full">You</span>}
                  <ExternalLink size={10} />
                </a>
              } />
              <Row label="Provider" value={
                <a
                  href={`${ARC.explorerBase}/address/${task.provider}`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline flex items-center gap-1 justify-end"
                >
                  {formatAddress(task.provider)}
                  {isProvider && <span className="text-xs bg-violet-100 text-violet-700 px-1 rounded-full">You</span>}
                  <ExternalLink size={10} />
                </a>
              } />
              <Row label="Price" value={`${formatUsdc(task.price)} USDC`} />
              <Row label="Deadline" value={new Date(Number(task.deadline) * 1000).toLocaleString()} />
              <Row
                label="Review window"
                value={`${Math.round(Number(task.reviewWindow) / 3600)} h`}
              />
              {task.status >= (TaskStatus.Delivered as number) && task.deliveredAt > 0n && (
                <Row
                  label="Delivered at"
                  value={new Date(Number(task.deliveredAt) * 1000).toLocaleString()}
                />
              )}
              {task.status >= (TaskStatus.Delivered as number) && task.deliveryHash !== ZERO_BYTES32 && (
                <Row label="Delivery hash" value={
                  <span className="font-mono text-xs break-all">{task.deliveryHash}</span>
                } />
              )}
            </div>
          </Card>

          {/* Actions */}
          <Card className="p-5 space-y-4">
            <p className="text-sm font-semibold text-slate-700">Actions</p>

            {/* Submit delivery — provider only, Funded, before deadline */}
            {isProvider && task.status === (TaskStatus.Funded as number) && (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  {deadlinePassed
                    ? 'Delivery deadline has passed. You can no longer submit.'
                    : 'Submit a hash of your delivery content.'}
                </p>
                {!deadlinePassed && (
                  <>
                    <Label htmlFor="del">Delivery description / URL</Label>
                    <Textarea
                      id="del"
                      placeholder="Paste your deliverable URL, IPFS CID, or a description. This will be hashed."
                      value={deliveryText}
                      onChange={setDeliveryText}
                    />
                    {deliveryText.trim() && (
                      <p className="text-xs text-slate-400 font-mono break-all">
                        keccak256: {keccak256(toHex(deliveryText.trim()))}
                      </p>
                    )}
                    <Button
                      onClick={handleSubmitDelivery}
                      disabled={anyBusy || !canSubmit}
                      fullWidth
                    >
                      {anyBusy ? <><Spinner /> Confirming…</> : 'Submit delivery'}
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* Accept — buyer, Delivered, within review window */}
            {isBuyer && task.status === (TaskStatus.Delivered as number) && !reviewExpired && (
              <Button onClick={handleAccept} disabled={anyBusy} fullWidth>
                {anyBusy ? <><Spinner /> Confirming…</> : 'Accept delivery (pay provider)'}
              </Button>
            )}

            {/* Reject — buyer, Delivered, within review window */}
            {isBuyer && task.status === (TaskStatus.Delivered as number) && !reviewExpired && (
              <Button onClick={handleReject} disabled={anyBusy} variant="danger" fullWidth>
                {anyBusy ? <><Spinner /> Confirming…</> : 'Reject delivery (dispute)'}
              </Button>
            )}

            {/* Release — anyone, Delivered, after review window */}
            {task.status === (TaskStatus.Delivered as number) && reviewExpired && (
              <div className="space-y-2">
                <Alert variant="info">
                  Review window has expired. Anyone can release the payment to the provider.
                </Alert>
                <Button onClick={handleRelease} disabled={anyBusy} fullWidth>
                  {anyBusy ? <><Spinner /> Confirming…</> : 'Release payment to provider'}
                </Button>
              </div>
            )}

            {/* Reclaim — buyer only, Funded, after deadline */}
            {isBuyer && task.status === (TaskStatus.Funded as number) && deadlinePassed && (
              <div className="space-y-2">
                <Alert variant="info">
                  Delivery deadline passed with no delivery. You can reclaim your funds.
                </Alert>
                <Button onClick={handleReclaim} disabled={anyBusy} fullWidth>
                  {anyBusy ? <><Spinner /> Confirming…</> : `Reclaim ${formatUsdc(task.price)} USDC`}
                </Button>
              </div>
            )}

            {/* Nothing available for this wallet / state */}
            {!canSubmit && !canAccept && !canReject && !canRelease && !canReclaim &&
              task.status !== (TaskStatus.Settled as number) &&
              task.status !== (TaskStatus.Reclaimed as number) &&
              task.status !== (TaskStatus.Disputed as number) && (
              <p className="text-sm text-slate-400">
                {!address
                  ? 'Connect wallet to see available actions.'
                  : 'No actions available for your role in the current state.'}
              </p>
            )}

            {(task.status === (TaskStatus.Settled   as number) ||
              task.status === (TaskStatus.Reclaimed as number)) && (
              <Alert variant="success">This task is complete.</Alert>
            )}

            {task.status === (TaskStatus.Disputed as number) && (
              <Alert variant="error">
                This task is disputed. Disputed funds are permanently locked in v1 — there is no
                on-chain resolution path.
              </Alert>
            )}

            {anyDropped && !anyBusy && (
              <Alert variant="warning">
                Transaction was dropped or replaced. You can retry the action.
              </Alert>
            )}

            {actionWriteErr && !actionRevert && (
              <Alert variant="error">
                {decodeRevertError(actionWriteErr) || parseOnchainError(actionWriteErr)}
              </Alert>
            )}
            {actionRevert && (
              <Alert variant="error">
                {actionRevert.message}{' '}
                <a
                  href={actionRevert.txUrl}
                  target="_blank" rel="noopener noreferrer"
                  className="underline font-medium"
                >
                  View on explorer
                </a>
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
    </PageWrapper>
  )
}
