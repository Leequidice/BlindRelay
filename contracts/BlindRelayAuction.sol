// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITaskEscrow {
    function createTask(
        address buyer,
        address provider,
        uint256 price,
        uint64 deadline,
        uint64 reviewWindow
    ) external returns (uint256 taskId);
}

/// @title BlindRelayAuction
/// @notice Sealed-bid reverse auction that relays the winning bid into TaskEscrow without any admin role.
/// @dev Buyers deposit a USDC budget, bidders post sealed commitments backed by bonds, then reveal in a reveal phase.
///      Finalization selects the lowest-price valid revealer (tie-break: earlier commit), creates the escrow task,
///      and accounts all refunds/forfeitures through pull-payments (`pendingBalances` + `withdraw`).
///      Known limitation: if a recipient is USDC-blacklisted, `withdraw` reverts for that recipient until delisted,
///      and funds remain pending in this contract. Finalization loops over `committers` and is O(committers).
///      This contract has no owner/admin and no payable entrypoints/fallbacks.
contract BlindRelayAuction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum AuctionStatus {
        Active,
        Finalized,
        Cancelled
    }

    struct Auction {
        address buyer;
        uint256 budget;
        uint256 bondAmount;
        uint256 bestPrice;
        address bestBidder;
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 deliveryDuration;
        uint64 reviewWindow;
        bytes32 taskHash;
        AuctionStatus status;
        uint32 commitCounter;
        address[] committers;
        mapping(address => bytes32) commitments;
        mapping(address => uint32) commitOrder;
        mapping(address => bool) hasRevealed;
    }

    uint256 public auctionCount;
    mapping(uint256 => Auction) public auctions;
    mapping(address => uint256) public pendingBalances;
    address public immutable usdc;
    address public immutable escrow;

    uint64 public constant MIN_DURATION          = 60;           // 60 s minimum commit/reveal phase
    uint64 public constant MAX_DURATION          = 7 days;       // 604 800 s maximum commit/reveal phase
    uint32 public constant MAX_BIDDERS           = 100;          // bounds the O(n) finalize loop
    uint64 public constant MIN_DELIVERY_DURATION = 60;           // mirrors TaskEscrow: deadline must be > now
    uint64 public constant MAX_DELIVERY_DURATION = 365 days;     // mirrors TaskEscrow.MAX_DEADLINE_HORIZON
    uint64 public constant MIN_REVIEW_WINDOW     = 1;            // mirrors TaskEscrow: reviewWindow > 0
    uint64 public constant MAX_REVIEW_WINDOW     = 30 days;      // mirrors TaskEscrow.MAX_REVIEW_WINDOW

    /// @notice Minimum gas that must remain at the point immediately before the
    ///         `forceApprove` + `try ITaskEscrow(escrow).createTask(...)` call in `finalize`.
    /// @dev The guard fires AFTER `a.status = Finalized` (and after the nonReentrant lock
    ///      is held), so the auction is already in a non-Active state when the check runs.
    ///      A revert here rolls back the status write, leaving the auction Active and
    ///      retryable with sufficient gas.
    ///
    ///      Sizing — components that must fit inside the remaining gas budget:
    ///
    ///        (A) Inner call via EIP-150 / 63/64:
    ///              TaskEscrow.createTask cost (USDC transferFrom + storage): ~150 000 gas
    ///              Required in outer frame to guarantee inner gets enough:
    ///                ceil(150 000 × 64/63) ≈ 152 381 gas
    ///
    ///        (B) Catch path (runs in outer frame after the try returns):
    ///              forceApprove(escrow, 0)      ~10 000 gas
    ///              a.status = Cancelled          ~5 000 gas
    ///              budget credit                 ~5 000 gas
    ///              bond loop (100 bidders×~5k)  ~500 000 gas
    ///              AuctionCancelled event         ~3 000 gas
    ///              Total:                        ~523 000 gas
    ///
    ///        (C) Success path (outer frame, similar cost):
    ///              forceApprove(escrow, 0) + surplus credit + bond loop + event ≈ 520 000 gas
    ///
    ///        (D) Overhead (guard check, storage reads, return path): ~25 000 gas
    ///
    ///        Floor = max(B, C) + A + D = 523 000 + 153 000 + 25 000 = 701 000
    ///        Rounded up to 800 000 for a ≥14 % safety margin.
    ///
    ///      With GAS_FLOOR = 800 000 gas remaining at the guard:
    ///        - The outer frame has 800 000 gas for all post-try work (≫ 523 000).
    ///        - createTask is forwarded at most 800 000 × 63/64 ≈ 787 500 gas (≫ 150 000).
    ///        - An OOG inside createTask is therefore impossible when this guard passes.
    ///        - The catch block is only reachable on an authentic revert from createTask.
    uint256 public constant GAS_FLOOR = 800_000;

    /// @dev Reverts when `finalize` is called with less gas than GAS_FLOOR.
    error InsufficientGasForFinalize();

    error ZeroAddress();
    error NotAContract();
    error ZeroBudget();
    error ZeroBond();
    error DeliveryDurationTooShort();   // deliveryDuration < MIN_DELIVERY_DURATION
    error DeliveryDurationTooLong();    // deliveryDuration > MAX_DELIVERY_DURATION
    error ReviewWindowTooShort();       // reviewWindow < MIN_REVIEW_WINDOW
    error ReviewWindowTooLong();        // reviewWindow > MAX_REVIEW_WINDOW
    error DurationOutOfRange();
    error NotActive();
    error NotCommitPhase();
    error NotRevealPhase();
    error RevealNotEnded();
    error BuyerCannotBid();
    error AlreadyCommitted();
    error TooManyBidders();
    error AlreadyRevealed();
    error NotCommitted();
    error InvalidReveal();
    error ZeroBidPrice();
    error PriceTooHigh();
    error NothingToWithdraw();

    /// @dev All fields needed to reconstruct full auction state from logs alone.
    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed buyer,
        uint256 budget,
        uint256 bondAmount,
        uint64 commitEnd,
        uint64 revealEnd,
        uint64 deliveryDuration,
        uint64 reviewWindow,
        bytes32 taskHash
    );
    /// @dev commitOrder is 1-based; the log order of BidCommitted events also encodes arrival order.
    event BidCommitted(uint256 indexed auctionId, address indexed bidder, uint32 commitOrder);
    /// @dev price is the revealed bid price; combine with BidCommitted to know order and price per bidder.
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 price);
    /// @dev Emitted when createTask succeeded. taskId links to the TaskEscrow task.
    event AuctionFinalized(uint256 indexed auctionId, address indexed winner, uint256 price, uint256 taskId);
    /// @dev Emitted on no-reveal cancel or on createTask fallback. reason: 0=no reveal, 1=createTask failed.
    event AuctionCancelled(uint256 indexed auctionId, uint8 reason);
    event Withdrawn(address indexed recipient, uint256 amount);

    constructor(address usdc_, address escrow_) {
        if (usdc_ == address(0) || escrow_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert NotAContract();
        if (escrow_.code.length == 0) revert NotAContract();
        usdc = usdc_;
        escrow = escrow_;
    }

    /// @notice Creates a new blind reverse auction funded by `msg.sender`.
    /// @dev The auction buyer is always `msg.sender`. USDC budget is pulled from `msg.sender` into this contract.
    ///      On finalize, the resulting TaskEscrow task uses this same address as the named task buyer.
    function createAuction(
        uint256 budget,
        uint64 commitDuration,
        uint64 revealDuration,
        uint256 bondAmount,
        uint64 deliveryDuration,
        uint64 reviewWindow,
        bytes32 taskHash
    ) external nonReentrant returns (uint256 auctionId) {
        if (budget == 0) revert ZeroBudget();
        if (bondAmount == 0) revert ZeroBond();
        if (commitDuration < MIN_DURATION || commitDuration > MAX_DURATION) revert DurationOutOfRange();
        if (revealDuration < MIN_DURATION || revealDuration > MAX_DURATION) revert DurationOutOfRange();
        // Mirror every bound TaskEscrow.createTask will later enforce so finalize never reverts.
        // deliveryDuration maps to: deadline = block.timestamp + deliveryDuration, so it must be > 0 (> now) and
        // <= MAX_DEADLINE_HORIZON.  reviewWindow must be in [MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW].
        if (deliveryDuration < MIN_DELIVERY_DURATION) revert DeliveryDurationTooShort();
        if (deliveryDuration > MAX_DELIVERY_DURATION) revert DeliveryDurationTooLong();
        if (reviewWindow < MIN_REVIEW_WINDOW) revert ReviewWindowTooShort();
        if (reviewWindow > MAX_REVIEW_WINDOW) revert ReviewWindowTooLong();

        auctionId = auctionCount;

        Auction storage a = auctions[auctionId];
        a.buyer = msg.sender;
        a.budget = budget;
        a.bondAmount = bondAmount;
        a.bestPrice = 0;
        a.bestBidder = address(0);
        a.commitEnd = uint64(block.timestamp) + commitDuration;
        a.revealEnd = a.commitEnd + revealDuration;
        a.deliveryDuration = deliveryDuration;
        a.reviewWindow = reviewWindow;
        a.taskHash = taskHash;
        a.status = AuctionStatus.Active;
        a.commitCounter = 0;

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), budget);

        emit AuctionCreated(auctionId, msg.sender, budget, bondAmount, a.commitEnd, a.revealEnd, deliveryDuration, reviewWindow, taskHash);

        unchecked {
            auctionCount = auctionId + 1;
        }
    }

    /// @notice Commits a sealed bid hash and posts the fixed bond.
    /// @dev Commitment must be computed as:
    ///      keccak256(abi.encode(address(this), block.chainid, auctionId, bidder, price, salt)).
    function commitBid(uint256 auctionId, bytes32 commitment) external nonReentrant {
        Auction storage a = auctions[auctionId];

        if (a.status != AuctionStatus.Active) revert NotActive();
        if (block.timestamp >= a.commitEnd) revert NotCommitPhase();
        if (msg.sender == a.buyer) revert BuyerCannotBid();
        if (a.commitOrder[msg.sender] != 0) revert AlreadyCommitted();
        if (a.committers.length >= MAX_BIDDERS) revert TooManyBidders();

        unchecked {
            a.commitCounter++;
        }

        a.commitments[msg.sender] = commitment;
        a.commitOrder[msg.sender] = a.commitCounter;
        a.committers.push(msg.sender);

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), a.bondAmount);

        emit BidCommitted(auctionId, msg.sender, a.commitOrder[msg.sender]);
    }

    function revealBid(uint256 auctionId, uint256 price, bytes32 salt) external {
        Auction storage a = auctions[auctionId];

        if (a.status != AuctionStatus.Active) revert NotActive();
        if (block.timestamp < a.commitEnd || block.timestamp >= a.revealEnd) revert NotRevealPhase();
        if (a.commitOrder[msg.sender] == 0) revert NotCommitted();
        if (a.hasRevealed[msg.sender]) revert AlreadyRevealed();
        if (price == 0) revert ZeroBidPrice();
        if (price > a.budget) revert PriceTooHigh();

        bytes32 expected = keccak256(abi.encode(address(this), block.chainid, auctionId, msg.sender, price, salt));
        if (expected != a.commitments[msg.sender]) revert InvalidReveal();

        a.hasRevealed[msg.sender] = true;

        if (
            a.bestBidder == address(0)
                || price < a.bestPrice
                || (price == a.bestPrice && a.commitOrder[msg.sender] < a.commitOrder[a.bestBidder])
        ) {
            a.bestPrice = price;
            a.bestBidder = msg.sender;
        }

        emit BidRevealed(auctionId, msg.sender, price);
    }

    /// @notice Finalizes an auction after reveal phase end.
    /// @dev CEI: auction status is set to Finalized BEFORE any external call or pendingBalance write.
    ///      Winner path: approve escrow for bestPrice, call TaskEscrow.createTask via try/catch.
    ///      If createTask fails for any reason, the auction falls back to Cancelled: full budget returns to buyer,
    ///      every revealer gets their bond back, non-revealers still forfeit to buyer.
    ///      The resulting task buyer is `auction.buyer` (not `address(this)`).
    ///
    ///      Gas guard: immediately before the forceApprove+try block, `gasleft()` is compared
    ///      to GAS_FLOOR.  The guard fires AFTER `a.status = Finalized` so a failed check is
    ///      rolled back and the auction remains Active, retryable with sufficient gas.
    ///      See the GAS_FLOOR constant for the sizing rationale.  When the guard passes the
    ///      catch block is only reachable on an authentic revert from createTask, never on OOG.
    ///
    ///      Allowance safety: forceApprove is called to set the escrow allowance to bestPrice
    ///      before the try block and reset to 0 in both branches.  If either forceApprove
    ///      reverts (e.g. USDC blacklist on this contract), finalize reverts; funds remain
    ///      intact and the auction is retryable.
    ///
    /// @dev Known limitation: if the winner or buyer is USDC-blacklisted, `withdraw` reverts for them
    ///      until the restriction is lifted; their pendingBalances remain intact.
    function finalize(uint256 auctionId) external nonReentrant {
        Auction storage a = auctions[auctionId];

        if (a.status != AuctionStatus.Active) revert NotActive();
        if (block.timestamp < a.revealEnd) revert RevealNotEnded();

        if (a.bestBidder != address(0)) {
            // CEI: set terminal status BEFORE the external call so any reentrant read sees a non-Active auction.
            // The catch block overrides to Cancelled if createTask reverts.
            a.status = AuctionStatus.Finalized;

            // Gas guard: fires here — after the status write, before the external call.
            // gasleft() now measures gas actually available at the call site.
            // A revert here is rolled back (including the status write), leaving the auction
            // Active so the caller can retry with sufficient gas.
            // See GAS_FLOOR for the sizing derivation (catch-path cost + 63/64 createTask overhead).
            if (gasleft() < GAS_FLOOR) revert InsufficientGasForFinalize();

            // Attempt winner path — try/catch so a createTask failure does not brick the auction.
            IERC20(usdc).forceApprove(escrow, a.bestPrice);

            try ITaskEscrow(escrow).createTask(
                a.buyer,
                a.bestBidder,
                a.bestPrice,
                uint64(block.timestamp) + a.deliveryDuration,
                a.reviewWindow
            ) returns (uint256 taskId) {
                // createTask succeeded: status already Finalized above.

                // Reset allowance to zero.  createTask consumed bestPrice via transferFrom, so
                // this is a safety reset to ensure no residual allowance lingers.
                // If forceApprove reverts here, finalize reverts; the task was already created
                // so the escrow task exists but the auction stays Finalized (re-entry blocked).
                IERC20(usdc).forceApprove(escrow, 0);

                // Credit buyer with any budget surplus.
                pendingBalances[a.buyer] += (a.budget - a.bestPrice);

                // Distribute bonds: revealers get bond back, non-revealers forfeit to buyer.
                uint256 len = a.committers.length;
                for (uint256 i = 0; i < len;) {
                    address bidder = a.committers[i];
                    if (a.hasRevealed[bidder]) {
                        pendingBalances[bidder] += a.bondAmount;
                    } else {
                        pendingBalances[a.buyer] += a.bondAmount;
                    }
                    unchecked { ++i; }
                }

                emit AuctionFinalized(auctionId, a.bestBidder, a.bestPrice, taskId);

            } catch {
                // createTask failed (genuine revert — OOG is ruled out by the gas guard above).
                // Reset any residual allowance before mutating state.
                // If forceApprove reverts in the catch path, finalize reverts; the auction
                // status is still Finalized (set above) but all pendingBalances writes are
                // rolled back, so no funds are double-credited.  The caller can retry.
                IERC20(usdc).forceApprove(escrow, 0);

                // Override status to Cancelled.
                a.status = AuctionStatus.Cancelled;

                // Return full budget to buyer.
                pendingBalances[a.buyer] += a.budget;

                // Distribute bonds: revealers get bond back, non-revealers forfeit to buyer.
                uint256 len = a.committers.length;
                for (uint256 i = 0; i < len;) {
                    address bidder = a.committers[i];
                    if (a.hasRevealed[bidder]) {
                        pendingBalances[bidder] += a.bondAmount;
                    } else {
                        pendingBalances[a.buyer] += a.bondAmount;
                    }
                    unchecked { ++i; }
                }

                // reason 1 = createTask failed (genuine revert, not OOG)
                emit AuctionCancelled(auctionId, 1);
            }
        } else {
            // No valid reveal: cancel immediately.
            a.status = AuctionStatus.Cancelled;

            pendingBalances[a.buyer] += a.budget;

            uint256 lenNoReveal = a.committers.length;
            for (uint256 i = 0; i < lenNoReveal;) {
                pendingBalances[a.buyer] += a.bondAmount;
                unchecked { ++i; }
            }

            // reason 0 = no valid reveal
            emit AuctionCancelled(auctionId, 0);
        }
    }

    /// @notice Withdraws caller's accumulated pull-payment balance in USDC.
    /// @dev Pull-payment pattern avoids pushing refunds/bonds during state transitions.
    ///      If caller is USDC-blacklisted, transfer reverts and amount remains pending until restriction is lifted.
    function withdraw() external nonReentrant {
        uint256 amount = pendingBalances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingBalances[msg.sender] = 0;
        IERC20(usdc).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ─── Read helpers ──────────────────────────────────────────────────────────

    /// @notice Flat view of an auction's scalar fields (mappings and array omitted — use getBidders/getBid).
    /// @dev Returned as a struct to avoid stack-too-deep on the 13-field tuple.
    struct AuctionView {
        address       buyer;
        uint256       budget;
        uint256       bondAmount;
        uint256       bestPrice;
        address       bestBidder;
        uint64        commitEnd;
        uint64        revealEnd;
        uint64        deliveryDuration;
        uint64        reviewWindow;
        bytes32       taskHash;
        AuctionStatus status;
        uint32        commitCounter;
        uint256       bidderCount;
    }

    /// @notice Returns the scalar fields of an auction as an AuctionView struct.
    function getAuction(uint256 auctionId) external view returns (AuctionView memory v) {
        Auction storage a = auctions[auctionId];
        v.buyer           = a.buyer;
        v.budget          = a.budget;
        v.bondAmount      = a.bondAmount;
        v.bestPrice       = a.bestPrice;
        v.bestBidder      = a.bestBidder;
        v.commitEnd       = a.commitEnd;
        v.revealEnd       = a.revealEnd;
        v.deliveryDuration = a.deliveryDuration;
        v.reviewWindow    = a.reviewWindow;
        v.taskHash        = a.taskHash;
        v.status          = a.status;
        v.commitCounter   = a.commitCounter;
        v.bidderCount     = a.committers.length;
    }

    /// @notice Returns the ordered list of committers for an auction.
    function getBidders(uint256 auctionId) external view returns (address[] memory) {
        return auctions[auctionId].committers;
    }

    /// @notice Returns per-bidder bid state: their commit order (0 if never committed), whether they revealed,
    ///         and their commitment hash.
    function getBid(uint256 auctionId, address bidder)
        external
        view
        returns (uint32 commitOrder, bool hasRevealed, bytes32 commitment)
    {
        Auction storage a = auctions[auctionId];
        return (a.commitOrder[bidder], a.hasRevealed[bidder], a.commitments[bidder]);
    }

    /// @notice Returns the current phase of an auction as a human-readable string.
    /// @dev Phases: "Commit" (before commitEnd), "Reveal" (commitEnd..revealEnd), "Ended" (after revealEnd but Active),
    ///      "Finalized", "Cancelled". Returns "Unknown" for an auction that has never been created (buyer == 0).
    function phaseOf(uint256 auctionId) external view returns (string memory) {
        Auction storage a = auctions[auctionId];
        if (a.buyer == address(0)) return "Unknown";
        if (a.status == AuctionStatus.Finalized) return "Finalized";
        if (a.status == AuctionStatus.Cancelled) return "Cancelled";
        // status == Active
        if (block.timestamp < a.commitEnd) return "Commit";
        if (block.timestamp < a.revealEnd) return "Reveal";
        return "Ended";
    }
}
