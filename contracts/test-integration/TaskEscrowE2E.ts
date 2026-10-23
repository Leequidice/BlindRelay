/**
 * TaskEscrow end-to-end integration script — Arc Testnet
 *
 * Runs three complete task lifecycles against the deployed contract using two
 * funded wallets (buyer and provider) with a 60-second review window.
 *
 * Scenario A: create → deliver → accept          (buyer accepts immediately)
 * Scenario B: create → deliver → wait → release  (auto-release after window)
 * Scenario C: create → wait past deadline → reclaim (provider never delivers)
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x...  PROVIDER_PRIVATE_KEY=0x...  \
 *     bun run contracts/test-integration/TaskEscrowE2E.ts
 *
 * Requirements:
 *   - Both wallets funded with at least 3 USDC on Arc Testnet
 *     (use "Get test USDC" in the Arc Studio sidebar)
 *   - No CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET needed — plain private keys only
 */

import { createRequire } from "module";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  getContract,
  defineChain,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Load ABI from committed file (no assert { type: "json" }, works on Bun 1.x) ──

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ESCROW_ABI: readonly any[] = require("../abi/TaskEscrow.json");

// ─── Chain ────────────────────────────────────────────────────────────────────

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
});

// ─── Addresses ────────────────────────────────────────────────────────────────

const ESCROW_ADDRESS: Address = "0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d";
const USDC_ADDRESS:   Address = "0x3600000000000000000000000000000000000000";

// ─── Minimal USDC ABI ────────────────────────────────────────────────────────

const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ─── Config ───────────────────────────────────────────────────────────────────

const PRICE         = parseUnits("1", 6);  // 1 USDC (6 decimals)
const REVIEW_WINDOW = 60n;                  // 60 seconds
const TASK_TTL      = 300n;                 // deadline 5 minutes from now

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUsdc(amount: bigint): string {
  return `${formatUnits(amount, 6)} USDC`;
}

function explorerTx(hash: Hash): string {
  return `https://explorer.testnet.arc.io/tx/${hash}`;
}

