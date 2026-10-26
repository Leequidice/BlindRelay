/**
 * BlindRelayAuction end-to-end integration script
 *
 * Runs the full sealed-bid reverse auction lifecycle on the active network:
 *   1. Buyer creates an auction and funds the budget.
 *   2. Bidder A and Bidder B commit sealed bids (with bonds).
 *   3. Both bidders reveal during the reveal window.
 *   4. Anyone finalizes — lowest price wins and a TaskEscrow task is created.
 *   5. The winner (provider) submits delivery.
 *   6. The buyer accepts, paying the winner.
 *
 * Balance tables use the configured amounts throughout — no hardcoded values.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x...  BIDDER_A_PRIVATE_KEY=0x...  BIDDER_B_PRIVATE_KEY=0x...  \
 *     bun run contracts/test-integration/BlindRelayAuctionE2E.ts
 *
 * Optional env vars (all amounts in USDC with up to 6 decimal places):
 *   BUDGET             — buyer's auction budget  (default: 2)
 *   BOND               — bond per bidder         (default: 0.5)
 *   PRICE_A            — bidder A's ask price    (default: 1.5)
 *   PRICE_B            — bidder B's ask price    (default: 1.2)
 *   COMMIT_DURATION    — commit window in seconds (default: 180)
 *   REVEAL_DURATION    — reveal window in seconds (default: 180)
 *   DELIVERY_DURATION  — delivery deadline in seconds (default: 300)
 *   REVIEW_WINDOW      — review window in seconds (default: 60)
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
  encodeAbiParameters,
  keccak256,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_CONFIG, BLIND_RELAY_AUCTION_ABI, TASK_ESCROW_ABI } from "../../src/lib/blindrelay.js";

// ─── ABIs (re-exported from blindrelay.ts, which imports them as static JSON) ─

const AUCTION_ABI = BLIND_RELAY_AUCTION_ABI;
const ESCROW_ABI  = TASK_ESCROW_ABI;

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

function fmt(amount: bigint): string {
  return `${formatUnits(amount, USDC_DECIMALS)} USDC`;
}

function fmtDelta(n: bigint): string {
  return n >= 0n ? `+${fmt(n)}` : `-${fmt(-n)}`;
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
  pub: ReturnType<typeof createPublicClient>,
  hash: Hash,
  label: string,
): Promise<void> {
  process.stdout.write(`  ⏳  ${label}...`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    console.log(` ✗`);
    console.log(`      tx (REVERTED): ${explorerTx(hash)}`);
    throw new Error(`Transaction reverted: ${label}\n  tx: ${explorerTx(hash)}`);
  }
  console.log(` ✓`);
  console.log(`      tx: ${explorerTx(hash)}`);
}

/** Build a sealed-bid commitment exactly as the Solidity contract does. */
function makeCommitment(
  auctionAddress: Address,
  chainId: bigint,
  auctionId: bigint,
  bidder: Address,
  price: bigint,
  salt: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [auctionAddress, chainId, auctionId, bidder, price, salt],
    ),
  );
}

