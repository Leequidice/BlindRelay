# BlindRelayAuction — Design Document

## 1. Purpose

`BlindRelayAuction` is a sealed-bid reverse auction that sits in front of a deployed `TaskEscrow`. A buyer posts a USDC budget for a piece of work described by a `taskHash`; bidders compete by committing sealed bids (bond required) and later revealing them; the lowest valid revealed price wins; `finalize` creates the escrow task via `TaskEscrow.createTask` so the buyer is the named escrow buyer and the winner is the provider. Pull payments are used throughout so no single blacklisted address can block finalization.

---

## 2. Actors and Trust Model

| Actor | Description |
|---|---|
| Buyer | Creates the auction; funds budget upfront; is named buyer on the resulting task; cannot bid |
| Bidder | Any address except the buyer; posts a bond to commit; reveals to compete; gets bond back if they reveal; forfeits bond if they commit but do not reveal |
| Anyone | Can call `finalize` once the reveal window closes; can call `withdraw` for their own pending balance |
| TaskEscrow | External contract at a fixed constructor-provided address; `BlindRelayAuction` calls `createTask` on it |
| No admin | No owner, no admin role, no privileged address can touch funds |

---

## 3. Auction Lifecycle and Statuses

```
           createAuction
                │
                ▼
            [Active]
         ┌────────────────────────────────────────┐
         │ Commit phase: [0, commitEnd)            │
         │   commitBid (any non-buyer with USDC)   │
         ├────────────────────────────────────────┤
         │ Reveal phase: [commitEnd, revealEnd)    │
         │   revealBid (committed bidders only)    │
         └────────────────────────────────────────┘
                │
         finalize (anyone, block.timestamp >= revealEnd)
                │
         ┌──────┴──────────┐
         │                 │
    [Finalized]       [Cancelled]
  (winner found)    (no valid reveal)
```

---

## 4. Phase Boundaries (Exact Rules)

- Commit phase: `block.timestamp < commitEnd`
  - `commitBid` succeeds
  - `revealBid` reverts
- Reveal phase: `commitEnd <= block.timestamp < revealEnd`
  - `revealBid` succeeds
  - `commitBid` reverts
- Post-reveal: `block.timestamp >= revealEnd`
  - `finalize` succeeds
  - `commitBid` and `revealBid` both revert

---

## 5. Commitment Scheme

```
commitment = keccak256(abi.encode(
    address(BlindRelayAuction),   // binds to this contract (replay protection)
    block.chainid,                // binds to the chain (cross-chain replay protection)
    auctionId,                    // binds to the specific auction
    bidder,                       // binds to the bidder (copies fail on reveal)
    price,                        // the sealed bid amount
    salt                          // random nonce
))
```

Including `address(this)` and `block.chainid` prevents a commitment made on one contract/chain being replayed on another. Including `bidder` means copying another bidder's commitment reveals as the wrong address and fails the hash check.

---

## 6. Winner Selection (O(1), No Loop)

Best bid is tracked **incrementally** during `revealBid`:
- First valid reveal is always recorded as the current best.
- Each subsequent valid reveal replaces the best if: `price < bestPrice` (strictly lower), OR `price == bestPrice && commitOrder[bidder] < commitOrder[bestBidder]` (tie goes to earliest commit).
- `commitOrder` is a 1-based counter stored per auction per bidder at commit time. Lower number = earlier commit.

`finalize` reads `auction.bestBidder` and `auction.bestPrice` directly — no loop over bidders.

---

## 7. Pull-Payment Architecture

All fund flows out of the contract (refunds, bond returns, surplus, forfeited bonds) go through `pendingBalances[recipient]` and are claimed by calling `withdraw()`. This ensures:
- A USDC-blacklisted winner/buyer cannot block `finalize` for others.
- Reentrancy surface is limited to `withdraw`, which is guarded with `nonReentrant` + CEI.
- Gas cost of `finalize` is O(1) regardless of bidder count (no inline transfers in `finalize`).

The only outward USDC transfer in `finalize` is `safeApprove` + `createTask` (which pulls from this contract). That path uses CEI: auction status is set to `Finalized`/`Cancelled` before the external call.

---

## 8. Bond Mechanics

| Scenario | Bond outcome |
|---|---|
| Bidder reveals (any price) | Bond credited to `pendingBalances[bidder]` in `finalize` |
| Bidder commits but does not reveal | Bond forfeited to `pendingBalances[buyer]` in `finalize` |
| No valid reveals at all | All bonds (all committed bidders) forfeited to `pendingBalances[buyer]` |

Bonds are tracked in `auction.commitOrder` (existence check) and `auction.hasRevealed` (to distinguish revealers from non-revealers). `finalize` iterates over `auction.committers` (array of addresses built at commit time) to process bonds — this is the ONLY loop in the contract. Gas is bounded by the number of committers; this is a known design tradeoff (see Section 13).

---

## 9. Finalize Logic

```
if (bestBidder != address(0)):
    status = Finalized
    approve escrow contract for bestPrice
    call escrow.createTask(buyer, bestBidder, bestPrice, now + deliveryDuration, reviewWindow)
    pendingBalances[buyer] += (budget - bestPrice)    // surplus
    for each committer:
        if revealed: pendingBalances[committer] += bondAmount
        else:        pendingBalances[buyer]     += bondAmount  // forfeited
else:
    status = Cancelled
    pendingBalances[buyer] += budget
    for each committer:
        pendingBalances[buyer] += bondAmount  // all bonds forfeited (no reveals = default)
```