function explorerAddr(addr: Address): string {
  return `https://explorer.testnet.arc.io/address/${addr}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTx(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hash,
  label: string
): Promise<void> {
  process.stdout.write(`  ⏳  Waiting for ${label}...`);
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(` ✓`);
  console.log(`      tx: ${explorerTx(hash)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Read private keys from env — no Circle credentials needed
  const buyerKey    = process.env.BUYER_PRIVATE_KEY;
  const providerKey = process.env.PROVIDER_PRIVATE_KEY;

  if (!buyerKey || !providerKey) {
    console.error(
      "\nUsage:\n" +
      "  BUYER_PRIVATE_KEY=0x...  PROVIDER_PRIVATE_KEY=0x...  \\\n" +
      "    bun run contracts/test-integration/TaskEscrowE2E.ts\n\n" +
      "Both wallets must have at least 3 USDC on Arc Testnet.\n" +
      "Use 'Get test USDC' in the Arc Studio sidebar to fund them.\n"
    );
    process.exit(1);
  }

  const buyerAccount    = privateKeyToAccount(buyerKey    as `0x${string}`);
  const providerAccount = privateKeyToAccount(providerKey as `0x${string}`);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  TaskEscrow End-to-End Integration — Arc Testnet`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  Contract : ${explorerAddr(ESCROW_ADDRESS)}`);
  console.log(`  USDC     : ${USDC_ADDRESS}`);
  console.log(`  Buyer    : ${buyerAccount.address}`);
  console.log(`  Provider : ${providerAccount.address}`);
  console.log(`${"═".repeat(70)}\n`);

  // ── Clients ──────────────────────────────────────────────────────────────
  const transport = http("https://rpc.testnet.arc.io");

  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const buyerWalletClient = createWalletClient({
    account: buyerAccount,
    chain: arcTestnet,
    transport,
  });

  const providerWalletClient = createWalletClient({
    account: providerAccount,
    chain: arcTestnet,
    transport,
  });

  // ── Contract handles ──────────────────────────────────────────────────────
  const escrowRead = getContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    client: publicClient,
  });

  const escrowBuyer = getContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    client: buyerWalletClient,
  });

  const escrowProvider = getContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    client: providerWalletClient,
  });

  const escrowAnyone = escrowBuyer; // release is open to anyone; buyer wallet is convenient

  // ── USDC handles ───────────────────────────────────────────────────────────
  const usdcBuyer = getContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    client: buyerWalletClient,
  });

  // ── Helper: snapshot balances ─────────────────────────────────────────────
  type Snap = { buyer: bigint; provider: bigint; escrow: bigint };

  async function snapshot(label: string): Promise<Snap> {
    const [b, p, e] = await Promise.all([
      publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [buyerAccount.address] }),
      publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [providerAccount.address] }),
      publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [ESCROW_ADDRESS] }),
    ]);
    console.log(`  Balances [${label}]:`);
    console.log(`    Buyer    : ${formatUsdc(b)}`);
    console.log(`    Provider : ${formatUsdc(p)}`);
    console.log(`    Escrow   : ${formatUsdc(e)}`);
    return { buyer: b, provider: p, escrow: e };
  }

  function printDelta(before: Snap, after: Snap, note: string) {
    const fmt = (n: bigint) => n >= 0n ? `+${formatUsdc(n)}` : `-${formatUsdc(-n)}`;
    console.log(`  Net change [${note}]:`);
    console.log(`    Buyer    : ${fmt(after.buyer    - before.buyer)}`);
    console.log(`    Provider : ${fmt(after.provider - before.provider)}`);
    console.log(`    Escrow   : ${fmt(after.escrow   - before.escrow)}`);
  }

  // ── Gas note ──────────────────────────────────────────────────────────────
  const taskCountInitial = await escrowRead.read.taskCount() as bigint;
  const snap0 = await snapshot("initial");
  console.log(`  taskCount at start: ${taskCountInitial}`);
  console.log();
  console.log(`  Note: on Arc, gas is paid in USDC. Every transaction deducts a small`);
  console.log(`  amount from the signer's balance, so actual net differs from the`);
  console.log(`  theoretical values shown in the summary below.`);

  // ── Approve once for all three tasks ──────────────────────────────────────
  console.log(`\n  Approving escrow to spend ${formatUsdc(PRICE * 3n)} from buyer...`);
  {
    const hash = await usdcBuyer.write.approve([ESCROW_ADDRESS, PRICE * 3n]);
    await waitForTx(publicClient, hash, "approve");
  }

  const latestBlock = await publicClient.getBlock();
  const now = latestBlock.timestamp;

  const idA = taskCountInitial;
  const idB = idA + 1n;
  const idC = idB + 1n;

  const deadlineAB = now + TASK_TTL;

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO A — create → deliver → accept
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  SCENARIO A — create → deliver → accept  (taskId ${idA})`);
  console.log(`${"─".repeat(70)}`);

  console.log(`\n  A.1  createTask`);
  {
    const hash = await escrowBuyer.write.createTask([
      buyerAccount.address,
      providerAccount.address,
      PRICE,
      deadlineAB,
      REVIEW_WINDOW,
    ]);
    await waitForTx(publicClient, hash, "createTask A");
  }

  console.log(`\n  A.2  submitDelivery`);
  {
    const hash = await escrowProvider.write.submitDelivery([
      idA,
      `0x${"ab".repeat(32)}` as `0x${string}`,
    ]);
    await waitForTx(publicClient, hash, "submitDelivery A");
  }

  console.log(`\n  A.3  accept`);
  {
    const hash = await escrowBuyer.write.accept([idA]);
    await waitForTx(publicClient, hash, "accept A");
  }

  const taskA = await escrowRead.read.tasks([idA]) as readonly unknown[];
  console.log(`\n  Task A status: ${["Funded","Delivered","Settled","Reclaimed","Disputed"][taskA[6] as number]} ✓`);
  const snapA = await snapshot("after scenario A");
  printDelta(snap0, snapA, "scenario A net");

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO B — create → deliver → wait → release
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  SCENARIO B — create → deliver → wait → release  (taskId ${idB})`);
  console.log(`${"─".repeat(70)}`);

  console.log(`\n  B.1  createTask`);
  {
    const hash = await escrowBuyer.write.createTask([
      buyerAccount.address,
      providerAccount.address,
      PRICE,
      deadlineAB,
      REVIEW_WINDOW,
    ]);
    await waitForTx(publicClient, hash, "createTask B");
  }

  console.log(`\n  B.2  submitDelivery`);
  let deliveredAtB = 0n;
  {
    const hash = await escrowProvider.write.submitDelivery([
      idB,
      `0x${"cd".repeat(32)}` as `0x${string}`,
    ]);
    await waitForTx(publicClient, hash, "submitDelivery B");
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const blk = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    deliveredAtB = blk.timestamp;
    console.log(`      deliveredAt: ${deliveredAtB}`);
  }

  const waitUntilB = Number(deliveredAtB) + Number(REVIEW_WINDOW) + 2;
  const waitSecsB  = Math.max(0, waitUntilB - Math.floor(Date.now() / 1000));
  console.log(`\n  B.3  Waiting ${waitSecsB}s for the review window to expire...`);
  if (waitSecsB > 0) await sleep(waitSecsB * 1000);

  console.log(`\n  B.4  release`);
  {
    const hash = await escrowAnyone.write.release([idB]);
    await waitForTx(publicClient, hash, "release B");
  }

  const taskB = await escrowRead.read.tasks([idB]) as readonly unknown[];
  console.log(`\n  Task B status: ${["Funded","Delivered","Settled","Reclaimed","Disputed"][taskB[6] as number]} ✓`);
  const snapB = await snapshot("after scenario B");
  printDelta(snapA, snapB, "scenario B net");

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO C — create → wait past deadline → reclaim
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  SCENARIO C — create → wait past deadline → reclaim  (taskId ${idC})`);
  console.log(`${"─".repeat(70)}`);

  const shortDeadline = (await publicClient.getBlock()).timestamp + 70n;

  console.log(`\n  C.1  createTask (deadline ${shortDeadline}, ~70s from now)`);
  {
    const hash = await escrowBuyer.write.createTask([
      buyerAccount.address,
      providerAccount.address,
      PRICE,
      shortDeadline,
      REVIEW_WINDOW,
    ]);
    await waitForTx(publicClient, hash, "createTask C");
  }

  const waitSecsC = Math.max(0, Number(shortDeadline) - Math.floor(Date.now() / 1000) + 2);
  console.log(`\n  C.2  Waiting ${waitSecsC}s for deadline to pass (provider does NOT deliver)...`);
  if (waitSecsC > 0) await sleep(waitSecsC * 1000);

  console.log(`\n  C.3  reclaim`);
  {
    const hash = await escrowBuyer.write.reclaim([idC]);
    await waitForTx(publicClient, hash, "reclaim C");
  }

  const taskC = await escrowRead.read.tasks([idC]) as readonly unknown[];
  console.log(`\n  Task C status: ${["Funded","Delivered","Settled","Reclaimed","Disputed"][taskC[6] as number]} ✓`);
  const snapC = await snapshot("after scenario C");
  printDelta(snapB, snapC, "scenario C net");

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  const taskCountFinal = await escrowRead.read.taskCount() as bigint;

  const buyerNet    = snapC.buyer    - snap0.buyer;
  const providerNet = snapC.provider - snap0.provider;
  const escrowNet   = snapC.escrow   - snap0.escrow;
  const fmt = (n: bigint) => n >= 0n ? `+${formatUsdc(n)}` : `-${formatUsdc(-n)}`;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Summary`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  taskCount : ${taskCountInitial} → ${taskCountFinal}`);
  console.log(`  Buyer     : ${formatUsdc(snap0.buyer)} → ${formatUsdc(snapC.buyer)}`);
  console.log(`  Provider  : ${formatUsdc(snap0.provider)} → ${formatUsdc(snapC.provider)}`);
  console.log(`  Escrow    : ${formatUsdc(snapC.escrow)} (should be 0)`);
  console.log();
  // Expected net (computed from constants, not hard-coded text):
  //   Buyer    : funded A(PRICE) + B(PRICE) + C(PRICE), received back C(PRICE) on reclaim.
  //              A and B settled to provider.  Net escrow flow = -PRICE*2.
  //   Provider : received PRICE on accept-A and PRICE on release-B.  Net = +PRICE*2.
  //   Escrow   : all tasks closed.  Net = 0.
  const expectedBuyerNet    = -(PRICE * 2n);  // -2 USDC
  const expectedProviderNet =   PRICE * 2n;   // +2 USDC
  const expectedEscrowNet   = 0n;

  console.log(`  Overall net (all three scenarios):`);
  console.log(`    Buyer    : ${fmt(buyerNet)}`);
  console.log(`    Provider : ${fmt(providerNet)}`);
  console.log(`    Escrow   : ${fmt(escrowNet)}`);
  console.log();
  console.log(`  Expected net before gas:`);
  console.log(`    Buyer    : ${fmt(expectedBuyerNet)}  (funded 3×${formatUsdc(PRICE)}, got 1×${formatUsdc(PRICE)} back on reclaim C; A+B settled to provider)`);
  console.log(`    Provider : ${fmt(expectedProviderNet)}  (received accept A + release B)`);
  console.log(`    Escrow   : ${fmt(expectedEscrowNet)}  (all tasks closed)`);
  console.log();
  console.log(`  Gas (Arc-specific — gas is USDC):`);
  console.log(`    Buyer signed    : approve + createTask×3 + accept A + release B + reclaim C = 7 txns`);
  console.log(`    Provider signed : submitDelivery A + submitDelivery B = 2 txns`);
  console.log(`    Actual net deviates from expected by each wallet's total gas paid in USDC.`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("E2E script failed:", err);
  process.exit(1);
});