/** Parse a USDC amount from an env var string, with a fallback default. */
function envUsdc(varName: string, defaultVal: string): bigint {
  const raw = process.env[varName] ?? defaultVal;
  return parseUnits(raw, USDC_DECIMALS);
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
      `      bun run contracts/test-integration/BlindRelayAuctionE2E.ts --yes-mainnet\n\n` +
      `    Make sure all wallets are funded with real USDC on ${CHAIN_CONFIG.chainName}.\n`,
    );
    process.exit(1);
  }

  // ── Private keys ─────────────────────────────────────────────────────────
  const buyerKey   = process.env.BUYER_PRIVATE_KEY;
  const bidderAKey = process.env.BIDDER_A_PRIVATE_KEY;
  const bidderBKey = process.env.BIDDER_B_PRIVATE_KEY;

  if (!buyerKey || !bidderAKey || !bidderBKey) {
    console.error(
      "\nMissing private keys. Set all three environment variables:\n\n" +
      "  BUYER_PRIVATE_KEY=0x...  BIDDER_A_PRIVATE_KEY=0x...  BIDDER_B_PRIVATE_KEY=0x...  \\\n" +
      "    bun run contracts/test-integration/BlindRelayAuctionE2E.ts\n\n" +
      "Use 'Get test USDC' in the Arc Studio sidebar to fund testnet wallets.\n",
    );
    process.exit(1);
  }

  // ── Run parameters from env vars ──────────────────────────────────────────
  const BUDGET            = envUsdc("BUDGET",    "2");
  const BOND              = envUsdc("BOND",      "0.5");
  const PRICE_A           = envUsdc("PRICE_A",   "1.5");
  const PRICE_B           = envUsdc("PRICE_B",   "1.2");
  const COMMIT_DURATION   = envDuration("COMMIT_DURATION",   180);
  const REVEAL_DURATION   = envDuration("REVEAL_DURATION",   180);
  // Default: commit+reveal windows plus 30-minute buffer, so the task deadline
  // is always well in the future at finalize time even if finalize is called
  // several minutes after the reveal window closes.
  const DELIVERY_DURATION = envDuration(
    "DELIVERY_DURATION",
    Number(COMMIT_DURATION) + Number(REVEAL_DURATION) + 1800,
  );
  const REVIEW_WINDOW     = envDuration("REVIEW_WINDOW",      60);

  // Derived
  const WINNER_PRICE = PRICE_B < PRICE_A ? PRICE_B : PRICE_A;
  const WINNER_IS_A  = PRICE_A < PRICE_B;          // tie: A wins (committed first)
  const SURPLUS      = BUDGET - WINNER_PRICE;

  const TASK_HASH: `0x${string}` =
    keccak256(new TextEncoder().encode("e2e test task description"));

  // ── Addresses from CHAIN_CONFIG ───────────────────────────────────────────
  const AUCTION_ADDRESS = CHAIN_CONFIG.blindRelayAuctionAddress;
  const ESCROW_ADDRESS  = CHAIN_CONFIG.taskEscrowAddress;
  const USDC_ADDRESS    = CHAIN_CONFIG.usdcAddress;

  if (
    AUCTION_ADDRESS === "0x0000000000000000000000000000000000000000" ||
    ESCROW_ADDRESS  === "0x0000000000000000000000000000000000000000"
  ) {
    console.error(
      `\n⛔  Contract addresses are not set for '${CHAIN_CONFIG.chainName}'.\n` +
      `    Deploy first, then update src/lib/blindrelay.ts with the addresses.\n`,
    );
    process.exit(1);
  }

  // ── Viem clients ──────────────────────────────────────────────────────────
  const buyerAccount   = privateKeyToAccount(buyerKey   as `0x${string}`);
  const bidderAAccount = privateKeyToAccount(bidderAKey as `0x${string}`);
  const bidderBAccount = privateKeyToAccount(bidderBKey as `0x${string}`);

  const transport = http(CHAIN_CONFIG.rpcUrl);
  const pub = createPublicClient({ chain: CHAIN_CONFIG.viemChain, transport });

  const buyerWallet    = createWalletClient({ account: buyerAccount,   chain: CHAIN_CONFIG.viemChain, transport });
  const bidderAWallet  = createWalletClient({ account: bidderAAccount, chain: CHAIN_CONFIG.viemChain, transport });
  const bidderBWallet  = createWalletClient({ account: bidderBAccount, chain: CHAIN_CONFIG.viemChain, transport });

  const chainId = BigInt(CHAIN_CONFIG.chainId);

  // ── Contract handles ──────────────────────────────────────────────────────
  const auctionRead    = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: pub });
  const auctionBuyer   = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: buyerWallet });
  const auctionBidderA = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: bidderAWallet });
  const auctionBidderB = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: bidderBWallet });
  const escrowRead     = getContract({ address: ESCROW_ADDRESS,  abi: ESCROW_ABI,  client: pub });

  const usdcBuyer   = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: buyerWallet });
  const usdcBidderA = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: bidderAWallet });
  const usdcBidderB = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: bidderBWallet });

  const winnerWallet  = WINNER_IS_A ? bidderAWallet  : bidderBWallet;
  const winnerAccount = WINNER_IS_A ? bidderAAccount : bidderBAccount;
  const escrowWinner  = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: winnerWallet });
  const escrowBuyer   = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: buyerWallet });

  // ── Balance snapshots ─────────────────────────────────────────────────────

  type Snap = { buyer: bigint; bidderA: bigint; bidderB: bigint; auction: bigint; escrow: bigint };

  async function snapshot(label: string): Promise<Snap> {
    const [b, a, bb, au, e] = await Promise.all([
      pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [buyerAccount.address] }),
      pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [bidderAAccount.address] }),
      pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [bidderBAccount.address] }),
      pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [AUCTION_ADDRESS] }),
      pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [ESCROW_ADDRESS] }),
    ]);
    console.log(`  Balances [${label}]:`);
    console.log(`    Buyer   : ${fmt(b)}`);
    console.log(`    Bidder A: ${fmt(a)}`);
    console.log(`    Bidder B: ${fmt(bb)}`);
    console.log(`    Auction : ${fmt(au)}`);
    console.log(`    Escrow  : ${fmt(e)}`);
    return { buyer: b, bidderA: a, bidderB: bb, auction: au, escrow: e };
  }

  function printDeltaAndExpected(
    before: Snap, after: Snap,
    expBuyer: bigint, expBidderA: bigint, expBidderB: bigint, expAuction: bigint, expEscrow: bigint,
    label: string,
  ) {
    const d = (x: bigint) => fmtDelta(x);
    const actual = {
      buyer:   after.buyer   - before.buyer,
      bidderA: after.bidderA - before.bidderA,
      bidderB: after.bidderB - before.bidderB,
      auction: after.auction - before.auction,
      escrow:  after.escrow  - before.escrow,
    };
    console.log(`  Net change [${label}]:`);
    console.log(`    ${"Wallet".padEnd(10)} ${"Actual".padStart(18)}   ${"Expected (before gas)".padStart(22)}`);
    console.log(`    ${"─".repeat(54)}`);
    console.log(`    ${"Buyer".padEnd(10)} ${d(actual.buyer).padStart(18)}   ${fmtDelta(expBuyer).padStart(22)}`);
    console.log(`    ${"Bidder A".padEnd(10)} ${d(actual.bidderA).padStart(18)}   ${fmtDelta(expBidderA).padStart(22)}`);
    console.log(`    ${"Bidder B".padEnd(10)} ${d(actual.bidderB).padStart(18)}   ${fmtDelta(expBidderB).padStart(22)}`);
    console.log(`    ${"Auction".padEnd(10)} ${d(actual.auction).padStart(18)}   ${fmtDelta(expAuction).padStart(22)}`);
    console.log(`    ${"Escrow".padEnd(10)} ${d(actual.escrow).padStart(18)}   ${fmtDelta(expEscrow).padStart(22)}`);
  }

  // ── Header ────────────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  BlindRelayAuction End-to-End Integration`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  Network  : ${CHAIN_CONFIG.chainName} (chain ${CHAIN_CONFIG.chainId})`);
  console.log(`  RPC      : ${CHAIN_CONFIG.rpcUrl}`);
  console.log(`  Auction  : ${explorerAddr(AUCTION_ADDRESS)}`);
  console.log(`  Escrow   : ${explorerAddr(ESCROW_ADDRESS)}`);
  console.log(`  USDC     : ${USDC_ADDRESS}`);
  console.log(`  Buyer    : ${buyerAccount.address}`);
  console.log(`  Bidder A : ${bidderAAccount.address}  (bid ${fmt(PRICE_A)})`);
  console.log(`  Bidder B : ${bidderBAccount.address}  (bid ${fmt(PRICE_B)})`);
  console.log(`  Budget   : ${fmt(BUDGET)}  |  Bond: ${fmt(BOND)}`);
  console.log(`  Windows  : commit ${COMMIT_DURATION}s / reveal ${REVEAL_DURATION}s`);
  console.log(`  Expected winner: Bidder ${WINNER_IS_A ? "A" : "B"} at ${fmt(WINNER_PRICE)}`);
  console.log(`${"═".repeat(70)}`);

  if (isMainnet) {
    console.log(`\n  ⚠️   MAINNET — pausing 5 seconds before sending any transaction.`);
    console.log(`       Press Ctrl-C now to abort.\n`);
    await sleep(5000);
  } else {
    console.log();
  }

  const auctionCountInitial = await auctionRead.read.auctionCount() as bigint;
  const snap0 = await snapshot("initial");
  console.log(`  auctionCount at start: ${auctionCountInitial}`);
  console.log(`  Note: gas is paid in USDC on Arc — actual net will differ from expected by gas costs.\n`);

  // ─── STAGE 1: Approvals ────────────────────────────────────────────────────

  console.log(`${"─".repeat(70)}`);
  console.log(`  STAGE 1 — Approvals`);
  console.log(`${"─".repeat(70)}`);

  {
    const hash = await usdcBuyer.write.approve([AUCTION_ADDRESS, BUDGET]);
    await waitForTx(pub, hash, `Buyer approves auction for ${fmt(BUDGET)}`);
  }
  {
    const hash = await usdcBidderA.write.approve([AUCTION_ADDRESS, BOND]);
    await waitForTx(pub, hash, `Bidder A approves auction for bond ${fmt(BOND)}`);
  }
  {
    const hash = await usdcBidderB.write.approve([AUCTION_ADDRESS, BOND]);
    await waitForTx(pub, hash, `Bidder B approves auction for bond ${fmt(BOND)}`);
  }

  const snap1 = await snapshot("after approvals");
  printDeltaAndExpected(snap0, snap1, 0n, 0n, 0n, 0n, 0n, "stage 1 (approvals, gas only)");

  // ─── STAGE 2: Create auction ───────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 2 — Create auction`);
  console.log(`${"─".repeat(70)}`);

  const now1 = (await pub.getBlock()).timestamp;
  const commitEnd = now1 + COMMIT_DURATION;
  const revealEnd = commitEnd + REVEAL_DURATION;

  let auctionId: bigint;
  {
    const hash = await auctionBuyer.write.createAuction([
      BUDGET, COMMIT_DURATION, REVEAL_DURATION, BOND, DELIVERY_DURATION, REVIEW_WINDOW, TASK_HASH,
    ]);
    await waitForTx(pub, hash, `createAuction (budget ${fmt(BUDGET)})`);
    auctionId = auctionCountInitial;
    console.log(`  Auction ID: ${auctionId}`);
    console.log(`  Commit window closes: ~${new Date(Number(commitEnd) * 1000).toISOString()}`);
    console.log(`  Reveal window closes: ~${new Date(Number(revealEnd) * 1000).toISOString()}`);
  }

  const snap2 = await snapshot("after createAuction");
  printDeltaAndExpected(snap1, snap2, -BUDGET, 0n, 0n, BUDGET, 0n, "stage 2 (createAuction)");

  // ─── STAGE 3: Commit phase ─────────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 3 — Commit phase (${COMMIT_DURATION}s window)`);
  console.log(`${"─".repeat(70)}`);

  const saltA: `0x${string}` = keccak256(new TextEncoder().encode("bidder-a-salt-e2e"));
  const saltB: `0x${string}` = keccak256(new TextEncoder().encode("bidder-b-salt-e2e"));

  const commitmentA = makeCommitment(AUCTION_ADDRESS, chainId, auctionId, bidderAAccount.address, PRICE_A, saltA);
  const commitmentB = makeCommitment(AUCTION_ADDRESS, chainId, auctionId, bidderBAccount.address, PRICE_B, saltB);
  console.log(`  Bidder A commitment: ${commitmentA.slice(0, 20)}...`);
  console.log(`  Bidder B commitment: ${commitmentB.slice(0, 20)}...`);

  {
    const hash = await auctionBidderA.write.commitBid([auctionId, commitmentA]);
    await waitForTx(pub, hash, `Bidder A commits (order=1)`);
  }
  {
    const hash = await auctionBidderB.write.commitBid([auctionId, commitmentB]);
    await waitForTx(pub, hash, `Bidder B commits (order=2)`);
  }

  const snap3 = await snapshot("after commits");
  printDeltaAndExpected(snap2, snap3, 0n, -BOND, -BOND, BOND * 2n, 0n, "stage 3 (commits)");

  const nowAfterCommits = Math.floor(Date.now() / 1000);
  const waitForReveal = Math.max(0, Number(commitEnd) - nowAfterCommits + 2);
  console.log(`\n  Waiting ${waitForReveal}s for commit window to close...`);
  if (waitForReveal > 0) await sleep(waitForReveal * 1000);
  console.log(`  Commit window closed. Entering reveal phase.`);

  // ─── STAGE 4: Reveal phase ─────────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 4 — Reveal phase (${REVEAL_DURATION}s window)`);
  console.log(`${"─".repeat(70)}`);

  {
    const hash = await auctionBidderA.write.revealBid([auctionId, PRICE_A, saltA]);
    await waitForTx(pub, hash, `Bidder A reveals ${fmt(PRICE_A)}`);
  }
  {
    const hash = await auctionBidderB.write.revealBid([auctionId, PRICE_B, saltB]);
    await waitForTx(pub, hash, `Bidder B reveals ${fmt(PRICE_B)}`);
  }

  const snap4 = await snapshot("after reveals");
  printDeltaAndExpected(snap3, snap4, 0n, 0n, 0n, 0n, 0n, "stage 4 (reveals, gas only)");

  const auctionView = await auctionRead.read.getAuction([auctionId]) as { bestPrice: bigint; bestBidder: Address };
  console.log(`\n  Current best bid: ${fmt(auctionView.bestPrice)} from ${auctionView.bestBidder}`);
  console.log(`  Expected winner : Bidder ${WINNER_IS_A ? "A" : "B"} (${winnerAccount.address})`);

  const nowAfterReveals = Math.floor(Date.now() / 1000);
  const waitForFinalize = Math.max(0, Number(revealEnd) - nowAfterReveals + 2);
  console.log(`\n  Waiting ${waitForFinalize}s for reveal window to close...`);
  if (waitForFinalize > 0) await sleep(waitForFinalize * 1000);
  console.log(`  Reveal window closed. Ready to finalize.`);

  // ─── STAGE 5: Finalize ─────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 5 — Finalize (called by buyer)`);
  console.log(`${"─".repeat(70)}`);

  const taskCountBefore = await escrowRead.read.taskCount() as bigint;
  let taskId: bigint;

  {
    // Finalize has a GAS_FLOOR guard (800_000). Pass an explicit gas limit
    // (max(estimate×1.2, 900_000)) so the guard is always satisfied.
    const gasEst = await pub.estimateContractGas({
      address: AUCTION_ADDRESS, abi: AUCTION_ABI, functionName: "finalize",
      args: [auctionId], account: buyerAccount,
    });
    const gasLimit = gasEst * 12n / 10n > 900_000n ? gasEst * 12n / 10n : 900_000n;
    const hash = await auctionBuyer.write.finalize([auctionId], { gas: gasLimit });
    await waitForTx(pub, hash, `finalize auction ${auctionId} (gas limit: ${gasLimit.toLocaleString()})`);
    taskId = taskCountBefore;
    console.log(`  TaskEscrow task ID: ${taskId}`);
  }

  const snap5 = await snapshot("after finalize");
  printDeltaAndExpected(
    snap4, snap5,
    0n,               // buyer: pending not yet withdrawn
    0n,               // bidderA: pending not yet withdrawn
    0n,               // bidderB: pending not yet withdrawn
    -(WINNER_PRICE),  // auction: paid winner price into escrow
    WINNER_PRICE,     // escrow: received winner price
    "stage 5 (finalize)",
  );

  const pendingBuyer   = await auctionRead.read.pendingBalances([buyerAccount.address]) as bigint;
  const pendingBidderA = await auctionRead.read.pendingBalances([bidderAAccount.address]) as bigint;
  const pendingBidderB = await auctionRead.read.pendingBalances([bidderBAccount.address]) as bigint;
  console.log(`\n  Pending balances (claimable via withdraw()):`);
  console.log(`    Buyer   : ${fmt(pendingBuyer)}  (expected: ${fmt(SURPLUS)})`);
  console.log(`    Bidder A: ${fmt(pendingBidderA)}  (expected: ${fmt(BOND)})`);
  console.log(`    Bidder B: ${fmt(pendingBidderB)}  (expected: ${fmt(BOND)})`);

  // ─── STAGE 6: Withdrawals ──────────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 6 — Withdrawals`);
  console.log(`${"─".repeat(70)}`);

  {
    const hash = await auctionBuyer.write.withdraw();
    await waitForTx(pub, hash, `Buyer withdraws ${fmt(SURPLUS)} surplus`);
  }
  {
    const hash = await auctionBidderA.write.withdraw();
    await waitForTx(pub, hash, `Bidder A withdraws ${fmt(BOND)} bond`);
  }
  {
    const hash = await auctionBidderB.write.withdraw();
    await waitForTx(pub, hash, `Bidder B withdraws ${fmt(BOND)} bond`);
  }

  const snap6 = await snapshot("after withdrawals");
  printDeltaAndExpected(
    snap5, snap6,
    SURPLUS, BOND, BOND,
    -(SURPLUS + BOND * 2n),
    0n,
    "stage 6 (withdrawals)",
  );

  // ─── STAGE 7: Winner delivers ──────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 7 — Winner submits delivery (task ${taskId})`);
  console.log(`${"─".repeat(70)}`);

  const deliveryHash: `0x${string}` = keccak256(new TextEncoder().encode("e2e delivery content hash"));
  {
    const hash = await escrowWinner.write.submitDelivery([taskId, deliveryHash]);
    await waitForTx(pub, hash, `submitDelivery (winner: Bidder ${WINNER_IS_A ? "A" : "B"})`);
  }

  const taskAfterDelivery = await escrowRead.read.tasks([taskId]) as readonly unknown[];
  const STATUS = ["Funded", "Delivered", "Settled", "Reclaimed", "Disputed"];
  console.log(`  Task status: ${STATUS[taskAfterDelivery[6] as number]} ✓`);

  // ─── STAGE 8: Buyer accepts ────────────────────────────────────────────────

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  STAGE 8 — Buyer accepts delivery (task ${taskId})`);
  console.log(`${"─".repeat(70)}`);

  {
    const hash = await escrowBuyer.write.accept([taskId]);
    await waitForTx(pub, hash, `accept task ${taskId}`);
  }

  const taskAfterAccept = await escrowRead.read.tasks([taskId]) as readonly unknown[];
  console.log(`  Task status: ${STATUS[taskAfterAccept[6] as number]} ✓`);

  const snap8 = await snapshot("after accept");
  printDeltaAndExpected(
    snap6, snap8,
    0n,
    WINNER_IS_A ? WINNER_PRICE : 0n,
    WINNER_IS_A ? 0n : WINNER_PRICE,
    0n,
    -WINNER_PRICE,
    "stages 7–8 (deliver + accept)",
  );

  // ─── Final summary ─────────────────────────────────────────────────────────

  const auctionCountFinal = await auctionRead.read.auctionCount() as bigint;
  const taskCountFinal    = await escrowRead.read.taskCount() as bigint;

  const overallBuyer   = snap8.buyer   - snap0.buyer;
  const overallBidderA = snap8.bidderA - snap0.bidderA;
  const overallBidderB = snap8.bidderB - snap0.bidderB;
  const overallEscrow  = snap8.escrow  - snap0.escrow;

  const expOverallBuyer   = -WINNER_PRICE;
  const expOverallBidderA = WINNER_IS_A ? WINNER_PRICE : 0n;
  const expOverallBidderB = WINNER_IS_A ? 0n : WINNER_PRICE;
  const expOverallEscrow  = 0n;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Final summary`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  auctionCount : ${auctionCountInitial} → ${auctionCountFinal}`);
  console.log(`  taskCount    : ${taskCountBefore} → ${taskCountFinal}`);
  console.log();
  console.log(`  ${"Wallet".padEnd(10)} ${"Final balance".padStart(18)}   ${"Overall net (actual)".padStart(22)}   ${"Expected (before gas)".padStart(22)}`);
  console.log(`  ${"─".repeat(78)}`);
  const row = (label: string, bal: bigint, net: bigint, exp: bigint) =>
    console.log(`  ${label.padEnd(10)} ${fmt(bal).padStart(18)}   ${fmtDelta(net).padStart(22)}   ${fmtDelta(exp).padStart(22)}`);
  row("Buyer",    snap8.buyer,   overallBuyer,   expOverallBuyer);
  row("Bidder A", snap8.bidderA, overallBidderA, expOverallBidderA);
  row("Bidder B", snap8.bidderB, overallBidderB, expOverallBidderB);
  row("Escrow",   snap8.escrow,  overallEscrow,  expOverallEscrow);
  console.log();
  console.log(`  Gas note (Arc-specific — gas is USDC):`);
  console.log(`    Buyer signed   : approve + createAuction + finalize + withdraw + accept = 5 txns`);
  console.log(`    Bidder A signed: approve + commitBid + revealBid + withdraw + (submitDelivery if winner) = 4–5 txns`);
  console.log(`    Bidder B signed: approve + commitBid + revealBid + withdraw + (submitDelivery if winner) = 4–5 txns`);
  console.log(`    Actual net < expected by each wallet's cumulative gas (USDC, typically <$0.01/tx on Arc).`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err: unknown) => {
  console.error("E2E script failed:", err);
  process.exit(1);
});
