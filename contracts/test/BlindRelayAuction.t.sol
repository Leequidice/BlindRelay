// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BlindRelayAuction} from "../BlindRelayAuction.sol";
import {TaskEscrow} from "../TaskEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @title BlindRelayAuctionTest
/// @notice Full Foundry test suite for BlindRelayAuction.
///         Covers happy paths, revert paths, events, fuzz, invariant, and
///         integration with a real TaskEscrow deployment.
contract BlindRelayAuctionTest is Test {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants / fixtures
    // ─────────────────────────────────────────────────────────────────────────

    uint256 internal constant BUDGET           = 1_000e6;  // 1 000 USDC (6 dec)
    uint256 internal constant BOND             = 50e6;     //  50  USDC
    uint64  internal constant COMMIT_DUR       = 1 hours;  // 3 600 s
    uint64  internal constant REVEAL_DUR       = 1 hours;  // 3 600 s
    uint64  internal constant DELIVERY_DUR     = 7 days;
    uint64  internal constant REVIEW_WIN       = 1 days;   // 86 400 s
    bytes32 internal constant TASK_HASH        = keccak256("task description");

    // ─────────────────────────────────────────────────────────────────────────
    // Actors
    // ─────────────────────────────────────────────────────────────────────────

    address internal buyer   = address(0x1);
    address internal bidder1 = address(0x2);
    address internal bidder2 = address(0x3);

    // ─────────────────────────────────────────────────────────────────────────
    // Contracts
    // ─────────────────────────────────────────────────────────────────────────

    MockERC20          internal usdc;
    TaskEscrow         internal escrowContract;
    BlindRelayAuction  internal auction;

    // ─────────────────────────────────────────────────────────────────────────
    // setUp – runs before every test
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        // Deploy mock USDC (6 decimals)
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        // Deploy real TaskEscrow (used for integration)
        escrowContract = new TaskEscrow(address(usdc));

        // Deploy auction under test
        auction = new BlindRelayAuction(address(usdc), address(escrowContract));

        // Mint USDC to actors
        usdc.mint(buyer,   10_000e6);
        usdc.mint(bidder1, 10_000e6);
        usdc.mint(bidder2, 10_000e6);

        // Approve auction contract to pull from all actors
        vm.prank(buyer);
        usdc.approve(address(auction), type(uint256).max);
        vm.prank(bidder1);
        usdc.approve(address(auction), type(uint256).max);
        vm.prank(bidder2);
        usdc.approve(address(auction), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// Create a standard auction from `buyer` and return (auctionId, commitEnd, revealEnd).
    function _createAuction() internal returns (uint256 auctionId, uint64 commitEnd, uint64 revealEnd) {
        vm.prank(buyer);
        auctionId = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH
        );
        commitEnd = uint64(block.timestamp + COMMIT_DUR);
        revealEnd = uint64(block.timestamp + COMMIT_DUR + REVEAL_DUR);
    }

    /// Build a commitment hash exactly as the contract does.
    function _makeCommitment(
        uint256 auctionId,
        address bidder,
        uint256 price,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(address(auction), block.chainid, auctionId, bidder, price, salt));
    }

    /// Commit, warp to reveal phase, reveal — returns auctionId.
    function _commitAndReveal(
        uint256 auctionId,
        address bidder,
        uint256 price,
        bytes32 salt,
        uint64 commitEnd
    ) internal {
        bytes32 commitment = _makeCommitment(auctionId, bidder, price, salt);
        vm.prank(bidder);
        auction.commitBid(auctionId, commitment);
        vm.warp(commitEnd); // enter reveal window
        vm.prank(bidder);
        auction.revealBid(auctionId, price, salt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 1 — HAPPY PATHS
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 1 — Two bidders: lower price wins; surplus + bonds distributed correctly.
    function test_HappyPath_TwoBidders_LowerWins() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt1 = keccak256("salt1");
        bytes32 salt2 = keccak256("salt2");
        uint256 price1 = 800e6;
        uint256 price2 = 700e6;

        // Both bidders commit
        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price1, salt1));
        vm.prank(bidder2);
        auction.commitBid(aid, _makeCommitment(aid, bidder2, price2, salt2));

        // Warp into reveal window
        vm.warp(commitEnd);

        // Both reveal
        vm.prank(bidder1);
        auction.revealBid(aid, price1, salt1);
        vm.prank(bidder2);
        auction.revealBid(aid, price2, salt2);

        // Warp past reveal end, finalize
        vm.warp(revealEnd);
        auction.finalize(aid);

        // bidder2 is the winner (700 < 800)
        assertEq(escrowContract.taskCount(), 1, "taskCount should be 1");

        (
            address tBuyer,
            address tProvider,
            uint256 tPrice,
            ,
            ,
            ,
            TaskEscrow.TaskStatus tStatus,

        ) = escrowContract.tasks(0);

        assertEq(tBuyer,    buyer,   "task buyer");
        assertEq(tProvider, bidder2, "task provider");
        assertEq(tPrice,    700e6,   "task price");
        assertEq(uint256(tStatus), 0, "task status == Funded");

        // buyer pending: budget - winnerPrice + forfeited bonds (none here, both revealed)
        assertEq(auction.pendingBalances(buyer),   BUDGET - price2, "buyer pending");
        assertEq(auction.pendingBalances(bidder1), BOND,            "bidder1 bond back");
        assertEq(auction.pendingBalances(bidder2), BOND,            "bidder2 bond back");
    }

    /// @dev Test 2 — Tie-break: earliest commit wins when prices are equal.
    function test_TieBreak_EarliestCommitWins() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt1 = keccak256("tiesalt1");
        bytes32 salt2 = keccak256("tiesalt2");
        uint256 price  = 600e6;

        // bidder1 commits first, then bidder2
        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt1));
        vm.prank(bidder2);
        auction.commitBid(aid, _makeCommitment(aid, bidder2, price, salt2));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        auction.revealBid(aid, price, salt1);
        vm.prank(bidder2);
        auction.revealBid(aid, price, salt2);

        vm.warp(revealEnd);
        auction.finalize(aid);

        // bidder1 should win (lower commit order)
        (address tBuyer, address tProvider, , , , , , ) = escrowContract.tasks(0);
        assertEq(tBuyer,    buyer,   "task buyer");
        assertEq(tProvider, bidder1, "bidder1 wins tie");
    }

    /// @dev Test 3 — No reveals → Cancelled; buyer gets budget + all bonds.
    function test_NoReveals_FullRefund() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt1 = keccak256("s1");
        bytes32 salt2 = keccak256("s2");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 500e6, salt1));
        vm.prank(bidder2);
        auction.commitBid(aid, _makeCommitment(aid, bidder2, 600e6, salt2));

        // Skip to after reveal phase without revealing
        vm.warp(revealEnd);
        auction.finalize(aid);

        // Status must be Cancelled
        assertEq(uint256(_auctionStatus(aid)), uint256(BlindRelayAuction.AuctionStatus.Cancelled), "status cancelled");

        // buyer gets budget + 2 bonds (both forfeited)
        assertEq(auction.pendingBalances(buyer), BUDGET + BOND + BOND, "buyer gets budget+2bonds");
    }

    /// Helper: return just the AuctionStatus for a given auction.
    function _auctionStatus(uint256 aid) internal view returns (BlindRelayAuction.AuctionStatus status) {
        // The auto-generated getter returns 12 fields; capture only what we need
        // to stay under the stack depth limit.
        (, , , , , , , , , , status, ) = auction.auctions(aid);
    }

    /// Helper: return (commitEnd, revealEnd) for a given auction.
    function _auctionTimings(uint256 aid) internal view returns (uint64 commitEnd, uint64 revealEnd) {
        (, , , , , commitEnd, revealEnd, , , , , ) = auction.auctions(aid);
    }

    /// @dev Test 4 — Non-revealer forfeits bond to buyer.
    function test_NonRevealer_ForfeitsToBuilyer() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt1 = keccak256("rev1");
        bytes32 salt2 = keccak256("norev2");
        uint256 price1 = 500e6;
        uint256 price2 = 600e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price1, salt1));
        vm.prank(bidder2);
        auction.commitBid(aid, _makeCommitment(aid, bidder2, price2, salt2));

        vm.warp(commitEnd);

        // Only bidder1 reveals
        vm.prank(bidder1);
        auction.revealBid(aid, price1, salt1);

        vm.warp(revealEnd);
        auction.finalize(aid);

        // bidder2 did not reveal → bond goes to buyer
        assertEq(auction.pendingBalances(bidder2), 0,    "bidder2 has nothing pending");
        assertEq(
            auction.pendingBalances(buyer),
            (BUDGET - price1) + BOND, // surplus + forfeited bond2
            "buyer gets surplus + forfeited bond"
        );
        // bidder1 gets bond back
        assertEq(auction.pendingBalances(bidder1), BOND, "bidder1 bond returned");
    }

    /// @dev Test 5 — Winner bids less than budget → buyer pending == budget - winnerPrice.
    function test_SurplusRefund_BuyerGetsDifference() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt = keccak256("surplus_salt");
        uint256 winPrice = 300e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, winPrice, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, winPrice, salt);

        vm.warp(revealEnd);
        auction.finalize(aid);

        assertEq(auction.pendingBalances(buyer), BUDGET - winPrice, "buyer gets surplus");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 2 — COMMITMENT / REVEAL SECURITY
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 6 — Copying bidder1's commitment bytes fails for bidder2 on reveal.
    function test_CopiedCommitment_FailsOnReveal() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        uint256 price = 500e6;
        bytes32 salt  = keccak256("copysalt");

        // bidder1 commits legitimately
        bytes32 legit = _makeCommitment(aid, bidder1, price, salt);
        vm.prank(bidder1);
        auction.commitBid(aid, legit);

        // bidder2 copies EXACTLY the same commitment bytes
        vm.prank(bidder2);
        auction.commitBid(aid, legit); // different address, same bytes

        vm.warp(commitEnd);

        // bidder2 tries to reveal using bidder1's price+salt — hash won't match because
        // the contract hashes with msg.sender == bidder2
        vm.prank(bidder2);
        vm.expectRevert(BlindRelayAuction.InvalidReveal.selector);
        auction.revealBid(aid, price, salt);
    }

    /// @dev Test 7 — Wrong price in reveal → InvalidReveal.
    function test_WrongPriceInReveal() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        uint256 realPrice  = 500e6;
        uint256 wrongPrice = 600e6;
        bytes32 salt       = keccak256("wrprice");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, realPrice, salt));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.InvalidReveal.selector);
        auction.revealBid(aid, wrongPrice, salt);
    }

    /// @dev Test 8 — Wrong salt in reveal → InvalidReveal.
    function test_WrongSaltInReveal() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        uint256 price     = 500e6;
        bytes32 realSalt  = keccak256("realsalt");
        bytes32 wrongSalt = keccak256("wrongsalt");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, realSalt));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.InvalidReveal.selector);
        auction.revealBid(aid, price, wrongSalt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 3 — PHASE TIMING
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 9 — Reveal before commit end → NotRevealPhase.
    function test_RevealBeforeCommitEnd() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        bytes32 salt  = keccak256("earlyrev");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        // Still inside commit window (commitEnd - 1)
        vm.warp(commitEnd - 1);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.NotRevealPhase.selector);
        auction.revealBid(aid, price, salt);
    }

    /// @dev Test 10 — Reveal at or after revealEnd → NotRevealPhase.
    function test_RevealAfterRevealEnd() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt  = keccak256("laterev");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        // Warp to exactly revealEnd (>= revealEnd means out of window)
        vm.warp(revealEnd);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.NotRevealPhase.selector);
        auction.revealBid(aid, price, salt);
    }

    /// @dev Test 11 — Commit after commit end → NotCommitPhase.
    function test_CommitAfterCommitEnd() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        vm.warp(commitEnd);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.NotCommitPhase.selector);
        auction.commitBid(aid, keccak256("late"));
    }

    /// @dev Test 12 — Finalize before reveal end → RevealNotEnded.
    function test_FinalizeBeforeRevealEnd() public {
        (uint256 aid, , ) = _createAuction();

        vm.expectRevert(BlindRelayAuction.RevealNotEnded.selector);
        auction.finalize(aid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 4 — DOUBLE OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 13 — Same bidder commits twice → AlreadyCommitted.
    function test_DoubleCommit() public {
        (uint256 aid, , ) = _createAuction();

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 500e6, keccak256("dc1")));

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.AlreadyCommitted.selector);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 400e6, keccak256("dc2")));
    }

    /// @dev Test 14 — Same bidder reveals twice → AlreadyRevealed.
    function test_DoubleReveal() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        bytes32 salt  = keccak256("dr_salt");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.AlreadyRevealed.selector);
        auction.revealBid(aid, price, salt);
    }

    /// @dev Test 15 — Finalize twice → NotActive (status is Finalized after first call).
    function test_DoubleFinalize() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt  = keccak256("df_salt");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);

        vm.warp(revealEnd);
        auction.finalize(aid);

        vm.expectRevert(BlindRelayAuction.NotActive.selector);
        auction.finalize(aid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 5 — ACCESS CONTROL
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 16 — Buyer tries to commit → BuyerCannotBid.
    function test_BuyerCannotBid() public {
        (uint256 aid, , ) = _createAuction();

        vm.prank(buyer);
        vm.expectRevert(BlindRelayAuction.BuyerCannotBid.selector);
        auction.commitBid(aid, keccak256("buyer_bid"));
    }

    /// @dev Test 17 — Reveal with price above budget → PriceTooHigh.
    function test_WrongPriceRange_PriceAboveBudget() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        uint256 highPrice = BUDGET + 1;
        bytes32 salt      = keccak256("high");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, highPrice, salt));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.PriceTooHigh.selector);
        auction.revealBid(aid, highPrice, salt);
    }

    /// @dev Test 18 — Reveal with price == 0 → ZeroBidPrice.
    function test_WrongPriceRange_PriceZero() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        bytes32 salt = keccak256("zero");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 0, salt));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.ZeroBidPrice.selector);
        auction.revealBid(aid, 0, salt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 6 — CREATEAUCTION VALIDATION
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    function _createAuctionWith(
        uint256 budget,
        uint64  commitDuration,
        uint64  revealDuration,
        uint256 bondAmount,
        uint64  deliveryDuration,
        uint64  reviewWindow
    ) internal {
        vm.prank(buyer);
        auction.createAuction(budget, commitDuration, revealDuration, bondAmount, deliveryDuration, reviewWindow, TASK_HASH);
    }

    /// @dev Test 19
    function test_ZeroBudget() public {
        vm.expectRevert(BlindRelayAuction.ZeroBudget.selector);
        _createAuctionWith(0, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN);
    }

    /// @dev Test 20
    function test_ZeroBond() public {
        vm.expectRevert(BlindRelayAuction.ZeroBond.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, REVEAL_DUR, 0, DELIVERY_DUR, REVIEW_WIN);
    }

    /// @dev Test 21 — commitDuration = 59 (< MIN_DURATION=60) → DurationOutOfRange.
    function test_CommitDurationTooShort() public {
        vm.expectRevert(BlindRelayAuction.DurationOutOfRange.selector);
        _createAuctionWith(BUDGET, 59, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN);
    }

    /// @dev Test 22 — commitDuration = 7 days + 1 → DurationOutOfRange.
    function test_CommitDurationTooLong() public {
        vm.expectRevert(BlindRelayAuction.DurationOutOfRange.selector);
        _createAuctionWith(BUDGET, uint64(7 days) + 1, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN);
    }

    /// @dev Test 23 — revealDuration = 59 → DurationOutOfRange.
    function test_RevealDurationTooShort() public {
        vm.expectRevert(BlindRelayAuction.DurationOutOfRange.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, 59, BOND, DELIVERY_DUR, REVIEW_WIN);
    }

    /// @dev Test 24 — revealDuration = 7 days + 1 → DurationOutOfRange.
    function test_RevealDurationTooLong() public {
        vm.expectRevert(BlindRelayAuction.DurationOutOfRange.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, uint64(7 days) + 1, BOND, DELIVERY_DUR, REVIEW_WIN);
    }

    /// @dev Test 25 — reviewWindow == 0 → ReviewWindowTooShort.
    function test_ZeroReviewWindow() public {
        vm.expectRevert(BlindRelayAuction.ReviewWindowTooShort.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, 0);
    }

    /// @dev Test 26 — deliveryDuration > 365 days → DeliveryDurationTooLong.
    function test_DeliveryDurationTooLong() public {
        vm.expectRevert(BlindRelayAuction.DeliveryDurationTooLong.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, uint64(365 days) + 1, REVIEW_WIN);
    }

    /// @dev Test 27 — reviewWindow > 30 days → ReviewWindowTooLong.
    function test_ReviewWindowTooLong() public {
        vm.expectRevert(BlindRelayAuction.ReviewWindowTooLong.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, uint64(30 days) + 1);
    }

    /// @dev Test — deliveryDuration == MIN_DELIVERY_DURATION (60) → succeeds.
    function test_ValidParams_AtMinDeliveryDuration() public {
        // Read the constant BEFORE vm.prank to avoid consuming the prank on the view call.
        uint64 minDelivery = auction.MIN_DELIVERY_DURATION(); // 60
        vm.prank(buyer);
        uint256 aid = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND,
            minDelivery,
            REVIEW_WIN,
            TASK_HASH
        );
        assertEq(aid, 0, "auction created");
    }

    /// @dev Test — deliveryDuration == MAX_DELIVERY_DURATION (365 days) → succeeds.
    function test_ValidParams_AtMaxDeliveryDuration() public {
        uint64 maxDelivery = auction.MAX_DELIVERY_DURATION(); // 365 days
        vm.prank(buyer);
        uint256 aid = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND,
            maxDelivery,
            REVIEW_WIN,
            TASK_HASH
        );
        assertEq(aid, 0, "auction created");
    }

    /// @dev Test — reviewWindow == MIN_REVIEW_WINDOW (1) → succeeds.
    function test_ValidParams_AtMinReviewWindow() public {
        uint64 minReview = auction.MIN_REVIEW_WINDOW(); // 1
        vm.prank(buyer);
        uint256 aid = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND,
            DELIVERY_DUR,
            minReview,
            TASK_HASH
        );
        assertEq(aid, 0, "auction created");
    }

    /// @dev Test — reviewWindow == MAX_REVIEW_WINDOW (30 days) → succeeds.
    function test_ValidParams_AtMaxReviewWindow() public {
        uint64 maxReview = auction.MAX_REVIEW_WINDOW(); // 30 days
        vm.prank(buyer);
        uint256 aid = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND,
            DELIVERY_DUR,
            maxReview,
            TASK_HASH
        );
        assertEq(aid, 0, "auction created");
    }

    /// @dev Test — deliveryDuration == 59 (< MIN_DELIVERY_DURATION) → DeliveryDurationTooShort.
    function test_DeliveryDurationTooShort() public {
        vm.expectRevert(BlindRelayAuction.DeliveryDurationTooShort.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, 59, REVIEW_WIN);
    }

    /// @dev Test — reviewWindow == 0 (< MIN_REVIEW_WINDOW) → ReviewWindowTooShort.
    function test_ReviewWindowTooShort() public {
        vm.expectRevert(BlindRelayAuction.ReviewWindowTooShort.selector);
        _createAuctionWith(BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, 0);
    }

    /// @dev Test — full happy path at minimum bounds: deliveryDuration=60, reviewWindow=1.
    ///      Proves the auction can be created AND finalized without TaskEscrow reverting.
    function test_FinalizeSuceeds_AtMinBounds() public {
        // With COMMIT_DUR=1h and REVEAL_DUR=1h, revealEnd = block.timestamp + 7200.
        // At finalize time (block.timestamp == revealEnd), deadline = revealEnd + deliveryDuration.
        // TaskEscrow requires deadline > block.timestamp, so any deliveryDuration >= 1 works.
        // 60 satisfies that easily.
        // Read constants BEFORE vm.prank to avoid consuming the prank on the view calls.
        uint64 minDelivery = auction.MIN_DELIVERY_DURATION(); // 60
        uint64 minReview   = auction.MIN_REVIEW_WINDOW();     // 1

        vm.prank(buyer);
        uint256 aid = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND,
            minDelivery,
            minReview,
            TASK_HASH
        );

        uint64 commitEnd = uint64(block.timestamp + COMMIT_DUR);
        uint64 revealEnd = uint64(block.timestamp + COMMIT_DUR + REVEAL_DUR);

        bytes32 salt  = keccak256("min_bounds_salt");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);

        vm.warp(revealEnd);
        auction.finalize(aid);

        // Assert Finalized status
        (, , , , , , , , , , BlindRelayAuction.AuctionStatus status, ) = auction.auctions(aid);
        assertEq(uint256(status), uint256(BlindRelayAuction.AuctionStatus.Finalized), "status == Finalized");

        // Task was created in escrow
        assertEq(escrowContract.taskCount(), 1, "task created in escrow");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 7 — CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 28
    function test_Constructor_ZeroUsdcReverts() public {
        vm.expectRevert(BlindRelayAuction.ZeroAddress.selector);
        new BlindRelayAuction(address(0), address(escrowContract));
    }

    /// @dev Test 29
    function test_Constructor_ZeroEscrowReverts() public {
        vm.expectRevert(BlindRelayAuction.ZeroAddress.selector);
        new BlindRelayAuction(address(usdc), address(0));
    }

    /// @dev Test 30 — EOA address for USDC → NotAContract.
    function test_Constructor_NonContractUsdcReverts() public {
        address eoa = makeAddr("eoa_usdc");
        vm.expectRevert(BlindRelayAuction.NotAContract.selector);
        new BlindRelayAuction(eoa, address(escrowContract));
    }

    /// @dev Test 31 — EOA address for escrow → NotAContract.
    function test_Constructor_NonContractEscrowReverts() public {
        address eoa = makeAddr("eoa_escrow");
        vm.expectRevert(BlindRelayAuction.NotAContract.selector);
        new BlindRelayAuction(address(usdc), eoa);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 8 — INTEGRATION WITH TASKESCROW
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 32 — After finalize, TaskEscrow.tasks(0) has correct fields.
    function test_Integration_WinningTask_InTaskEscrow() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        uint256 winPrice = 600e6;
        bytes32 salt     = keccak256("integ_salt");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, winPrice, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, winPrice, salt);

        vm.warp(revealEnd);
        auction.finalize(aid);

        // Read task from escrow
        (
            address tBuyer,
            address tProvider,
            uint256 tPrice,
            ,
            ,
            ,
            TaskEscrow.TaskStatus tStatus,

        ) = escrowContract.tasks(0);

        assertEq(tBuyer,    buyer,    "task buyer");
        assertEq(tProvider, bidder1,  "task provider");
        assertEq(tPrice,    winPrice, "task price");
        assertEq(uint256(tStatus), 0, "status == Funded(0)");
    }

    /// @dev Test 33 — TaskEscrow.taskCount() == 1 after finalize.
    function test_Integration_TaskEscrow_TaskCount() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt = keccak256("tc_salt");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 500e6, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, 500e6, salt);

        vm.warp(revealEnd);
        auction.finalize(aid);

        assertEq(escrowContract.taskCount(), 1, "taskCount == 1");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 9 — PULL PAYMENTS (withdraw)
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Shared helper: run a full auction with bidder1 winning at 500e6.
    function _runFullAuction() internal returns (uint256 aid) {
        uint64 commitEnd;
        uint64 revealEnd;
        (aid, commitEnd, revealEnd) = _createAuction();

        bytes32 salt = keccak256("full_salt");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);

        vm.warp(revealEnd);
        auction.finalize(aid);
    }

    /// @dev Test 34 — Winner withdraws bond successfully.
    function test_Withdraw_WinnerBondReturned() public {
        _runFullAuction();

        uint256 balBefore = usdc.balanceOf(bidder1);
        vm.prank(bidder1);
        auction.withdraw();
        uint256 balAfter = usdc.balanceOf(bidder1);

        assertEq(balAfter - balBefore, BOND, "bidder1 receives bond");
        assertEq(auction.pendingBalances(bidder1), 0, "pending cleared");
    }

    /// @dev Test 35 — Buyer withdraws surplus.
    function test_Withdraw_BuyerSurplusReturned() public {
        _runFullAuction();

        uint256 expectedSurplus = BUDGET - 500e6;
        uint256 balBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        auction.withdraw();
        uint256 balAfter = usdc.balanceOf(buyer);

        assertEq(balAfter - balBefore, expectedSurplus, "buyer receives surplus");
    }

    /// @dev Test 36 — Second withdraw call → NothingToWithdraw.
    function test_Withdraw_NothingToWithdraw() public {
        _runFullAuction();

        vm.prank(bidder1);
        auction.withdraw(); // first withdraw succeeds

        vm.prank(bidder1);
        vm.expectRevert(BlindRelayAuction.NothingToWithdraw.selector);
        auction.withdraw(); // second must revert
    }

    /// @dev Test 37 — Non-revealer has 0 pending → NothingToWithdraw.
    function test_Withdraw_ForfeitorCannotWithdraw() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt1 = keccak256("fw_salt1");
        bytes32 salt2 = keccak256("fw_salt2");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 500e6, salt1));
        vm.prank(bidder2);
        auction.commitBid(aid, _makeCommitment(aid, bidder2, 600e6, salt2));

        vm.warp(commitEnd);
        // Only bidder1 reveals; bidder2 does not
        vm.prank(bidder1);
        auction.revealBid(aid, 500e6, salt1);

        vm.warp(revealEnd);
        auction.finalize(aid);

        // bidder2 forfeited bond → 0 pending
        vm.prank(bidder2);
        vm.expectRevert(BlindRelayAuction.NothingToWithdraw.selector);
        auction.withdraw();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 10 — EVENTS
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 38 — AuctionCreated event.
    function test_Event_AuctionCreated() public {
        uint64 expectedCommitEnd = uint64(block.timestamp + COMMIT_DUR);
        uint64 expectedRevealEnd = uint64(block.timestamp + COMMIT_DUR + REVEAL_DUR);

        vm.prank(buyer);
        vm.expectEmit(true, true, true, true, address(auction));
        emit BlindRelayAuction.AuctionCreated(
            0,
            buyer,
            BUDGET,
            BOND,
            expectedCommitEnd,
            expectedRevealEnd,
            DELIVERY_DUR,
            REVIEW_WIN,
            TASK_HASH
        );
        auction.createAuction(BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH);
    }

    /// @dev Test 39 — BidCommitted event.
    function test_Event_BidCommitted() public {
        (uint256 aid, , ) = _createAuction();
        bytes32 commitment = _makeCommitment(aid, bidder1, 500e6, keccak256("ev_commit"));

        vm.prank(bidder1);
        vm.expectEmit(true, true, false, true, address(auction));
        emit BlindRelayAuction.BidCommitted(aid, bidder1, 1); // commitOrder starts at 1
        auction.commitBid(aid, commitment);
    }

    /// @dev Test 40 — BidRevealed event.
    function test_Event_BidRevealed() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();
        uint256 price = 500e6;
        bytes32 salt  = keccak256("ev_rev");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);

        vm.prank(bidder1);
        vm.expectEmit(true, true, false, true, address(auction));
        emit BlindRelayAuction.BidRevealed(aid, bidder1, price);
        auction.revealBid(aid, price, salt);
    }

    /// @dev Test 41 — AuctionFinalized event (taskId == 0, first ever task in escrow).
    function test_Event_AuctionFinalized() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();
        uint256 price = 500e6;
        bytes32 salt  = keccak256("ev_fin");

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);

        vm.warp(revealEnd);

        vm.expectEmit(true, true, false, true, address(auction));
        emit BlindRelayAuction.AuctionFinalized(aid, bidder1, price, 0 /* taskId */);
        auction.finalize(aid);
    }

    /// @dev Test 42 — AuctionCancelled event (no reveals → cancelled).
    function test_Event_AuctionCancelled() public {
        (uint256 aid, , uint64 revealEnd) = _createAuction();

        vm.warp(revealEnd);

        vm.expectEmit(true, false, false, true, address(auction));
        emit BlindRelayAuction.AuctionCancelled(aid, 0);
        auction.finalize(aid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 11 — MAX_BIDDERS CAP
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 43 — 101st commit → TooManyBidders.
    ///      Uses vm.addr(i) to derive 101 distinct non-zero addresses.
    function test_MaxBidders_101stCommitReverts() public {
        (uint256 aid, , ) = _createAuction();

        uint32 maxBidders = auction.MAX_BIDDERS(); // 100

        for (uint256 i = 1; i <= maxBidders; i++) {
            address bidder = vm.addr(i);
            usdc.mint(bidder, BOND);
            vm.prank(bidder);
            usdc.approve(address(auction), type(uint256).max);
            vm.prank(bidder);
            auction.commitBid(aid, _makeCommitment(aid, bidder, 500e6, bytes32(i)));
        }

        // 101st bidder
        address bidder101 = vm.addr(maxBidders + 1);
        usdc.mint(bidder101, BOND);
        vm.prank(bidder101);
        usdc.approve(address(auction), type(uint256).max);

        vm.prank(bidder101);
        vm.expectRevert(BlindRelayAuction.TooManyBidders.selector);
        auction.commitBid(aid, _makeCommitment(aid, bidder101, 500e6, bytes32(uint256(maxBidders + 1))));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 12 — FUZZ TESTS
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test 44 — Fuzz bid price boundary: above budget → PriceTooHigh; else reveal succeeds.
    function testFuzz_BidPriceBoundary(uint256 price) public {
        price = bound(price, 1, 2_000e6);

        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();
        bytes32 salt = keccak256(abi.encode("fuzz_price", price));

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));

        vm.warp(commitEnd);

        if (price > BUDGET) {
            vm.prank(bidder1);
            vm.expectRevert(BlindRelayAuction.PriceTooHigh.selector);
            auction.revealBid(aid, price, salt);
        } else {
            vm.prank(bidder1);
            auction.revealBid(aid, price, salt); // should succeed

            vm.warp(revealEnd);
            auction.finalize(aid);

            assertEq(auction.pendingBalances(buyer), BUDGET - price, "buyer surplus correct");
        }
    }

    /// @dev Test 45 — Fuzz commit duration boundary: out-of-range → DurationOutOfRange; else succeeds.
    function testFuzz_CommitDurationBoundary(uint64 dur) public {
        dur = uint64(bound(uint256(dur), 1, 8 days));

        if (dur < auction.MIN_DURATION() || dur > auction.MAX_DURATION()) {
            vm.prank(buyer);
            vm.expectRevert(BlindRelayAuction.DurationOutOfRange.selector);
            auction.createAuction(BUDGET, dur, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH);
        } else {
            vm.prank(buyer);
            uint256 aid = auction.createAuction(BUDGET, dur, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH);
            // Verify the auction was created and commitEnd is correct
            (uint64 commitEnd, ) = _auctionTimings(aid);
            assertEq(commitEnd, uint64(block.timestamp) + dur, "commitEnd matches");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 13 — INVARIANT
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────
    //
    //  Invariant: at any point, the auction contract's USDC balance >= sum of all
    //  pending balances.  (It can be strictly greater between commit and finalize
    //  because bonds/budget are held but not yet distributed.)
    //
    //  We drive this with a handler that exercises the full lifecycle across
    //  multiple auctions and bidders, then check the invariant after each
    //  state-advancing call.
    //
    //  Because invariant tests in Foundry use a separate handler contract pattern,
    //  we implement a targeted stateful fuzz in a single test function instead,
    //  which gives equivalent coverage here.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Stateful invariant test: contract USDC balance >= sum of pending balances
    ///      after every phase of a full auction.
    function invariant_ContractBalanceGePendingSum() public view {
        // Read total pending for our three actors
        uint256 totalPending =
            auction.pendingBalances(buyer) +
            auction.pendingBalances(bidder1) +
            auction.pendingBalances(bidder2);

        uint256 contractBalance = usdc.balanceOf(address(auction));

        assertGe(
            contractBalance,
            totalPending,
            "contract balance must be >= total pending"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 14 — FALLBACK CANCEL (createTask failure)
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test — finalize falls back to Cancelled when TaskEscrow.createTask always reverts.
    ///      Bidder that revealed gets bond back; buyer gets full budget back.
    ///      AuctionCancelled emitted with reason=1.
    function test_Finalize_FallbackCancel_CreateTaskFails() public {
        // Deploy a malicious escrow that always reverts on createTask.
        MaliciousEscrow badEscrow = new MaliciousEscrow();

        // Deploy a fresh auction pointed at badEscrow.
        BlindRelayAuction badAuction = new BlindRelayAuction(address(usdc), address(badEscrow));

        // Approve the new auction contract.
        vm.prank(buyer);
        usdc.approve(address(badAuction), type(uint256).max);
        vm.prank(bidder1);
        usdc.approve(address(badAuction), type(uint256).max);

        // Create auction.
        vm.prank(buyer);
        uint256 aid = badAuction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH
        );

        uint64 commitEnd = uint64(block.timestamp + COMMIT_DUR);
        uint64 revealEnd = uint64(block.timestamp + COMMIT_DUR + REVEAL_DUR);

        bytes32 salt  = keccak256("fallback_salt");
        uint256 price = 500e6;

        // bidder1 commits and reveals.
        vm.prank(bidder1);
        bytes32 commitment = keccak256(abi.encode(address(badAuction), block.chainid, aid, bidder1, price, salt));
        badAuction.commitBid(aid, commitment);

        vm.warp(commitEnd);
        vm.prank(bidder1);
        badAuction.revealBid(aid, price, salt);

        vm.warp(revealEnd);

        // Expect AuctionCancelled with reason=1 (createTask failed).
        vm.expectEmit(true, false, false, true, address(badAuction));
        emit BlindRelayAuction.AuctionCancelled(aid, 1);
        badAuction.finalize(aid);

        // Assert status == Cancelled.
        (, , , , , , , , , , BlindRelayAuction.AuctionStatus status, ) = badAuction.auctions(aid);
        assertEq(uint256(status), uint256(BlindRelayAuction.AuctionStatus.Cancelled), "status == Cancelled");

        // Buyer gets full budget back.
        assertEq(badAuction.pendingBalances(buyer), BUDGET, "buyer gets budget back");

        // Bidder1 revealed → gets bond back.
        assertEq(badAuction.pendingBalances(bidder1), BOND, "bidder1 gets bond back (revealed)");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 15 — MAX_BIDDERS GAS TEST
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test — 100 bidders all reveal; measure gas of finalize.
    ///      Asserts gas < 4_000_000 and all bidders have pendingBalance==BOND after finalize.
    function test_GasReport_MaxBidders_FullAuction() public {
        uint32 maxBidders = auction.MAX_BIDDERS(); // 100

        // Create auction.
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        // Commit all 100 bidders. Use vm.addr(i+1000) to avoid conflicts with existing test addresses.
        for (uint256 i = 0; i < maxBidders; i++) {
            address bidder = vm.addr(i + 1000);
            usdc.mint(bidder, BOND);
            vm.prank(bidder);
            usdc.approve(address(auction), type(uint256).max);
            vm.prank(bidder);
            auction.commitBid(
                aid,
                keccak256(abi.encode(address(auction), block.chainid, aid, bidder, 500e6, bytes32(i + 1000)))
            );
        }

        // Warp to reveal phase and have all 100 bidders reveal.
        vm.warp(commitEnd);
        for (uint256 i = 0; i < maxBidders; i++) {
            address bidder = vm.addr(i + 1000);
            vm.prank(bidder);
            auction.revealBid(aid, 500e6, bytes32(i + 1000));
        }

        // Warp past reveal end, measure gas of finalize.
        vm.warp(revealEnd);
        uint256 gasBefore = gasleft();
        auction.finalize(aid);
        uint256 gasUsed = gasBefore - gasleft();

        // Log gas (visible with -vv).
        console.log("finalize gas (100 bidders):", gasUsed);

        // Assert gas is well below Arc block gas limit.
        assertLt(gasUsed, 4_000_000, "finalize gas < 4_000_000");

        // Assert all 100 bidders received their bond back.
        for (uint256 i = 0; i < maxBidders; i++) {
            address bidder = vm.addr(i + 1000);
            assertEq(auction.pendingBalances(bidder), BOND, "each bidder gets bond back");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 16 — READ FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Test — getAuction returns correct fields right after createAuction.
    function test_GetAuction_ReturnsCorrectFields() public {
        uint64 expectedCommitEnd = uint64(block.timestamp + COMMIT_DUR);
        uint64 expectedRevealEnd = uint64(block.timestamp + COMMIT_DUR + REVEAL_DUR);

        vm.prank(buyer);
        uint256 aid = auction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH
        );

        BlindRelayAuction.AuctionView memory v = auction.getAuction(aid);

        assertEq(v.buyer,            buyer,                                            "buyer");
        assertEq(v.budget,           BUDGET,                                           "budget");
        assertEq(v.bondAmount,       BOND,                                             "bondAmount");
        assertEq(v.commitEnd,        expectedCommitEnd,                                "commitEnd");
        assertEq(v.revealEnd,        expectedRevealEnd,                                "revealEnd");
        assertEq(uint64(v.deliveryDuration), DELIVERY_DUR,                            "deliveryDuration");
        assertEq(uint64(v.reviewWindow),     REVIEW_WIN,                              "reviewWindow");
        assertEq(v.taskHash,         TASK_HASH,                                        "taskHash");
        assertEq(uint256(v.status),  uint256(BlindRelayAuction.AuctionStatus.Active), "status==Active");
        assertEq(v.bidderCount,      0,                                                "bidderCount==0");
    }

    /// @dev Test — getBidders returns committers in commit order.
    function test_GetBidders_ReturnsCommitters() public {
        (uint256 aid, , ) = _createAuction();

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, 500e6, keccak256("gb_s1")));
        vm.prank(bidder2);
        auction.commitBid(aid, _makeCommitment(aid, bidder2, 600e6, keccak256("gb_s2")));

        address[] memory bidders = auction.getBidders(aid);
        assertEq(bidders.length, 2,       "two bidders");
        assertEq(bidders[0],     bidder1, "first is bidder1");
        assertEq(bidders[1],     bidder2, "second is bidder2");
    }

    /// @dev Test — getBid returns correct state before and after revealBid.
    function test_GetBid_ReturnsCorrectState() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();

        uint256 price = 500e6;
        bytes32 salt  = keccak256("getbid_salt");
        bytes32 expectedCommitment = _makeCommitment(aid, bidder1, price, salt);

        vm.prank(bidder1);
        auction.commitBid(aid, expectedCommitment);

        // Before reveal.
        (uint32 order, bool revealed, bytes32 commitment) = auction.getBid(aid, bidder1);
        assertEq(order,      1,                   "commitOrder == 1");
        assertEq(revealed,   false,               "not yet revealed");
        assertEq(commitment, expectedCommitment,  "commitment matches");

        // After reveal.
        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);

        (, bool revealedAfter, ) = auction.getBid(aid, bidder1);
        assertEq(revealedAfter, true, "hasRevealed == true after reveal");
    }

    /// @dev Test — phaseOf during commit phase == "Commit".
    function test_PhaseOf_Commit() public {
        (uint256 aid, , ) = _createAuction();
        assertEq(auction.phaseOf(aid), "Commit", "phase is Commit");
    }

    /// @dev Test — phaseOf during reveal phase == "Reveal".
    function test_PhaseOf_Reveal() public {
        (uint256 aid, uint64 commitEnd, ) = _createAuction();
        vm.warp(commitEnd);
        assertEq(auction.phaseOf(aid), "Reveal", "phase is Reveal");
    }

    /// @dev Test — phaseOf after revealEnd but before finalize == "Ended".
    function test_PhaseOf_Ended() public {
        (uint256 aid, , uint64 revealEnd) = _createAuction();
        vm.warp(revealEnd);
        assertEq(auction.phaseOf(aid), "Ended", "phase is Ended");
    }

    /// @dev Test — phaseOf after successful finalize == "Finalized".
    function test_PhaseOf_Finalized() public {
        (uint256 aid, uint64 commitEnd, uint64 revealEnd) = _createAuction();

        bytes32 salt  = keccak256("phase_fin_salt");
        uint256 price = 500e6;

        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));
        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);
        vm.warp(revealEnd);
        auction.finalize(aid);

        assertEq(auction.phaseOf(aid), "Finalized", "phase is Finalized");
    }

    /// @dev Test — phaseOf after cancel (no reveals) == "Cancelled".
    function test_PhaseOf_Cancelled() public {
        (uint256 aid, , uint64 revealEnd) = _createAuction();
        vm.warp(revealEnd);
        auction.finalize(aid);

        assertEq(auction.phaseOf(aid), "Cancelled", "phase is Cancelled");
    }

    /// @dev Test — phaseOf for a nonexistent auction == "Unknown".
    function test_PhaseOf_Unknown() public view {
        assertEq(auction.phaseOf(9999), "Unknown", "phase is Unknown");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    //  SECTION 17 — GAS GUARD
    // ══════════════════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Internal helper: create an auction, have bidder1 commit and reveal, warp past
    ///      revealEnd.  Returns auctionId, ready for finalize.
    function _auctionReadyToFinalize() internal returns (uint256 aid) {
        uint64 commitEnd;
        uint64 revealEnd;
        (aid, commitEnd, revealEnd) = _createAuction();
        bytes32 salt  = keccak256("gas_section_salt");
        uint256 price = 500e6;
        vm.prank(bidder1);
        auction.commitBid(aid, _makeCommitment(aid, bidder1, price, salt));
        vm.warp(commitEnd);
        vm.prank(bidder1);
        auction.revealBid(aid, price, salt);
        vm.warp(revealEnd);
    }

    /// @dev Test 67 — Sweep gas limit from well below GAS_FLOOR to well above.
    ///      For every step the outcome must be EITHER:
    ///        (a) revert — auction stays Active, OR
    ///        (b) success — auction is Finalized.
    ///      The outcome MUST NEVER be Cancelled.  Cancelled from a gas attack would
    ///      mean an OOG inside createTask was caught and misclassified as a genuine
    ///      createTask failure — the guard exists precisely to prevent that.
    ///
    ///      NOTE: GAS_FLOOR is the threshold checked by gasleft() INSIDE finalize, not
    ///      the gas forwarded at the call site.  Before reaching the guard, finalize
    ///      burns ~5 000 gas in preamble (nonReentrant lock, storage reads, status write).
    ///      "Low" values are those below the call-site minimum (~805 000); "high" values
    ///      exceed that threshold so gasleft() >= GAS_FLOOR at the guard.
    ///
    ///      Gas steps tested (sampled around the guard boundary for coverage):
    ///        100k, 200k, 400k, 700k, 799k (all below 800k at call site → should revert-Active)
    ///        810k, 900k, 1.5M, 3M, 5M     (all >= ~805k at call site → should succeed-Finalized)
    ///
    ///      Each iteration re-creates a fresh auction so state does not bleed over.
    function test_Finalize_GasSweep_NeverCancelled() public {
        uint256 gasFloor = auction.GAS_FLOOR(); // 800_000

        // Values below the floor — each must revert with InsufficientGasForFinalize
        // and leave the auction Active.
        uint256[] memory lowGasValues = new uint256[](5);
        lowGasValues[0] = 100_000;
        lowGasValues[1] = 200_000;
        lowGasValues[2] = 400_000;
        lowGasValues[3] = 700_000;
        lowGasValues[4] = gasFloor - 1; // 799_999 — well below call-site minimum

        for (uint256 i = 0; i < lowGasValues.length; i++) {
            uint256 aid = _auctionReadyToFinalize();

            vm.expectRevert(BlindRelayAuction.InsufficientGasForFinalize.selector);
            auction.finalize{gas: lowGasValues[i]}(aid);

            (, , , , , , , , , , BlindRelayAuction.AuctionStatus st, ) = auction.auctions(aid);
            assertEq(
                uint256(st),
                uint256(BlindRelayAuction.AuctionStatus.Active),
                "low-gas revert must leave auction Active"
            );
            // Explicitly confirm it is not Cancelled.
            assertNotEq(
                uint256(st),
                uint256(BlindRelayAuction.AuctionStatus.Cancelled),
                "NEVER Cancelled from gas starvation"
            );
        }

        // Values at or above the floor (at call site) — each must succeed and leave the auction Finalized.
        // gasFloor + 10_000 ensures gasleft() >= GAS_FLOOR at the guard after preamble overhead (~5 000 gas).
        uint256[] memory highGasValues = new uint256[](5);
        highGasValues[0] = gasFloor + 10_000; // 810_000 — lowest "should succeed" value
        highGasValues[1] = 900_000;
        highGasValues[2] = 1_500_000;
        highGasValues[3] = 3_000_000;
        highGasValues[4] = 5_000_000;

        for (uint256 i = 0; i < highGasValues.length; i++) {
            uint256 aid = _auctionReadyToFinalize();

            auction.finalize{gas: highGasValues[i]}(aid);

            (, , , , , , , , , , BlindRelayAuction.AuctionStatus st, ) = auction.auctions(aid);
            assertEq(
                uint256(st),
                uint256(BlindRelayAuction.AuctionStatus.Finalized),
                "sufficient-gas finalize must leave auction Finalized"
            );
            // Explicitly confirm it is not Cancelled.
            assertNotEq(
                uint256(st),
                uint256(BlindRelayAuction.AuctionStatus.Cancelled),
                "NEVER Cancelled from gas manipulation"
            );
        }
    }

    /// @dev Test 68 — finalize with GAS_FLOOR + call-site overhead gas succeeds (boundary check).
    ///      GAS_FLOOR is the amount gasleft() must show AT THE GUARD inside finalize.
    ///      Before reaching the guard, finalize burns ~5 000 gas in preamble (nonReentrant
    ///      SLOAD+SSTORE, status/revealEnd/bestBidder reads, status write).
    ///      We forward GAS_FLOOR + 10_000 so gasleft() >= GAS_FLOOR when the guard fires.
    function test_Finalize_ExactFloorGas_Succeeds() public {
        uint256 gasFloor = auction.GAS_FLOOR();
        uint256 aid = _auctionReadyToFinalize();

        // GAS_FLOOR + 10_000 covers the preamble overhead (~5 000 gas) with a safety margin.
        auction.finalize{gas: gasFloor + 10_000}(aid);

        (, , , , , , , , , , BlindRelayAuction.AuctionStatus status, ) = auction.auctions(aid);
        assertEq(uint256(status), uint256(BlindRelayAuction.AuctionStatus.Finalized), "floor+overhead gas => Finalized");
        assertEq(escrowContract.taskCount(), 1, "task created");
    }

    /// @dev Test 69 — finalize with gas one below GAS_FLOOR reverts and leaves auction Active.
    function test_Finalize_OneBelowFloor_RevertsAndStaysActive() public {
        uint256 gasFloor = auction.GAS_FLOOR();
        uint256 aid = _auctionReadyToFinalize();

        vm.expectRevert(BlindRelayAuction.InsufficientGasForFinalize.selector);
        auction.finalize{gas: gasFloor - 1}(aid);

        (, , , , , , , , , , BlindRelayAuction.AuctionStatus status, ) = auction.auctions(aid);
        assertEq(uint256(status), uint256(BlindRelayAuction.AuctionStatus.Active), "one-below-floor => still Active");
    }

    /// @dev Test 70 — When createTask genuinely reverts (mock escrow), finalize ends in
    ///      Cancelled with correct refunds, even with abundant gas.
    ///      This confirms the Cancelled path is reachable for real failures and that the
    ///      gas guard does not block it.
    function test_Finalize_TrueCreateTaskRevert_EndsCancelled() public {
        // Deploy a mock escrow that always reverts on createTask.
        MaliciousEscrow badEscrow = new MaliciousEscrow();
        BlindRelayAuction badAuction = new BlindRelayAuction(address(usdc), address(badEscrow));

        vm.prank(buyer);
        usdc.approve(address(badAuction), type(uint256).max);
        vm.prank(bidder1);
        usdc.approve(address(badAuction), type(uint256).max);
        vm.prank(bidder2);
        usdc.approve(address(badAuction), type(uint256).max);

        // Create auction.
        vm.prank(buyer);
        uint256 aid = badAuction.createAuction(
            BUDGET, COMMIT_DUR, REVEAL_DUR, BOND, DELIVERY_DUR, REVIEW_WIN, TASK_HASH
        );

        uint64 commitEnd = uint64(block.timestamp + COMMIT_DUR);
        uint64 revealEnd = uint64(block.timestamp + COMMIT_DUR + REVEAL_DUR);

        // bidder1 commits and reveals; bidder2 commits but does NOT reveal (forfeits bond).
        bytes32 salt  = keccak256("true_revert_salt");
        uint256 price = 500e6;

        vm.prank(bidder1);
        badAuction.commitBid(aid, keccak256(abi.encode(address(badAuction), block.chainid, aid, bidder1, price, salt)));
        vm.prank(bidder2);
        badAuction.commitBid(aid, keccak256(abi.encode(address(badAuction), block.chainid, aid, bidder2, price, keccak256("no_reveal"))));

        vm.warp(commitEnd);
        vm.prank(bidder1);
        badAuction.revealBid(aid, price, salt);
        // bidder2 does NOT reveal.

        vm.warp(revealEnd);

        // Finalize with abundant gas — createTask still reverts (it always does).
        vm.expectEmit(true, false, false, true, address(badAuction));
        emit BlindRelayAuction.AuctionCancelled(aid, 1); // reason=1: createTask failed
        badAuction.finalize{gas: 5_000_000}(aid);

        // Status is Cancelled.
        (, , , , , , , , , , BlindRelayAuction.AuctionStatus status, ) = badAuction.auctions(aid);
        assertEq(uint256(status), uint256(BlindRelayAuction.AuctionStatus.Cancelled), "Cancelled on genuine revert");

        // Buyer gets full budget back + bidder2's forfeited bond.
        assertEq(badAuction.pendingBalances(buyer),   BUDGET + BOND, "buyer gets budget + forfeited bond");
        // bidder1 revealed → gets bond back.
        assertEq(badAuction.pendingBalances(bidder1), BOND,          "bidder1 revealed => bond returned");
        // bidder2 did not reveal => 0 pending.
        assertEq(badAuction.pendingBalances(bidder2), 0,             "bidder2 forfeited => nothing pending");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  MALICIOUS ESCROW — used by fallback-cancel test
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

/// @dev A mock TaskEscrow that always reverts on createTask, to test the
///      BlindRelayAuction try/catch fallback-cancel path.
contract MaliciousEscrow {
    function createTask(address, address, uint256, uint64, uint64) external pure returns (uint256) {
        revert("always fails");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  INVARIANT HANDLER — stateful fuzzer driver
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Handler contract that Foundry's invariant engine can call randomly.
///      It drives BlindRelayAuction through realistic lifecycle calls and
///      exposes the invariant check to the test.
contract BlindRelayAuctionHandler is Test {
    BlindRelayAuction internal auction;
    MockERC20         internal usdc;

    address internal buyer   = address(0x1);
    address internal bidder1 = address(0x2);
    address internal bidder2 = address(0x3);

    uint256 internal constant BUDGET = 1_000e6;
    uint256 internal constant BOND   = 50e6;

    uint256 internal currentAid;
    bool    internal auctionCreated;
    bool    internal bid1Committed;
    bool    internal bid2Committed;
    bool    internal bid1Revealed;
    bool    internal finalized;
    uint64  internal commitEnd;
    uint64  internal revealEnd;

    constructor(BlindRelayAuction _auction, MockERC20 _usdc) {
        auction = _auction;
        usdc    = _usdc;

        // Seed all actors
        usdc.mint(buyer,   100_000e6);
        usdc.mint(bidder1, 100_000e6);
        usdc.mint(bidder2, 100_000e6);

        vm.prank(buyer);
        usdc.approve(address(auction), type(uint256).max);
        vm.prank(bidder1);
        usdc.approve(address(auction), type(uint256).max);
        vm.prank(bidder2);
        usdc.approve(address(auction), type(uint256).max);
    }

    function createAuction() external {
        if (auctionCreated) return;

        vm.prank(buyer);
        currentAid = auction.createAuction(
            BUDGET, 1 hours, 1 hours, BOND, 7 days, 1 days, keccak256("inv_task")
        );
        commitEnd = uint64(block.timestamp + 1 hours);
        revealEnd = uint64(block.timestamp + 2 hours);
        auctionCreated = true;
    }

    function commitBidder1(uint256 price) external {
        if (!auctionCreated || bid1Committed || block.timestamp >= commitEnd) return;
        price = bound(price, 1, BUDGET);
        bytes32 salt = keccak256("inv_salt1");
        bytes32 c = keccak256(abi.encode(address(auction), block.chainid, currentAid, bidder1, price, salt));
        vm.prank(bidder1);
        try auction.commitBid(currentAid, c) { bid1Committed = true; } catch {}
    }

    function commitBidder2(uint256 price) external {
        if (!auctionCreated || bid2Committed || block.timestamp >= commitEnd) return;
        price = bound(price, 1, BUDGET);
        bytes32 salt = keccak256("inv_salt2");
        bytes32 c = keccak256(abi.encode(address(auction), block.chainid, currentAid, bidder2, price, salt));
        vm.prank(bidder2);
        try auction.commitBid(currentAid, c) { bid2Committed = true; } catch {}
    }

    function warpToReveal() external {
        if (!auctionCreated) return;
        vm.warp(commitEnd);
    }

    function revealBidder1(uint256 price) external {
        if (!bid1Committed || bid1Revealed) return;
        price = bound(price, 1, BUDGET);
        bytes32 salt = keccak256("inv_salt1");
        vm.prank(bidder1);
        try auction.revealBid(currentAid, price, salt) { bid1Revealed = true; } catch {}
    }

    function warpToFinalize() external {
        if (!auctionCreated) return;
        vm.warp(revealEnd);
    }

    function finalizeAuction() external {
        if (!auctionCreated || finalized) return;
        if (block.timestamp < revealEnd) return;
        try auction.finalize(currentAid) { finalized = true; } catch {}
    }
}

/// @dev Separate invariant test contract that wires the handler.
contract BlindRelayAuctionInvariantTest is Test {
    BlindRelayAuction        internal auction;
    MockERC20                internal usdc;
    TaskEscrow               internal escrowContract;
    BlindRelayAuctionHandler internal handler;

    address internal buyer   = address(0x1);
    address internal bidder1 = address(0x2);
    address internal bidder2 = address(0x3);

    function setUp() public {
        usdc           = new MockERC20("Mock USDC", "mUSDC", 6);
        escrowContract = new TaskEscrow(address(usdc));
        auction        = new BlindRelayAuction(address(usdc), address(escrowContract));
        handler        = new BlindRelayAuctionHandler(auction, usdc);

        // Target the handler for invariant fuzzing
        targetContract(address(handler));
    }

    /// @dev Invariant: the auction contract's USDC balance is always >= the sum of all pending balances.
    ///      This ensures no withdrawable amount was accidentally sent out or double-counted.
    function invariant_ContractBalanceGePendingSum() public view {
        uint256 totalPending =
            auction.pendingBalances(buyer) +
            auction.pendingBalances(bidder1) +
            auction.pendingBalances(bidder2);

        uint256 contractBalance = usdc.balanceOf(address(auction));

        assertGe(
            contractBalance,
            totalPending,
            "contract balance must be >= total pending balances"
        );
    }
}
