/**
 * TaskEscrow end-to-end integration script
 *
 * Runs three complete task lifecycles against the deployed contract:
 *   Scenario A: create → deliver → accept
 *   Scenario B: create → deliver → wait → release (auto-release after review window)
 *   Scenario C: create → wait past deadline → reclaim (provider never delivers)
 *
 * Chain, RPC, explorer URL, and contract addresses come from CHAIN_CONFIG in
 * src/lib/blindrelay.ts — no hardcoded network values. Switch networks by
 * changing ACTIVE_ENV there and rebuilding.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x...  PROVIDER_PRIVATE_KEY=0x...  \
 *     bun run contracts/test-integration/TaskEscrowE2E.ts
 *
 * Optional env vars:
 *   PRICE          — task price in USDC (default: 1)
 *   REVIEW_WINDOW  — review window in seconds (default: 60)
 *   TASK_TTL       — delivery deadline in seconds from now (default: 300)
 *
 * Mainnet safety: pass --yes-mainnet to allow running against mainnet.
 * The script pauses for 5 seconds before sending any transaction on mainnet.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  getContract,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_CONFIG, TASK_ESCROW_ABI } from "../../src/lib/blindrelay.js";

// ─── ABI (re-exported from blindrelay.ts, which imports it as static JSON) ───

const ESCROW_ABI = TASK_ESCROW_ABI;

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USDC_DECIMALS = 6;

function formatUsdc(amount: bigint): string {
  return `${formatUnits(amount, USDC_DECIMALS)} USDC`;
}

function fmtDelta(n: bigint): string {
  return n >= 0n ? `+${formatUsdc(n)}` : `-${formatUsdc(-n)}`;
}

function explorerTx(hash: Hash): string {
  return `${CHAIN_CONFIG.explorerBase}/tx/${hash}`;
}

function explorerAddr(addr: Address): string {
  return `${CHAIN_CONFIG.explorerBase}/address/${addr}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTx(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hash,
  label: string,
): Promise<void> {
  process.stdout.write(`  ⏳  Waiting for ${label}...`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    console.log(` ✗`);
    console.log(`      tx (REVERTED): ${explorerTx(hash)}`);
    throw new Error(`Transaction reverted: ${label}\n  tx: ${explorerTx(hash)}`);
  }
  console.log(` ✓`);
  console.log(`      tx: ${explorerTx(hash)}`);
}

/** Parse a USDC amount from an env var string, with a fallback default. */
function envUsdc(varName: string, defaultVal: string): bigint {
  return parseUnits(process.env[varName] ?? defaultVal, USDC_DECIMALS);
}

