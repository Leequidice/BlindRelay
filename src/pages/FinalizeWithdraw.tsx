import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useEstimateGas } from 'wagmi'
import { toast } from 'sonner'
import {
  CHAIN_CONFIG,
  BLIND_RELAY_AUCTION_ABI,
  formatUsdc,
  CONTRACT_CONSTANTS,
} from '../lib/blindrelay'
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
import { encodeAbiParameters, parseAbiParameters } from 'viem'

const ARC = CHAIN_CONFIG
const GAS_FLOOR = CONTRACT_CONSTANTS.GAS_FLOOR
// The absolute minimum we'll ever send: 900 000 gas, even if the estimate is lower.
const GAS_MIN_HARD = 900_000n
// Gas estimate must be above this before we bother showing a warning.
const GAS_ESTIMATE_MIN = (GAS_FLOOR * 120n) / 100n

/** Returns the gas limit we will actually use: max(estimate × 1.2, 900 000). */
function calcGasLimit(estimate: bigint): bigint {
  const withBuffer = (estimate * 120n) / 100n
  return withBuffer > GAS_MIN_HARD ? withBuffer : GAS_MIN_HARD
}


export default function FinalizeWithdraw() {
  const { address } = useAccount()

  const [auctionIdStr, setAuctionIdStr] = useState('')
  const auctionId = (() => { try { const n = parseInt(auctionIdStr, 10); return isNaN(n) ? null : BigInt(n) } catch { return null } })()

  // Pending balance
  const { data: pendingRaw, refetch: refetchPending } = useReadContract({
    address: ARC.blindRelayAuctionAddress,
    abi: BLIND_RELAY_AUCTION_ABI,
    functionName: 'pendingBalances',
    args: address ? [address] : undefined,
    chainId: ARC.chainId,
    query: { enabled: !!address, refetchInterval: 10_000 },
  })
  const pending = pendingRaw as bigint | undefined

  // Gas estimate for finalize
  const { data: gasEstimate, isError: gasEstimateError } = useEstimateGas({
    to: ARC.blindRelayAuctionAddress,
    data: auctionId !== null
      ? ((() => {
          try {
            // encode finalize(uint256 auctionId)
            const sel = '0x2f865568' // keccak256("finalize(uint256)")[0:4] — pre-computed
            const encoded = encodeAbiParameters(parseAbiParameters('uint256'), [auctionId])
            return (sel + encoded.slice(2)) as `0x${string}`
          } catch { return undefined }
        })())
      : undefined,
    account: address,
    chainId: ARC.chainId,
    query: { enabled: auctionId !== null && !!address },
  })

  const estimatedGas = gasEstimate
  const gasTooLow = estimatedGas !== undefined && estimatedGas < GAS_ESTIMATE_MIN
  // max(estimate × 1.2, 900 000)
  const gasLimit = estimatedGas !== undefined ? calcGasLimit(estimatedGas) : GAS_MIN_HARD

  const [finalizeRevert, setFinalizeRevert] = useState<{ message: string; txUrl: string } | null>(null)
  const [withdrawRevert, setWithdrawRevert] = useState<{ message: string; txUrl: string } | null>(null)

  // Write: finalize
  const { writeContract: finalize, data: finalizeHash, isPending: finalizeP, error: finalizeError } = useWriteContract()
  const {
    isLoading: finalizeConfirming,
    isSuccess: finalizeConfirmedByWagmi,
    isError: finalizeDropped,
    data: finalizeReceipt,
  } = useWaitForTransactionReceipt({ hash: finalizeHash })

  // Write: withdraw
  const { writeContract: withdraw, data: withdrawHash, isPending: withdrawP, error: withdrawError } = useWriteContract()
  const {
    isLoading: withdrawConfirming,
    isSuccess: withdrawConfirmedByWagmi,
    isError: withdrawDropped,
    data: withdrawReceipt,
  } = useWaitForTransactionReceipt({ hash: withdrawHash })

  // Receipt-status checks
  const finalizeReverted = finalizeReceipt
    ? (() => {
        const outcome = checkReceipt(finalizeReceipt)
        if (!outcome.ok && !finalizeRevert) setFinalizeRevert({ message: outcome.message, txUrl: outcome.txUrl })
        return !outcome.ok
      })()
    : false
  const withdrawReverted = withdrawReceipt
    ? (() => {
        const outcome = checkReceipt(withdrawReceipt)
        if (!outcome.ok && !withdrawRevert) setWithdrawRevert({ message: outcome.message, txUrl: outcome.txUrl })
        return !outcome.ok
      })()
    : false

  const finalizeConfirmed = finalizeConfirmedByWagmi && !finalizeReverted
  const withdrawConfirmed = withdrawConfirmedByWagmi && !withdrawReverted

  function handleFinalize() {
    if (auctionId === null) return
    setFinalizeRevert(null)
    finalize(
      {
        address: ARC.blindRelayAuctionAddress,
        abi: BLIND_RELAY_AUCTION_ABI,
        functionName: 'finalize',
        args: [auctionId],
        chainId: ARC.chainId,
        gas: gasLimit,
      },
      {
        onSuccess: () => { toast.success('Finalized!'); void refetchPending() },
        onError: (e) => {
          const m = decodeRevertError(e) || parseOnchainError(e)
          if (m) toast.error(m)
        },
      },
    )
  }

  function handleWithdraw() {
    setWithdrawRevert(null)
    withdraw(
      {
        address: ARC.blindRelayAuctionAddress,
        abi: BLIND_RELAY_AUCTION_ABI,
        functionName: 'withdraw',
        chainId: ARC.chainId,
      },
      {
        onSuccess: () => { toast.success('Withdrawn!'); void refetchPending() },
        onError: (e) => {
          const m = decodeRevertError(e) || parseOnchainError(e)
          if (m) toast.error(m)
        },
      },
    )
  }

  const finalizeErrMsg = finalizeError ? (decodeRevertError(finalizeError) || parseOnchainError(finalizeError)) : null
  const isInsufficientGas = finalizeErrMsg?.toLowerCase().includes('gas')

  return (
    <PageWrapper>
      <PageTitle>Finalize & Withdraw</PageTitle>
      <p className="text-sm text-slate-500">
        After the reveal phase ends, anyone can call finalize. Then withdraw your pending USDC (bond
        refund, surplus, or forfeited bonds as buyer).
      </p>

      {/* Pending balance */}
      <Card className="p-5 space-y-3">
        <p className="text-sm font-semibold text-slate-700">Your pending balance</p>
        {!address ? (
          <p className="text-sm text-slate-400">Connect wallet to see your balance.</p>
        ) : (
          <>
            <div className="text-3xl font-bold font-mono tabular-nums text-slate-900">
              {pending !== undefined ? formatUsdc(pending) : '—'}{' '}
              <span className="text-lg font-medium text-slate-400">USDC</span>
            </div>
            {pending !== undefined && pending > 0n && (
              <>
                <Button onClick={handleWithdraw} disabled={withdrawP || withdrawConfirming || withdrawConfirmed || withdrawDropped} fullWidth>
                  {withdrawP || withdrawConfirming ? (
                    <><Spinner /> {withdrawP ? 'Confirm in wallet…' : 'Confirming…'}</>
                  ) : withdrawDropped ? (
                    'Transaction dropped — retry'
                  ) : withdrawConfirmed ? (
                    'Withdrawn!'
                  ) : (
                    `Withdraw ${formatUsdc(pending)} USDC`
                  )}
                </Button>
                {withdrawHash && (
                  <div className="text-xs text-slate-500 flex items-center gap-1">
                    Tx: <TxLink hash={withdrawHash} />
                  </div>
                )}
              </>
            )}
            {withdrawError && !withdrawRevert && (
              <Alert variant="error">
                {decodeRevertError(withdrawError) || parseOnchainError(withdrawError)}
              </Alert>
            )}
            {withdrawRevert && (
              <Alert variant="error">
                {withdrawRevert.message}{' '}
                <a href={withdrawRevert.txUrl} target="_blank" rel="noopener noreferrer"
                  className="underline font-medium">View on explorer</a>
              </Alert>
            )}
            {pending !== undefined && pending === 0n && (
              <p className="text-sm text-slate-400">Nothing to withdraw.</p>
            )}
          </>
        )}
      </Card>

      {/* Finalize */}
      <Card className="p-5 space-y-4">
        <p className="text-sm font-semibold text-slate-700">Finalize auction</p>
        <div>
          <Label htmlFor="faid">Auction ID</Label>
          <Input id="faid" type="number" min="0" placeholder="0" value={auctionIdStr} onChange={setAuctionIdStr} />
        </div>

        {/* Gas estimate info */}
        {auctionId !== null && !gasEstimateError && estimatedGas !== undefined && (
          <div className="bg-slate-50 rounded-xl p-3 space-y-1">
            <Row label="Estimated gas" value={estimatedGas.toLocaleString()} />
            <Row label="Contract gas floor" value={GAS_FLOOR.toLocaleString()} />
            <Row label="Hard minimum" value={GAS_MIN_HARD.toLocaleString()} />
            <Row
              label="Gas limit to send (max of ×1.2 or 900 000)"
              value={<span className="font-semibold text-slate-900">{gasLimit.toLocaleString()}</span>}
            />
          </div>
        )}

        {gasTooLow && (
          <Alert variant="warning">
            The gas estimate ({estimatedGas?.toLocaleString()}) is below the contract's required
            floor ({GAS_FLOOR.toLocaleString()}). This usually means the auction is not yet ready
            to finalize (reveal phase may still be open). If you believe finalize should succeed,
            the transaction will be sent with {gasLimit.toLocaleString()} gas anyway.
          </Alert>
        )}

        {gasEstimateError && auctionId !== null && (
          <Alert variant="warning">
            Could not estimate gas — the auction may not be in the right state for finalize yet, or
            the reveal phase has not ended.
          </Alert>
        )}

        {isInsufficientGas && (
          <Alert variant="error">
            The transaction reverted with InsufficientGasForFinalize. The app sent {gasLimit.toLocaleString()} gas.
            This can happen if the gas estimate was inaccurate. Try clicking Finalize again — the
            app will re-estimate and send with max(estimate × 1.2, 900 000).
          </Alert>
        )}
        {finalizeErrMsg && !isInsufficientGas && (
          <Alert variant="error">{finalizeErrMsg}</Alert>
        )}
        {finalizeRevert && (
          <Alert variant="error">
            {finalizeRevert.message}{' '}
            <a href={finalizeRevert.txUrl} target="_blank" rel="noopener noreferrer"
              className="underline font-medium">View on explorer</a>
          </Alert>
        )}

        <Button
          onClick={handleFinalize}
          disabled={auctionId === null || finalizeP || finalizeConfirming || finalizeConfirmed || finalizeDropped}
          fullWidth
        >
          {finalizeP || finalizeConfirming ? (
            <><Spinner /> {finalizeP ? 'Confirm in wallet…' : 'Confirming…'}</>
          ) : finalizeDropped ? (
            'Transaction dropped — retry'
          ) : finalizeConfirmed ? (
            'Finalized!'
          ) : (
            'Finalize auction'
          )}
        </Button>

        {finalizeHash && (
          <div className="text-xs text-slate-500 flex items-center gap-1">
            Tx: <TxLink hash={finalizeHash} />
          </div>
        )}
        {finalizeConfirmed && (
          <Alert variant="success">
            Auction finalized. Refresh your pending balance above to see your refund or surplus.
          </Alert>
        )}
      </Card>
    </PageWrapper>
  )
}