State (`status`) is set to `Finalized`/`Cancelled` BEFORE the `createTask` external call (CEI).

---

## 10. Storage Layout

```solidity
enum AuctionStatus { Active, Finalized, Cancelled }

struct Auction {
    address  buyer;
    uint256  budget;
    uint256  bondAmount;
    uint256  bestPrice;
    address  bestBidder;
    uint64   commitEnd;
    uint64   revealEnd;
    uint64   deliveryDuration;
    uint64   reviewWindow;
    bytes32  taskHash;
    AuctionStatus status;
    uint32   commitCounter;          // increments at each commit, 1-based
    address[] committers;            // ordered list for bond processing in finalize
    mapping(address => bytes32)  commitments;
    mapping(address => uint32)   commitOrder;
    mapping(address => bool)     hasRevealed;
}

uint256 public auctionCount;
mapping(uint256 => Auction) public auctions;
mapping(address => uint256) public pendingBalances;
address public immutable usdc;
address public immutable escrow;
```

---

## 11. Validation Rules (createAuction)

| Check | Error |
|---|---|
| budget == 0 | `ZeroBudget` |
| bondAmount == 0 | `ZeroBond` |
| commitDuration < 60s or > 7 days | `DurationOutOfRange` |
| revealDuration < 60s or > 7 days | `DurationOutOfRange` |
| reviewWindow == 0 | `ZeroReviewWindow` |
| deliveryDuration == 0 | `ZeroDeliveryDuration` |

---

## 12. Events

```
AuctionCreated(auctionId, buyer, budget, bondAmount, commitEnd, revealEnd, taskHash)
BidCommitted(auctionId, bidder, commitOrder)
BidRevealed(auctionId, bidder, price)
AuctionFinalized(auctionId, winner, price, taskId)
AuctionCancelled(auctionId)
Withdrawn(recipient, amount)
```

---

## 13. Security Considerations

| Topic | Decision |
|---|---|
| Reentrancy | `nonReentrant` on `createAuction`, `commitBid`, `finalize`, `withdraw`. `revealBid` has no external calls. |
| CEI | Status set to terminal BEFORE `createTask` external call in `finalize`; `pendingBalances` zeroed BEFORE `safeTransfer` in `withdraw`. |
| Commitment replay | `address(this)` + `chainid` + `auctionId` + `bidder` in hash preimage. |
| Bond loop gas | `finalize` loops over `committers`. This is bounded by the number of bidders. Very large numbers of bidders could exhaust the block gas limit. In v1, this is accepted. A future mitigation is lazy bond claims. |
| USDC blacklist | A blacklisted winner or buyer cannot block `finalize` because transfers are pull-based. However, a blacklisted address cannot call `withdraw` successfully — their balance remains claimable until the restriction lifts. Documented known limitation. |
| No admin | No owner role. No address can extract funds except through the defined state machine and `withdraw`. |
| Shared USDC custody | Same limitation as TaskEscrow: a contract-level USDC freeze would lock all auction funds. |
| `approve` + `createTask` | `BlindRelayAuction` approves exactly `bestPrice` to the escrow, then calls `createTask`. The escrow pulls exactly `bestPrice` in the same call. No dangling approval left after the call (the escrow's `safeTransferFrom` consumes the full approved amount). If `createTask` reverts, the entire `finalize` reverts (CEI status flip already happened — wait, no: the status flip is BEFORE the external call intentionally to block reentrancy, so a revert in `createTask` would roll back the entire tx including the status flip). This is safe. |
| Buyer-bidder separation | `commitBid` reverts if `msg.sender == auction.buyer`. |

---

## 14. Constructor Arguments

```solidity
constructor(address usdc_, address escrow_)
```
- `usdc_` — USDC token address; Arc Testnet: `0x3600000000000000000000000000000000000000`
- `escrow_` — deployed TaskEscrow address; Arc Testnet: `0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d`
- Both guarded with `ZeroAddress()` check.

---

## 15. Interaction With TaskEscrow

`BlindRelayAuction` calls:
```solidity
IERC20(usdc).approve(escrow, bestPrice);
uint256 taskId = ITaskEscrow(escrow).createTask(
    auction.buyer,           // named buyer on the task
    auction.bestBidder,      // provider
    auction.bestPrice,       // price
    uint64(block.timestamp) + auction.deliveryDuration,
    auction.reviewWindow
);
```

The `buyer` parameter in `createTask` is `auction.buyer` (the original funder of the auction) — not `address(this)`. This means the buyer retains full rights on the task (accept/reject/reclaim) directly. The auction contract is the USDC funder (`msg.sender` in `createTask`) but not the buyer.

`BlindRelayAuction` needs `IERC20(usdc).approve(escrow, bestPrice)` before the call because `createTask` does `safeTransferFrom(msg.sender, ...)` and `msg.sender` from TaskEscrow's perspective is `address(BlindRelayAuction)`.

---

## 16. Known Limitations (v1)

1. **USDC blacklist**: a blacklisted recipient cannot withdraw; funds remain claimable if restriction lifts.
2. **Finalize gas**: bond distribution loop is O(committers). Very large auctions could hit block gas limit.
3. **No dispute resolution on resulting task**: inherited from TaskEscrow v1.
4. **No auction cancellation by buyer**: once created, the auction runs to completion. A buyer who posts the wrong budget has no early exit.
5. **No re-auction**: if the resulting task is disputed or reclaimed, a new auction must be created manually.