/** Parse a duration (seconds) from an env var string, with a fallback default. */
function envDuration(varName: string, defaultVal: number): bigint {
  const raw = process.env[varName];
  const n = raw !== undefined ? parseInt(raw, 10) : defaultVal;
  if (isNaN(n) || n <= 0) {
    console.error(`Invalid ${varName}: must be a positive integer (seconds). Got: ${raw}`);
    process.exit(1);
  }
  return BigInt(n);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Mainnet guard ────────────────────────────────────────────────────────
  const isMainnet = CHAIN_CONFIG.chainId !== 5042002;
  const yesMainnet = process.argv.includes("--yes-mainnet");
  if (isMainnet && !yesMainnet) {
    console.error(
      `\n⛔  ACTIVE_ENV is set to '${CHAIN_CONFIG.chainName}' (chain ${CHAIN_CONFIG.chainId}).\n` +
      `    This script sends real transactions. To proceed, pass --yes-mainnet:\n\n` +
      `      bun run contracts/test-integration/TaskEscrowE2E.ts --yes-mainnet\n\n` +
      `    Make sure all wallets are funded with real USDC on ${CHAIN_CONFIG.chainName}.\n`,
    );
    process.exit(1);
  }

  // ── Private keys ─────────────────────────────────────────────────────────
  const buyerKey    = process.env.BUYER_PRIVATE_KEY;
  const providerKey = process.env.PROVIDER_PRIVATE_KEY;

  if (!buyerKey || !providerKey) {
    console.error(
      "\nMissing private keys. Set both environment variables:\n\n" +
      "  BUYER_PRIVATE_KEY=0x...  PROVIDER_PRIVATE_KEY=0x...  \\\n" +
      "    bun run contracts/test-integration/TaskEscrowE2E.ts\n\n" +
      "Both wallets must have at least 3× PRICE USDC on the active network.\n" +
      "Use 'Get test USDC' in the Arc Studio sidebar to fund testnet wallets.\n",
    );
    process.exit(1);
  }

  // ── Run parameters from env vars ──────────────────────────────────────────
  const PRICE         = envUsdc("PRICE",    "1");
  const REVIEW_WINDOW = envDuration("REVIEW_WINDOW", 60);
  const TASK_TTL      = envDuration("TASK_TTL",     300);

  // ── Addresses from CHAIN_CONFIG ───────────────────────────────────────────
  const ESCROW_ADDRESS = CHAIN_CONFIG.taskEscrowAddress;
  const USDC_ADDRESS   = CHAIN_CONFIG.usdcAddress;

  if (ESCROW_ADDRESS === "0x0000000000000000000000000000000000000000") {
    console.error(
      `\n⛔  taskEscrowAddress is not set for '${CHAIN_CONFIG.chainName}'.\n` +
      `    Deploy first, then update src/lib/blindrelay.ts.\n`,
    );
    process.exit(1);
  }

  // ── Viem clients ──────────────────────────────────────────────────────────
  const buyerAccount    = privateKeyToAccount(buyerKey    as `0x${string}`);
  const providerAccount = privateKeyToAccount(providerKey as `0x${string}`);

  const transport = http(CHAIN_CONFIG.rpcUrl);
  const publicClient = createPublicClient({ chain: CHAIN_CONFIG.viemChain, transport });

  const buyerWalletClient    = createWalletClient({ account: buyerAccount,    chain: CHAIN_CONFIG.viemChain, transport });
  const providerWalletClient = createWalletClient({ account: providerAccount, chain: CHAIN_CONFIG.viemChain, transport });

  // ── Contract handles ──────────────────────────────────────────────────────
  const escrowRead     = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: publicClient });
  const escrowBuyer    = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: buyerWalletClient });
  const escrowProvider = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: providerWalletClient });
  const escrowAnyone   = escrowBuyer; // release is open to anyone; buyer wallet is convenient

  const usdcBuyer = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: buyerWalletClient });

  // ── Balance snapshots ─────────────────────────────────────────────────────
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
    console.log(`  Net change [${note}]:`);
    console.log(`    Buyer    : ${fmtDelta(after.buyer    - before.buyer)}`);
    console.log(`    Provider : ${fmtDelta(after.provider - before.provider)}`);
    console.log(`    Escrow   : ${fmtDelta(after.escrow   - before.escrow)}`);
  }

  // ── Header ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  TaskEscrow End-to-End Integration`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  Network  : ${CHAIN_CONFIG.chainName} (chain ${CHAIN_CONFIG.chainId})`);
  console.log(`  RPC      : ${CHAIN_CONFIG.rpcUrl}`);
  console.log(`  Contract : ${explorerAddr(ESCROW_ADDRESS)}`);
  console.log(`  USDC     : ${USDC_ADDRESS}`);
  console.log(`  Buyer    : ${buyerAccount.address}`);
  console.log(`  Provider : ${providerAccount.address}`);
  console.log(`  Price    : ${formatUsdc(PRICE)}  |  Review window: ${REVIEW_WINDOW}s  |  Task TTL: ${TASK_TTL}s`);
  console.log(`${"═".repeat(70)}`);

  if (isMainnet) {
    console.log(`\n  ⚠️   MAINNET — pausing 5 seconds before sending any transaction.`);
    console.log(`       Press Ctrl-C now to abort.\n`);
    await sleep(5000);
  } else {
    console.log();
  }

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
      buyerAccount.address, providerAccount.address, PRICE, deadlineAB, REVIEW_WINDOW,
    ]);
    await waitForTx(publicClient, hash, "createTask A");
  }

  console.log(`\n  A.2  submitDelivery`);
  {
    const hash = await escrowProvider.write.submitDelivery([idA, `0x${"ab".repeat(32)}` as `0x${string}`]);
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
      buyerAccount.address, providerAccount.address, PRICE, deadlineAB, REVIEW_WINDOW,
    ]);
    await waitForTx(publicClient, hash, "createTask B");
  }

  console.log(`\n  B.2  submitDelivery`);
  let deliveredAtB = 0n;
  {
    const hash = await escrowProvider.write.submitDelivery([idB, `0x${"cd".repeat(32)}` as `0x${string}`]);
    await waitForTx(publicClient, hash, "submitDelivery B");
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const blk = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    deliveredAtB = blk.timestamp;
    console.log(`      deliveredAt: ${deliveredAtB}`);
  }

  const waitUntilB = Number(deliveredAtB) + Number(REVIEW_WINDOW) + 2;
  const waitSecsB  = Math.max(0, waitUntilB - Math.floor(Date.now() / 1000));
  console.log(`\n  B.3  Waiting ${waitSecsB}s for the review window to expire (${REVIEW_WINDOW}s)...`);
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

  console.log(`\n  C.1  createTask (short deadline ~70s, provider will NOT deliver)`);
  {
    const hash = await escrowBuyer.write.createTask([
      buyerAccount.address, providerAccount.address, PRICE, shortDeadline, REVIEW_WINDOW,
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

  // Expected net before gas (computed from PRICE, not hardcoded text):
  //   Buyer:    funded A+B+C (3×PRICE), received back C on reclaim → net -(PRICE*2)
  //   Provider: received accept-A + release-B                      → net +(PRICE*2)
  //   Escrow:   all tasks closed                                    → net 0
  const expectedBuyerNet    = -(PRICE * 2n);
  const expectedProviderNet =   PRICE * 2n;
  const expectedEscrowNet   = 0n;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Summary`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  taskCount : ${taskCountInitial} → ${taskCountFinal}`);
  console.log(`  Buyer     : ${formatUsdc(snap0.buyer)} → ${formatUsdc(snapC.buyer)}`);
  console.log(`  Provider  : ${formatUsdc(snap0.provider)} → ${formatUsdc(snapC.provider)}`);
  console.log(`  Escrow    : ${formatUsdc(snapC.escrow)} (should be 0)`);
  console.log();
  console.log(`  Overall net (all three scenarios):`);
  console.log(`    Buyer    : ${fmtDelta(buyerNet)}`);
  console.log(`    Provider : ${fmtDelta(providerNet)}`);
  console.log(`    Escrow   : ${fmtDelta(escrowNet)}`);
  console.log();
  console.log(`  Expected net before gas:`);
  console.log(`    Buyer    : ${fmtDelta(expectedBuyerNet)}  (funded 3×${formatUsdc(PRICE)}, got 1×${formatUsdc(PRICE)} back on reclaim C)`);
  console.log(`    Provider : ${fmtDelta(expectedProviderNet)}  (received accept A + release B)`);
  console.log(`    Escrow   : ${fmtDelta(expectedEscrowNet)}  (all tasks closed)`);
  console.log();
  console.log(`  Gas (Arc-specific — gas is USDC):`);
  console.log(`    Buyer signed    : approve + createTask×3 + accept A + release B + reclaim C = 7 txns`);
  console.log(`    Provider signed : submitDelivery A + submitDelivery B = 2 txns`);
  console.log(`    Actual net deviates from expected by each wallet's total gas paid in USDC.`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err: unknown) => {
  console.error("E2E script failed:", err);
  process.exit(1);
});
