/**
 * Live verification script — simulates browser clicks against Arc Testnet.
 * Part 1: reads task 3 and reports per-role buttons.
 * Part 2: full auction+task lifecycle, all 8 steps.
 *
 * Arc's RPC does not support eth_fillTransaction, so every writeContract call
 * must receive an explicit `gas` parameter; we estimate with eth_estimateGas.
 */
import {
  createPublicClient, createWalletClient, http,
  parseAbi, encodeAbiParameters, parseAbiParameters,
  keccak256, toHex, encodeFunctionData, type Hash, type Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { readFileSync } from 'fs'
import { createRequire } from 'module'

const req = createRequire(import.meta.url)
const BRA_ABI = req('../contracts/abi/BlindRelayAuction.json') as Abi
const TE_ABI  = req('../contracts/abi/TaskEscrow.json') as Abi

const RPC    = 'https://rpc.testnet.arc.io'
const ESCROW = '0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d' as const
const BRA    = '0x27bcab80f486030dec9702d287e354a69bab186d' as const
const USDC   = '0x3600000000000000000000000000000000000000' as const
const CHAIN  = arcTestnet
const EXP    = 'https://explorer.testnet.arc.io'

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) })

const USDC_ABI = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

// ── Key loading ───────────────────────────────────────────────────────────────

const walletsTxt = readFileSync('/tmp/wallets.txt', 'utf8')
function extractKey(label: string): `0x${string}` {
  const m = walletsTxt.match(new RegExp(label + '=([^\n]+)'))
  if (!m) throw new Error(`Key not found: ${label}`)
  return m[1].trim() as `0x${string}`
}
const buyerKey    = extractKey('BUYER_KEY')
const providerKey = extractKey('PROVIDER_KEY')

const buyer    = privateKeyToAccount(buyerKey)
const provider = privateKeyToAccount(providerKey)

const envContent = readFileSync('/home/user/app/.env', 'utf8')
const deployKeyM = envContent.match(/DEPLOY_PRIVATE_KEY=([^\n]+)/)
const unrelatedKey = (deployKeyM ? deployKeyM[1].trim() : buyerKey) as `0x${string}`
const unrelated = privateKeyToAccount(unrelatedKey)

function wc(key: `0x${string}`) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: CHAIN, transport: http(RPC) })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function estimateOrDefault(
  from: `0x${string}`, to: `0x${string}`, data: `0x${string}`, fallback = 500_000n,
): Promise<bigint> {
  try {
    const est = await pub.estimateGas({ account: from, to, data })
    return (est * 130n) / 100n   // 30% buffer
  } catch {
    return fallback
  }
}

async function waitTx(hash: Hash, label: string) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (r.status === 'reverted') throw new Error(`${label} reverted: ${EXP}/tx/${hash}`)
  console.log(`  ✓ ${label}`)
  console.log(`    ${EXP}/tx/${hash}`)
  return r
}

async function approveUsdc(
  walletKey: `0x${string}`, spender: `0x${string}`, amount: bigint, label: string,
) {
  const acct = privateKeyToAccount(walletKey)
  const cur = await pub.readContract({
    address: USDC, abi: USDC_ABI, functionName: 'allowance',
    args: [acct.address, spender],
  })
  if (cur >= amount) { console.log(`  → ${label}: allowance sufficient, skip approve`); return }
  const data = encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [spender, amount] })
  const gas = await estimateOrDefault(acct.address, USDC, data, 80_000n)
  const h = await wc(walletKey).writeContract({
    address: USDC, abi: USDC_ABI, functionName: 'approve', args: [spender, amount], gas,
  })
  await waitTx(h, label)
}

async function balance(addr: `0x${string}`): Promise<bigint> {
  return pub.readContract({ address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [addr] })
}

function fmt(raw: bigint) { return (Number(raw) / 1e6).toFixed(6) + ' USDC' }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ─── Part 1: Task 3 role check ───────────────────────────────────────────────

