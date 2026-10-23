/**
 * BlindRelayAuction end-to-end integration script — Arc Testnet
 *
 * Runs the full sealed-bid reverse auction lifecycle on Arc Testnet:
 *   1. Buyer creates an auction and funds the budget.
 *   2. Bidder A and Bidder B commit sealed bids (with bonds).
 *   3. Both bidders reveal during the reveal window.
 *   4. Anyone finalizes — lowest price wins and a TaskEscrow task is created.
 *   5. The winner (provider) submits delivery.
 *   6. The buyer accepts, paying the winner.
 *
 * Each wallet's balance is printed before and after every stage.
 * Expected balances are computed from the script constants and printed alongside.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x...  BIDDER_A_PRIVATE_KEY=0x...  BIDDER_B_PRIVATE_KEY=0x...  \
 *     bun run contracts/test-integration/BlindRelayAuctionE2E.ts
 *
 * Requirements:
 *   - All three wallets funded with USDC on Arc Testnet.
 *     Buyer needs at least BUDGET (10 USDC). Each bidder needs at least BOND (1 USDC).
 *     Use "Get test USDC" in the Arc Studio sidebar.
 *   - No CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET needed — plain private keys only.
 *
 * Commit/reveal windows are intentionally short (60 s each) so the script completes quickly.
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
  encodeAbiParameters,
  keccak256,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Load ABIs from committed files (works on Bun 1.x) ────────────────────────

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AUCTION_ABI: readonly any[] = require("../abi/BlindRelayAuction.json");
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

const AUCTION_ADDRESS: Address = "0x27bcab80f486030dec9702d287e354a69bab186d";
const ESCROW_ADDRESS:  Address = "0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d";
const USDC_ADDRESS:    Address = "0x3600000000000000000000000000000000000000";

// ─── Constants — edit these to change the run parameters ─────────────────────

const BUDGET:            bigint = parseUnits("10", 6);   // 10 USDC buyer funds
const BOND:              bigint = parseUnits("1",  6);   //  1 USDC bond per bidder
const PRICE_A:           bigint = parseUnits("7",  6);   //  7 USDC bid from bidder A
const PRICE_B:           bigint = parseUnits("6",  6);   //  6 USDC bid from bidder B (wins)
const COMMIT_DURATION:   bigint = 60n;                   // 60-second commit window
const REVEAL_DURATION:   bigint = 60n;                   // 60-second reveal window
const DELIVERY_DURATION: bigint = 300n;                  // 5-minute delivery deadline
const REVIEW_WINDOW:     bigint = 60n;                   // 60-second review window
const TASK_HASH:         `0x${string}` =
  keccak256(new TextEncoder().encode("e2e test task description"));

// Derived expectations (before gas deductions)
const WINNER_PRICE = PRICE_B < PRICE_A ? PRICE_B : PRICE_A;  // lower price wins
const WINNER_IS_A  = PRICE_A < PRICE_B;                       // tie: A wins (committed first)
const SURPLUS      = BUDGET - WINNER_PRICE;                   // buyer pending after finalize

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

function fmt(amount: bigint): string {
  return `${formatUnits(amount, 6)} USDC`;
}

function fmtDelta(n: bigint): string {
  return n >= 0n ? `+${fmt(n)}` : `-${fmt(-n)}`;
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
  pub: ReturnType<typeof createPublicClient>,
  hash: Hash,
  label: string,
): Promise<void> {
  process.stdout.write(`  ⏳  ${label}...`);
  await pub.waitForTransactionReceipt({ hash });
  console.log(` ✓`);
  console.log(`      tx: ${explorerTx(hash)}`);
}

/** Build a sealed-bid commitment exactly as the contract does. */
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const buyerKey   = process.env.BUYER_PRIVATE_KEY;
  const bidderAKey = process.env.BIDDER_A_PRIVATE_KEY;
  const bidderBKey = process.env.BIDDER_B_PRIVATE_KEY;

  if (!buyerKey || !bidderAKey || !bidderBKey) {
    console.error(
      "\nUsage:\n" +
      "  BUYER_PRIVATE_KEY=0x...  BIDDER_A_PRIVATE_KEY=0x...  BIDDER_B_PRIVATE_KEY=0x...  \\\n" +
      "    bun run contracts/test-integration/BlindRelayAuctionE2E.ts\n\n" +
      `Buyer needs ≥${fmt(BUDGET)} on Arc Testnet.\n` +
      `Each bidder needs ≥${fmt(BOND)} on Arc Testnet.\n` +
      "Use 'Get test USDC' in the Arc Studio sidebar.\n",
    );
    process.exit(1);
  }

  const buyerAccount   = privateKeyToAccount(buyerKey   as `0x${string}`);
  const bidderAAccount = privateKeyToAccount(bidderAKey as `0x${string}`);
  const bidderBAccount = privateKeyToAccount(bidderBKey as `0x${string}`);

  const transport = http("https://rpc.testnet.arc.io");
  const pub = createPublicClient({ chain: arcTestnet, transport });

  const buyerWallet   = createWalletClient({ account: buyerAccount,   chain: arcTestnet, transport });
  const bidderAWallet = createWalletClient({ account: bidderAAccount, chain: arcTestnet, transport });
  const bidderBWallet = createWalletClient({ account: bidderBAccount, chain: arcTestnet, transport });

  const chainId = BigInt(arcTestnet.id);

  // Contract handles
  const auctionRead   = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: pub });
  const auctionBuyer  = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: buyerWallet });
  const auctionBidderA = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: bidderAWallet });
  const auctionBidderB = getContract({ address: AUCTION_ADDRESS, abi: AUCTION_ABI, client: bidderBWallet });

  const escrowRead = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: pub });

  const usdcBuyer   = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: buyerWallet });
  const usdcBidderA = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: bidderAWallet });
  const usdcBidderB = getContract({ address: USDC_ADDRESS, abi: USDC_ABI, client: bidderBWallet });

  // ── Balances ───────────────────────────────────────────────────────────────

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

  // ── Header ─────────────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  BlindRelayAuction End-to-End Integration — Arc Testnet`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  Auction  : ${explorerAddr(AUCTION_ADDRESS)}`);
  console.log(`  Escrow   : ${explorerAddr(ESCROW_ADDRESS)}`);
  console.log(`  USDC     : ${USDC_ADDRESS}`);
  console.log(`  Buyer    : ${buyerAccount.address}`);
  console.log(`  Bidder A : ${bidderAAccount.address}  (bid ${fmt(PRICE_A)})`);
  console.log(`  Bidder B : ${bidderBAccount.address}  (bid ${fmt(PRICE_B)})`);
  console.log(`  Budget   : ${fmt(BUDGET)}  |  Bond: ${fmt(BOND)}`);
  console.log(`  Windows  : commit ${COMMIT_DURATION}s / reveal ${REVEAL_DURATION}s`);
  console.log(`  Expected winner: Bidder ${WINNER_IS_A ? "A" : "B"} at ${fmt(WINNER_PRICE)}`);
  console.log(`${"═".repeat(70)}\n`);

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
  // Winner will need to call TaskEscrow functions after finalize; approve escrow for WINNER_PRICE
  const winnerWallet = WINNER_IS_A ? bidderAWallet : bidderBWallet;
  const winnerAccount = WINNER_IS_A ? bidderAAccount : bidderBAccount;
  const escrowWinner  = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: winnerWallet });
  const escrowBuyer   = getContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, client: buyerWallet });

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
      BUDGET,
      COMMIT_DURATION,
      REVEAL_DURATION,
      BOND,
      DELIVERY_DURATION,
      REVIEW_WINDOW,
      TASK_HASH,
    ]);
    await waitForTx(pub, hash, `createAuction (budget ${fmt(BUDGET)})`);
    auctionId = auctionCountInitial;
    console.log(`  Auction ID: ${auctionId}`);
    console.log(`  Commit window closes: ~${new Date(Number(commitEnd) * 1000).toISOString()}`);
    console.log(`  Reveal window closes: ~${new Date(Number(revealEnd) * 1000).toISOString()}`);
  }

  const snap2 = await snapshot("after createAuction");
  // Expected: buyer -BUDGET (funded auction), auction +BUDGET
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
  // Expected: each bidder -BOND (bond posted), auction +2×BOND
  printDeltaAndExpected(snap2, snap3, 0n, -BOND, -BOND, BOND * 2n, 0n, "stage 3 (commits)");

  // Wait for commit window to close
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
  // Reveals don't move tokens
  printDeltaAndExpected(snap3, snap4, 0n, 0n, 0n, 0n, 0n, "stage 4 (reveals, gas only)");

  // Read current best bid from the contract
  const auctionView = await auctionRead.read.getAuction([auctionId]) as { bestPrice: bigint; bestBidder: Address };
  console.log(`\n  Current best bid: ${fmt(auctionView.bestPrice)} from ${auctionView.bestBidder}`);
  console.log(`  Expected winner : Bidder ${WINNER_IS_A ? "A" : "B"} (${winnerAccount.address})`);

  // Wait for reveal window to close
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
    const hash = await auctionBuyer.write.finalize([auctionId]);
    await waitForTx(pub, hash, `finalize auction ${auctionId}`);
    taskId = taskCountBefore; // first task created by this finalize
    console.log(`  TaskEscrow task ID: ${taskId}`);
  }

  const snap5 = await snapshot("after finalize");
  // Expected: auction contract pays WINNER_PRICE to escrow, keeps SURPLUS + 2×BOND pending
  // Escrow receives WINNER_PRICE; auction net = -(WINNER_PRICE) from escrow flow
  // Pending balances credited (not yet withdrawn): buyer +SURPLUS, winner +BOND, loser +BOND
  // Actual auction token balance = initial budget + 2 bonds - winner price
  printDeltaAndExpected(
    snap4, snap5,
    0n,                    // buyer: nothing moved yet (pending not withdrawn)
    0n,                    // bidderA: nothing moved yet
    0n,                    // bidderB: nothing moved yet
    -(WINNER_PRICE),       // auction: paid winner price into escrow
    WINNER_PRICE,          // escrow: received winner price
    "stage 5 (finalize)",
  );

  // Read pending balances
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
    SURPLUS, BOND, BOND,   // buyer +surplus, each bidder +bond
    -(SURPLUS + BOND * 2n), // auction paid out
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
    0n,                    // buyer: paid into escrow on createAuction — no change here
    WINNER_IS_A ? WINNER_PRICE : 0n,   // bidderA gets payment if winner
    WINNER_IS_A ? 0n : WINNER_PRICE,   // bidderB gets payment if winner
    0n,
    -WINNER_PRICE,          // escrow paid out to winner
    "stages 7–8 (deliver + accept)",
  );

  // ─── Final summary ─────────────────────────────────────────────────────────

  const auctionCountFinal = await auctionRead.read.auctionCount() as bigint;
  const taskCountFinal    = await escrowRead.read.taskCount() as bigint;

  const overallBuyer   = snap8.buyer   - snap0.buyer;
  const overallBidderA = snap8.bidderA - snap0.bidderA;
  const overallBidderB = snap8.bidderB - snap0.bidderB;
  const overallEscrow  = snap8.escrow  - snap0.escrow;

  // Expected overall:
  // Buyer: -BUDGET (created auction) + SURPLUS (withdrew) = -(WINNER_PRICE) net
  // Bidder A (if winner): -BOND (commit) + BOND (withdrew) + WINNER_PRICE (accept) = +WINNER_PRICE
  //         (if loser):   -BOND (commit) + BOND (withdrew)                          = 0
  // Bidder B (if winner): same as A winner
  //         (if loser):   same as A loser
  // Escrow: 0 (task settled)
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
  row("Buyer",   snap8.buyer,   overallBuyer,   expOverallBuyer);
  row("Bidder A", snap8.bidderA, overallBidderA, expOverallBidderA);
  row("Bidder B", snap8.bidderB, overallBidderB, expOverallBidderB);
  row("Escrow",  snap8.escrow,  overallEscrow,  expOverallEscrow);
  console.log();
  console.log(`  Gas note (Arc-specific — gas is USDC):`);
  console.log(`    Buyer signed   : approve + createAuction + finalize + withdraw + accept = 5 txns`);
  console.log(`    Bidder A signed: approve + commitBid + revealBid + withdraw + (submitDelivery if winner) = 4–5 txns`);
  console.log(`    Bidder B signed: approve + commitBid + revealBid + withdraw + (submitDelivery if winner) = 4–5 txns`);
  console.log(`    Actual net < expected by each wallet's cumulative gas (USDC, typically <$0.01/tx on Arc).`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("E2E script failed:", err);
  process.exit(1);
});