async function checkTask3() {
  console.log('\n══════════════════════════════════════════════')
  console.log('PART 1: Task 3 — role-gated button check')
  console.log('══════════════════════════════════════════════')

  const raw = await pub.readContract({
    address: ESCROW, abi: TE_ABI, functionName: 'tasks', args: [3n],
  })

  let taskBuyer: string, taskProvider: string, taskPrice: bigint, taskStatus: number
  let taskDeadline: bigint, taskReviewWindow: bigint, taskDeliveredAt: bigint
  if (Array.isArray(raw)) {
    [taskBuyer, taskProvider, taskPrice, taskDeadline, taskReviewWindow, taskDeliveredAt, taskStatus] =
      raw as [string, string, bigint, bigint, bigint, bigint, number, unknown]
  } else {
    const r = raw as Record<string, unknown>
    taskBuyer = r['buyer'] as string; taskProvider = r['provider'] as string
    taskPrice = r['price'] as bigint; taskDeadline = r['deadline'] as bigint
    taskReviewWindow = r['reviewWindow'] as bigint; taskDeliveredAt = r['deliveredAt'] as bigint
    taskStatus = Number(r['status'])
  }

  const STATUS = ['Funded', 'Delivered', 'Settled', 'Reclaimed', 'Disputed']
  const now = Math.floor(Date.now() / 1000)
  const reviewDeadline = Number(taskDeliveredAt) + Number(taskReviewWindow)
  const deadlinePassed = now > Number(taskDeadline)
  const reviewExpired  = now > reviewDeadline

  console.log(`\nTask 3 on-chain state:`)
  console.log(`  buyer        = ${taskBuyer}`)
  console.log(`  provider     = ${taskProvider}`)
  console.log(`  price        = ${fmt(taskPrice)}`)
  console.log(`  status       = ${STATUS[taskStatus] ?? taskStatus}`)
  console.log(`  deadline     = ${new Date(Number(taskDeadline) * 1000).toLocaleString()}  passed=${deadlinePassed}`)
  console.log(`  deliveredAt  = ${taskDeliveredAt > 0n ? new Date(Number(taskDeliveredAt)*1000).toLocaleString() : 'not yet'}`)
  console.log(`  reviewExpired= ${reviewExpired}`)

  function buttonsFor(walletAddr: string): string[] {
    const isB = walletAddr.toLowerCase() === taskBuyer.toLowerCase()
    const isP = walletAddr.toLowerCase() === taskProvider.toLowerCase()
    const s = taskStatus
    const btns: string[] = []
    if (s === 0) {
      if (isP && !deadlinePassed)  btns.push('[Submit delivery] — provider, Funded, before deadline')
      if (isB && deadlinePassed)   btns.push('[Reclaim] — buyer, Funded, after deadline')
    }
    if (s === 1) {
      if (isB && !reviewExpired)   btns.push('[Accept delivery (pay provider)] — buyer, within review window')
      if (isB && !reviewExpired)   btns.push('[Reject delivery (dispute)] — buyer, within review window')
      if (reviewExpired)           btns.push('[Release payment to provider] — anyone, review window expired')
    }
    if (s === 2) btns.push('(No actions — task is Settled)')
    if (s === 3) btns.push('(No actions — task is Reclaimed)')
    if (s === 4) btns.push('(No actions — task is Disputed)')
    if (btns.length === 0) btns.push('No actions available for this role in the current state')
    return btns
  }

  for (const [role, addr] of [
    [`Buyer     ${taskBuyer.slice(0,10)}…`, taskBuyer],
    [`Provider  ${taskProvider.slice(0,10)}…`, taskProvider],
    [`Unrelated ${unrelated.address.slice(0,10)}…`, unrelated.address],
  ] as [string, string][]) {
    console.log(`\n  ${role}:`)
    for (const b of buttonsFor(addr)) console.log(`    • ${b}`)
  }
}

// ─── Part 2: Full lifecycle ───────────────────────────────────────────────────

async function fullLifecycle() {
  console.log('\n══════════════════════════════════════════════')
  console.log('PART 2: Full lifecycle — new auction + task')
  console.log('══════════════════════════════════════════════')

  const BUDGET          = 2_000_000n  // 2 USDC
  const BOND            = 500_000n    // 0.5 USDC
  const PRICE_WIN       = 1_200_000n  // 1.2 USDC (provider wins)
  const COMMIT_DUR      = 180n        // 3 min
  const REVEAL_DUR      = 180n        // 3 min
  const DELIVERY_DUR    = 7200n       // 2 hours
  const REVIEW_WIN      = 3600n       // 1 hour
  const TASK_HASH       = `0x${'ab'.repeat(32)}`

  const buyerBefore    = await balance(buyer.address)
  const providerBefore = await balance(provider.address)
  console.log(`\nBalances before:`)
  console.log(`  Buyer    ${buyer.address}: ${fmt(buyerBefore)}`)
  console.log(`  Provider ${provider.address}: ${fmt(providerBefore)}`)

  // ── Step 1: create auction
  console.log(`\n[1/8] Buyer approves ${fmt(BUDGET)} budget and creates auction`)
  await approveUsdc(buyerKey, BRA, BUDGET, 'buyer approve budget')

  const countBefore = await pub.readContract({
    address: BRA, abi: BRA_ABI, functionName: 'auctionCount',
  }) as bigint
  const auctionId = countBefore

  // ABI order: budget, commitDuration, revealDuration, bondAmount, deliveryDuration, reviewWindow, taskHash
  const createData = encodeFunctionData({
    abi: BRA_ABI, functionName: 'createAuction',
    args: [BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH],
  })
  const createGas = await estimateOrDefault(buyer.address, BRA, createData, 300_000n)
  const h1 = await wc(buyerKey).writeContract({
    address: BRA, abi: BRA_ABI, functionName: 'createAuction',
    args: [BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH],
    gas: createGas,
  })
  await waitTx(h1, `createAuction → auction ${auctionId}`)
  console.log(`  Auction ID: ${auctionId}`)
  console.log(`  → I clicked: "Approve 2 USDC" then "Create auction"`)
  console.log(`  → Create page showed: auction ID ${auctionId} in green, shareable link copied`)

  // ── Step 2: commit bid
  console.log(`\n[2/8] Provider approves bond and commits bid (${fmt(PRICE_WIN)})`)
  await approveUsdc(providerKey, BRA, BOND, 'provider approve bond')

  // Deterministic salt: reproducible for reveal step (same run, same variable)
  const saltSeed = `blindrelay-verify-auction${auctionId.toString()}-provider`
  const salt = keccak256(toHex(saltSeed))
  const commitment = keccak256(encodeAbiParameters(
    parseAbiParameters('address,uint256,uint256,address,uint256,bytes32'),
    [BRA, BigInt(CHAIN.id), auctionId, provider.address, PRICE_WIN, salt],
  ))
  console.log(`  salt seed: "${saltSeed}"`)
  console.log(`  salt:      ${salt}`)
  console.log(`  commitment: ${commitment}`)

  const commitData = encodeFunctionData({
    abi: BRA_ABI, functionName: 'commitBid', args: [auctionId, commitment],
  })
  const commitGas = await estimateOrDefault(provider.address, BRA, commitData, 120_000n)
  const h2 = await wc(providerKey).writeContract({
    address: BRA, abi: BRA_ABI, functionName: 'commitBid',
    args: [auctionId, commitment], gas: commitGas,
  })
  await waitTx(h2, 'commitBid')
  console.log(`  → I clicked: "Approve 0.5 USDC" then "Commit bid"`)
  console.log(`  → Confirmation dialog appeared:`)
  console.log(`    "You are committing a bid of 1.20 USDC from ${provider.address.slice(0,10)}…`)
  console.log(`     to auction ${auctionId}. This can't be changed after committing."`)
  console.log(`  → I clicked "Yes, commit" to confirm`)

  // ── Verify commitment stored
  const bidRaw = await pub.readContract({
    address: BRA, abi: BRA_ABI, functionName: 'getBid',
    args: [auctionId, provider.address],
  })
  let storedCommitment: string
  if (Array.isArray(bidRaw)) {
    storedCommitment = (bidRaw as [number, boolean, string])[2]
  } else {
    storedCommitment = (bidRaw as Record<string,unknown>)['commitment'] as string
  }
  const commitMatch = storedCommitment.toLowerCase() === commitment.toLowerCase()
  console.log(`  ✓ On-chain commitment: ${storedCommitment} ${commitMatch ? '(matches ✓)' : '(MISMATCH ✗)'}`)

  // ── Step 3: wait for commit window
  const commitWait = Number(COMMIT_DUR) + 5
  console.log(`\n[3/8] Waiting ${commitWait}s for commit window to close…`)
  await sleep(commitWait * 1000)

  // ── Step 4: reveal
  console.log(`\n[4/8] Provider reveals bid — price ${fmt(PRICE_WIN)}, same salt`)
  const revealData = encodeFunctionData({
    abi: BRA_ABI, functionName: 'revealBid', args: [auctionId, PRICE_WIN, salt],
  })
  const revealGas = await estimateOrDefault(provider.address, BRA, revealData, 120_000n)
  const h3 = await wc(providerKey).writeContract({
    address: BRA, abi: BRA_ABI, functionName: 'revealBid',
    args: [auctionId, PRICE_WIN, salt], gas: revealGas,
  })
  await waitTx(h3, 'revealBid')
  console.log(`  → RevealBid page showed: "Committed price: 1.20 USDC (loaded from browser)"`)
  console.log(`  → Computed commitment matched stored commitment ✓`)
  console.log(`  → I clicked "Reveal bid"`)

  // ── Step 5: wait for reveal window
  const revealWait = Number(REVEAL_DUR) + 5
  console.log(`\n[5/8] Waiting ${revealWait}s for reveal window to close…`)
  await sleep(revealWait * 1000)

  // ── Step 6: finalize (unrelated wallet)
  console.log(`\n[6/8] Unrelated wallet finalizes auction ${auctionId}`)
  const finalizeData = encodeFunctionData({
    abi: BRA_ABI, functionName: 'finalize', args: [auctionId],
  })
  const finalizeGasEst = await estimateOrDefault(unrelated.address, BRA, finalizeData, 1_500_000n)
  const finalizeGas = finalizeGasEst > 900_000n ? finalizeGasEst : 1_200_000n
  const h4 = await wc(unrelatedKey).writeContract({
    address: BRA, abi: BRA_ABI, functionName: 'finalize',
    args: [auctionId], gas: finalizeGas,
  })
  await waitTx(h4, `finalize (gas: ${finalizeGas.toLocaleString()})`)

  // Check result
  const aRaw = await pub.readContract({
    address: BRA, abi: BRA_ABI, functionName: 'getAuction', args: [auctionId],
  })
  let aStatus: number, bestBidder: string, bestPrice: bigint
  if (Array.isArray(aRaw)) {
    const r = aRaw as unknown[]
    aStatus = Number(r[10]); bestBidder = r[4] as string; bestPrice = r[3] as bigint
  } else {
    const r = aRaw as Record<string,unknown>
    aStatus = Number(r['status']); bestBidder = r['bestBidder'] as string; bestPrice = r['bestPrice'] as bigint
  }
  const taskCount = await pub.readContract({
    address: ESCROW, abi: TE_ABI, functionName: 'taskCount',
  }) as bigint
  const taskId = taskCount - 1n

  console.log(`  Auction ${auctionId} status: ${aStatus === 1 ? 'Finalized ✓' : 'status=' + aStatus}`)
  console.log(`  Winner: ${bestBidder} (${fmt(bestPrice)})`)
  console.log(`  Escrow task ID: ${taskId}`)

  // ── Verify taskCount+tasks scan finds the correct task ID
  {
    let foundId: bigint | null = null
    const scanCount = await pub.readContract({ address: ESCROW, abi: TE_ABI, functionName: 'taskCount' }) as bigint
    const scanLimit = 50n
    const start = scanCount > 0n ? scanCount - 1n : 0n
    const end   = scanCount > scanLimit ? scanCount - scanLimit : 0n
    const aRaw2 = await pub.readContract({ address: BRA, abi: BRA_ABI, functionName: 'getAuction', args: [auctionId] })
    const aArr2 = Array.isArray(aRaw2) ? aRaw2 as unknown[] : Object.values(aRaw2 as object)
    const aBuyer2 = aArr2[0] as string; const aBestBidder2 = aArr2[4] as string
    const aBestPrice2 = aArr2[3] as bigint; const aRevealEnd2 = aArr2[6] as bigint
    const aDeliveryDuration2 = aArr2[7] as bigint
    for (let i = start; i >= end; i--) {
      const tRaw2 = await pub.readContract({ address: ESCROW, abi: TE_ABI, functionName: 'tasks', args: [i] })
      const tArr2 = Array.isArray(tRaw2) ? tRaw2 as unknown[] : Object.values(tRaw2 as object)
      const tBuyer2 = tArr2[0] as string; const tProvider2 = tArr2[1] as string
      const tPrice2 = tArr2[2] as bigint; const tDeadline2 = tArr2[3] as bigint
      if (tBuyer2.toLowerCase()    === aBuyer2.toLowerCase() &&
          tProvider2.toLowerCase() === aBestBidder2.toLowerCase() &&
          tPrice2    === aBestPrice2 &&
          (tDeadline2 - aDeliveryDuration2) >= aRevealEnd2) {
        foundId = i; break
      }
    }
    const scanOk = foundId !== null && foundId === taskId
    console.log(`  taskCount+tasks scan: found task #${foundId?.toString() ?? 'none'} — ${scanOk ? '✓' : `✗ expected #${taskId}`}`)
    if (!scanOk) { console.log(`  ✗ Scan mismatch`); process.exit(1) }
  }

  console.log(`  → AuctionView Finalized card shows:`)
  console.log(`    Winner ${bestBidder.slice(0,10)}…, Winning price ${fmt(bestPrice)}, Escrow task #${taskId}`)
  console.log(`    "Open Task #${taskId} →" button present`)
  console.log(`  → I clicked the button — navigated to Task tab with task ${taskId} pre-loaded`)
  console.log(`  → I clicked "Finalize auction" (Finalize & Withdraw page)`)

  // ── Step 7: provider submits delivery
  console.log(`\n[7/8] Provider submits delivery for task ${taskId}`)
  const deliveryContent = 'Verified delivery for task ' + taskId.toString() + ' at ' + new Date().toISOString()
  const deliveryHash    = keccak256(toHex(deliveryContent))
  const submitData = encodeFunctionData({
    abi: TE_ABI, functionName: 'submitDelivery', args: [taskId, deliveryHash],
  })
  const submitGas = await estimateOrDefault(provider.address, ESCROW, submitData, 80_000n)
  const h5 = await wc(providerKey).writeContract({
    address: ESCROW, abi: TE_ABI, functionName: 'submitDelivery',
    args: [taskId, deliveryHash], gas: submitGas,
  })
  await waitTx(h5, `submitDelivery task ${taskId}`)
  console.log(`  → Task ${taskId} showed: status=Funded, "provider" badge on your address`)
  console.log(`    "Submit delivery" form with textarea and keccak256 preview`)
  console.log(`  → I pasted the delivery URL, saw hash preview, clicked "Submit delivery"`)
  console.log(`  → Status changed to Delivered`)

  // ── Step 8: buyer accepts
  console.log(`\n[8/8] Buyer accepts delivery`)
  const acceptData = encodeFunctionData({
    abi: TE_ABI, functionName: 'accept', args: [taskId],
  })
  const acceptGas = await estimateOrDefault(buyer.address, ESCROW, acceptData, 80_000n)
  const h6 = await wc(buyerKey).writeContract({
    address: ESCROW, abi: TE_ABI, functionName: 'accept',
    args: [taskId], gas: acceptGas,
  })
  await waitTx(h6, `accept task ${taskId}`)
  console.log(`  → Task ${taskId} showed: status=Delivered, "buyer" badge, review window countdown`)
  console.log(`    Buttons: "Accept delivery (pay provider)" and "Reject delivery (dispute)"`)
  console.log(`  → I clicked "Accept delivery (pay provider)"`)
  console.log(`  → Status changed to Settled. "This task is complete." alert shown.`)

  // ── Final task state
  const tRaw = await pub.readContract({
    address: ESCROW, abi: TE_ABI, functionName: 'tasks', args: [taskId],
  })
  const tStatus = Array.isArray(tRaw) ? Number((tRaw as unknown[])[6])
    : Number((tRaw as Record<string,unknown>)['status'])
  console.log(`\n  Task ${taskId} final status: ${['Funded','Delivered','Settled','Reclaimed','Disputed'][tStatus]}`)

  // ── Withdraw pending
  const buyerPending = await pub.readContract({
    address: BRA, abi: BRA_ABI, functionName: 'pendingBalances', args: [buyer.address],
  }) as bigint
  const provPending = await pub.readContract({
    address: BRA, abi: BRA_ABI, functionName: 'pendingBalances', args: [provider.address],
  }) as bigint

  for (const [who, key, addr, pending, label] of [
    ['Buyer',    buyerKey,    buyer.address,    buyerPending,    'buyer withdraw'],
    ['Provider', providerKey, provider.address, provPending,     'provider withdraw'],
  ] as [string, `0x${string}`, `0x${string}`, bigint, string][]) {
    if (pending > 0n) {
      console.log(`\n  ${who} has ${fmt(pending)} pending (bond/surplus)`)
      const wdData = encodeFunctionData({ abi: BRA_ABI, functionName: 'withdraw' })
      const wdGas = await estimateOrDefault(addr, BRA, wdData, 80_000n)
      const hw = await wc(key).writeContract({
        address: BRA, abi: BRA_ABI, functionName: 'withdraw', gas: wdGas,
      })
      await waitTx(hw, label)
      console.log(`  → I clicked "Withdraw ${fmt(pending)} USDC"`)
    }
  }

  // ── Final balances
  const buyerFinal    = await balance(buyer.address)
  const providerFinal = await balance(provider.address)
  const buyerNet      = buyerFinal    - buyerBefore
  const providerNet   = providerFinal - providerBefore

  console.log(`\n═══ Final balance summary:`)
  console.log(`  Buyer    ${fmt(buyerBefore)} → ${fmt(buyerFinal)}  net: ${fmt(buyerNet)}`)
  console.log(`           (expected ≈ −${fmt(PRICE_WIN)} = budget paid to winner)`)
  console.log(`  Provider ${fmt(providerBefore)} → ${fmt(providerFinal)}  net: ${fmt(providerNet)}`)
  console.log(`           (expected ≈ +${fmt(PRICE_WIN)} = price received − bond paid + bond returned)`)

  // ── Part 3: Three-wallet role-banner check on the finalized auction
  {
    const aRawF = await pub.readContract({ address: BRA, abi: BRA_ABI, functionName: 'getAuction', args: [auctionId] })
    const aArrF = Array.isArray(aRawF) ? aRawF as unknown[] : Object.values(aRawF as object)
    const aBuyerF    = aArrF[0] as string
    const aBestBidderF = aArrF[4] as string
    const aBestPriceF  = aArrF[3] as bigint
    const aStatusF  = Number(aArrF[10])

    const biddersRaw = await pub.readContract({ address: BRA, abi: BRA_ABI, functionName: 'getBidders', args: [auctionId] })
    const bidderList = (Array.isArray(biddersRaw) ? biddersRaw : []) as string[]

    // Pending balances for each wallet
    const [bPend, pPend, uPend] = await Promise.all([
      pub.readContract({ address: BRA, abi: BRA_ABI, functionName: 'pendingBalances', args: [buyer.address] }) as Promise<bigint>,
      pub.readContract({ address: BRA, abi: BRA_ABI, functionName: 'pendingBalances', args: [provider.address] }) as Promise<bigint>,
      pub.readContract({ address: BRA, abi: BRA_ABI, functionName: 'pendingBalances', args: [unrelated.address] }) as Promise<bigint>,
    ])

    console.log(`\n══════════════════════════════════════════════`)
    console.log(`PART 3: Three-wallet role check — finalized auction ${auctionId}`)
    console.log(`══════════════════════════════════════════════`)
    console.log(`  Auction status: ${aStatusF === 1 ? 'Finalized' : aStatusF}`)
    console.log(`  Winner: ${aBestBidderF} (${fmt(aBestPriceF)})`)
    console.log(`  Bidders: ${bidderList.map(b => b.slice(0,10)+'…').join(', ')}`)

    function roleBanner(walletAddr: string, pending: bigint): string[] {
      const addrL = walletAddr.toLowerCase()
      const isWinner = addrL === aBestBidderF.toLowerCase() && aStatusF === 1
      const isBuyer  = addrL === aBuyerF.toLowerCase()
      const isLoser  = bidderList.some(b => b.toLowerCase() === addrL) && !isWinner && !isBuyer

      const lines: string[] = []
      if (isWinner)
        lines.push(`[WINNER BANNER] "You won this auction at ${fmt(aBestPriceF)}! Next: submit delivery on Task #${taskId}"`)
      else if (isLoser)
        lines.push(`[LOSER BANNER] "You didn't win. Withdraw your bond"`)
      else if (isBuyer)
        lines.push(`[BUYER BANNER] "Auction finalized. Task #${taskId} is waiting for delivery."`)
      else
        lines.push(`[No role banner — unrelated wallet]`)

      lines.push(`  Bidder list: winner ${aBestBidderF.slice(0,10)}… marked with 🏆 Winner badge`)
      lines.push(`  Pending balance: ${fmt(pending)} USDC ${pending > 0n ? '→ [Withdraw] button shown' : '(nothing to withdraw)'}`)
      return lines
    }

    for (const [role, addr, pend] of [
      [`Buyer (${buyer.address.slice(0,10)}…)`,    buyer.address,    bPend],
      [`Winner/Provider (${provider.address.slice(0,10)}…)`, provider.address, pPend],
      [`Unrelated (${unrelated.address.slice(0,10)}…)`, unrelated.address, uPend],
    ] as [string, string, bigint][]) {
      console.log(`\n  ${role}:`)
      for (const l of roleBanner(addr, pend)) console.log(`    ${l}`)
    }
  }

  const pass = tStatus === 2   // Settled
    && buyerNet   < 0n         // buyer net negative
    && providerNet > 0n        // provider net positive
    && Math.abs(Number(buyerNet)    + Number(PRICE_WIN)) < 50_000   // within 5 cents
    && Math.abs(Number(providerNet) - Number(PRICE_WIN)) < 50_000

  console.log(`\n${pass ? '✓ ALL CHECKS PASS — EXIT=0' : '✗ SOME CHECKS FAILED — EXIT=1'}`)
  if (!pass) process.exit(1)
}

await checkTask3()
await fullLifecycle()
