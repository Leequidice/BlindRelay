// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TaskEscrow} from "../TaskEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev Full Foundry test suite for TaskEscrow.
///      All 36 required test cases (happy paths, boundary, dispute, access-control,
///      double-execution, event, fuzz, invariant) are covered.
contract TaskEscrowTest is Test {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants / fixtures
    // ─────────────────────────────────────────────────────────────────────────

    uint256 internal constant PRICE       = 100e6;   // 100 USDC (6 decimals)
    uint64  internal constant REVIEW_WIN  = 1 days;  // 86 400 s
    uint64  internal constant TASK_TTL    = 7 days;  // deadline offset from now

    // ─────────────────────────────────────────────────────────────────────────
    // Actors
    // ─────────────────────────────────────────────────────────────────────────

    address internal buyer    = makeAddr("buyer");
    address internal provider = makeAddr("provider");
    address internal stranger = makeAddr("stranger");

    // ─────────────────────────────────────────────────────────────────────────
    // Contracts
    // ─────────────────────────────────────────────────────────────────────────

    MockERC20   internal usdc;
    TaskEscrow  internal escrow;

    // ─────────────────────────────────────────────────────────────────────────
    // setUp – runs before every test
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        // Deploy mock USDC with 6 decimals
        usdc   = new MockERC20("Mock USDC", "mUSDC", 6);
        // Deploy escrow pointing at the mock token
        escrow = new TaskEscrow(address(usdc));

        // Fund buyer with enough USDC for several tasks
        usdc.mint(buyer, 10_000e6);
        // Approve escrow to pull from buyer
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// Create a task from `buyer` with standard parameters and return (taskId, deadline).
    function _createStandard() internal returns (uint256 taskId, uint64 deadline) {
        deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        taskId = escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);
    }

    /// Create a task, then have provider submit delivery. Returns (taskId, deliveredAt).
    function _createAndDeliver() internal returns (uint256 taskId, uint64 deliveredAt) {
        (taskId,) = _createStandard();
        deliveredAt = uint64(block.timestamp);
        vm.prank(provider);
        escrow.submitDelivery(taskId, keccak256("proof"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ① Deployment / initialization
    // ─────────────────────────────────────────────────────────────────────────

    function test_ConstructorStoresUsdc() public view {
        assertEq(escrow.usdc(), address(usdc));
    }

    function test_ConstructorRevertsZeroAddress() public {
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        new TaskEscrow(address(0));
    }

    function test_InitialTaskCountIsZero() public view {
        assertEq(escrow.taskCount(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ② Happy paths
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 1 – create → deliver → accept: Settled, provider receives price
    function test_HappyPath_CreateDeliverAccept() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(buyer);
        escrow.accept(taskId);

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Settled), "status should be Settled");
        assertEq(usdc.balanceOf(provider), providerBefore + PRICE, "provider should receive price");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow should be empty");

        // silence unused-var warning
        deliveredAt;
    }

    // Test case 2 – create → deliver → release (after review window): Settled, provider receives price
    function test_HappyPath_CreateDeliverRelease() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        // Warp to one second after the review window closes
        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1);

        uint256 providerBefore = usdc.balanceOf(provider);

        escrow.release(taskId); // anyone can call release

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Settled), "status should be Settled");
        assertEq(usdc.balanceOf(provider), providerBefore + PRICE, "provider should receive price");
    }

    // Test case 3 – create → reclaim (deadline passed, no delivery): Reclaimed, buyer receives price
    function test_HappyPath_CreateReclaim() public {
        (uint256 taskId, uint64 deadline) = _createStandard();

        // Warp to one second after deadline
        vm.warp(uint256(deadline) + 1);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        escrow.reclaim(taskId);

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Reclaimed), "status should be Reclaimed");
        assertEq(usdc.balanceOf(buyer), buyerBefore + PRICE, "buyer should receive refund");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow should be empty");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ③ Boundary tests (vm.warp)
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 4 – release at exactly deliveredAt + reviewWindow: MUST revert ReviewWindowNotExpired
    function test_Boundary_ReleaseAtWindowBoundaryReverts() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        vm.warp(uint256(deliveredAt) + REVIEW_WIN); // exactly at window boundary

        vm.expectRevert(TaskEscrow.ReviewWindowNotExpired.selector);
        escrow.release(taskId);
    }

    // Test case 5 – release at deliveredAt + reviewWindow + 1: MUST succeed
    function test_Boundary_ReleaseOneSecondAfterWindowSucceeds() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1); // one second after window

        escrow.release(taskId); // should not revert

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Settled));
    }

    // Test case 6 – reclaim at exactly block.timestamp == deadline: MUST revert DeadlineNotPassed
    function test_Boundary_ReclaimAtExactDeadlineReverts() public {
        (uint256 taskId, uint64 deadline) = _createStandard();

        vm.warp(uint256(deadline)); // exactly at deadline

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.DeadlineNotPassed.selector);
        escrow.reclaim(taskId);
    }

    // Test case 7 – reclaim at deadline + 1: MUST succeed
    function test_Boundary_ReclaimOneSecondAfterDeadlineSucceeds() public {
        (uint256 taskId, uint64 deadline) = _createStandard();

        vm.warp(uint256(deadline) + 1);

        vm.prank(buyer);
        escrow.reclaim(taskId); // should not revert

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Reclaimed));
    }

    // Test case 8 – submitDelivery at exactly block.timestamp == deadline: MUST succeed
    function test_Boundary_SubmitDeliveryAtExactDeadlineSucceeds() public {
        (uint256 taskId, uint64 deadline) = _createStandard();

        vm.warp(uint256(deadline)); // exactly at deadline

        vm.prank(provider);
        escrow.submitDelivery(taskId, keccak256("proof")); // should not revert

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Delivered));
    }

    // Test case 9 – submitDelivery at deadline + 1: MUST revert DeadlinePassed
    function test_Boundary_SubmitDeliveryOneSecondAfterDeadlineReverts() public {
        (uint256 taskId, uint64 deadline) = _createStandard();

        vm.warp(uint256(deadline) + 1);

        vm.prank(provider);
        vm.expectRevert(TaskEscrow.DeadlinePassed.selector);
        escrow.submitDelivery(taskId, keccak256("proof"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ④ Dispute tests
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 10 – reject → Disputed, funds stay locked
    function test_Dispute_RejectLocksStatus() public {
        (uint256 taskId,) = _createAndDeliver();

        uint256 escrowBefore = usdc.balanceOf(address(escrow));

        vm.prank(buyer);
        escrow.reject(taskId);

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Disputed), "status should be Disputed");
        // Funds remain locked in the contract
        assertEq(usdc.balanceOf(address(escrow)), escrowBefore, "funds should stay locked");
    }

    // Test case 11 – reject after review window closes: MUST revert ReviewWindowExpired
    function test_Dispute_RejectAfterWindowReverts() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1); // window closed

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ReviewWindowExpired.selector);
        escrow.reject(taskId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑤ Wrong caller (access-control) tests
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 12 – accept called by non-buyer: revert NotBuyer
    function test_AccessControl_AcceptNonBuyerReverts() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(stranger);
        vm.expectRevert(TaskEscrow.NotBuyer.selector);
        escrow.accept(taskId);
    }

    // Test case 13 – reject called by non-buyer: revert NotBuyer
    function test_AccessControl_RejectNonBuyerReverts() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(stranger);
        vm.expectRevert(TaskEscrow.NotBuyer.selector);
        escrow.reject(taskId);
    }

    // Test case 14 – reclaim called by non-buyer: revert NotBuyer
    function test_AccessControl_ReclaimNonBuyerReverts() public {
        (uint256 taskId, uint64 deadline) = _createStandard();
        vm.warp(uint256(deadline) + 1);

        vm.prank(stranger);
        vm.expectRevert(TaskEscrow.NotBuyer.selector);
        escrow.reclaim(taskId);
    }

    // Test case 15 – submitDelivery called by non-provider: revert NotProvider
    function test_AccessControl_SubmitDeliveryNonProviderReverts() public {
        (uint256 taskId,) = _createStandard();

        vm.prank(stranger);
        vm.expectRevert(TaskEscrow.NotProvider.selector);
        escrow.submitDelivery(taskId, keccak256("proof"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑥ Double-execution tests
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 16 – double accept: second accept reverts NotDelivered
    function test_DoubleExecution_DoubleAccept() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(buyer);
        escrow.accept(taskId);

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.NotDelivered.selector);
        escrow.accept(taskId);
    }

    // Test case 17 – double release: second release reverts NotDelivered
    function test_DoubleExecution_DoubleRelease() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();
        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1);

        escrow.release(taskId);

        vm.expectRevert(TaskEscrow.NotDelivered.selector);
        escrow.release(taskId);
    }

    // Test case 18 – accept then release: release reverts NotDelivered
    function test_DoubleExecution_AcceptThenRelease() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        vm.prank(buyer);
        escrow.accept(taskId);

        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1);

        vm.expectRevert(TaskEscrow.NotDelivered.selector);
        escrow.release(taskId);
    }

    // Test case 19 – release then accept: accept reverts NotDelivered
    function test_DoubleExecution_ReleaseThenAccept() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();
        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1);

        escrow.release(taskId);

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.NotDelivered.selector);
        escrow.accept(taskId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑦ Late delivery
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 20 – submitDelivery after deadline: revert DeadlinePassed
    function test_LateDelivery_SubmitAfterDeadlineReverts() public {
        (uint256 taskId, uint64 deadline) = _createStandard();

        vm.warp(uint256(deadline) + 100);

        vm.prank(provider);
        vm.expectRevert(TaskEscrow.DeadlinePassed.selector);
        escrow.submitDelivery(taskId, keccak256("proof"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑧ createTask validation failures
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 21 – zero buyer address
    function test_CreateTask_ZeroBuyerReverts() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        escrow.createTask(address(0), provider, PRICE, deadline, REVIEW_WIN);
    }

    // Test case 22 – zero provider address
    function test_CreateTask_ZeroProviderReverts() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        escrow.createTask(buyer, address(0), PRICE, deadline, REVIEW_WIN);
    }

    // Test case 23 – zero price
    function test_CreateTask_ZeroPriceReverts() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ZeroPrice.selector);
        escrow.createTask(buyer, provider, 0, deadline, REVIEW_WIN);
    }

    // Test case 24 – deadline in the past (deadline == block.timestamp)
    function test_CreateTask_DeadlineAtNowReverts() public {
        uint64 deadline = uint64(block.timestamp); // equal to now → DeadlineInPast
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.DeadlineInPast.selector);
        escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);
    }

    // Test case 25 – zero review window
    function test_CreateTask_ZeroReviewWindowReverts() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ZeroReviewWindow.selector);
        escrow.createTask(buyer, provider, PRICE, deadline, 0);
    }

    // Test case 26 – buyer == provider
    function test_CreateTask_BuyerProviderSameReverts() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.BuyerProviderSame.selector);
        escrow.createTask(buyer, buyer, PRICE, deadline, REVIEW_WIN);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑨ Accept/release timing
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 27 – accept after review window closes: revert ReviewWindowExpired
    function test_Timing_AcceptAfterWindowReverts() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1);

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ReviewWindowExpired.selector);
        escrow.accept(taskId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑩ Third-party funder (auction contract pattern)
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 28 – auction contract calls createTask; USDC pulled from auction contract;
    //                on reclaim, buyer (not auction contract) receives refund
    function test_ThirdPartyFunder_ReclaimGoesToBuyer() public {
        address auction = makeAddr("auction");
        address realBuyer = makeAddr("realBuyer"); // separate from the funder

        // Fund the auction contract, not realBuyer
        usdc.mint(auction, PRICE);
        vm.prank(auction);
        usdc.approve(address(escrow), PRICE);

        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        // auction creates task naming realBuyer as buyer
        vm.prank(auction);
        uint256 taskId = escrow.createTask(realBuyer, provider, PRICE, deadline, REVIEW_WIN);

        // USDC was pulled from auction
        assertEq(usdc.balanceOf(auction), 0, "auction USDC should be zero after funding");

        // realBuyer holds buyer rights – reclaim after deadline
        vm.warp(uint256(deadline) + 1);

        uint256 realBuyerBefore = usdc.balanceOf(realBuyer);

        vm.prank(realBuyer); // only realBuyer (named buyer) can reclaim
        escrow.reclaim(taskId);

        assertEq(usdc.balanceOf(realBuyer), realBuyerBefore + PRICE, "refund must go to named buyer");
        assertEq(usdc.balanceOf(auction), 0, "auction should not receive refund");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑪ Event tests
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 29 – TaskCreated event emitted with correct args
    function test_Event_TaskCreated() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        vm.prank(buyer);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit TaskEscrow.TaskCreated(0, buyer, provider, PRICE, deadline, REVIEW_WIN);
        escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);
    }

    // Test case 30 – DeliverySubmitted event emitted with correct args
    function test_Event_DeliverySubmitted() public {
        (uint256 taskId,) = _createStandard();
        bytes32 deliveryHash = keccak256("proof-data");

        vm.prank(provider);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit TaskEscrow.DeliverySubmitted(taskId, deliveryHash);
        escrow.submitDelivery(taskId, deliveryHash);
    }

    // Test case 31 – TaskSettled event on accept
    function test_Event_TaskSettledOnAccept() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(buyer);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit TaskEscrow.TaskSettled(taskId, provider, PRICE);
        escrow.accept(taskId);
    }

    // Test case 32 – TaskSettled event on release
    function test_Event_TaskSettledOnRelease() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();
        vm.warp(uint256(deliveredAt) + REVIEW_WIN + 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit TaskEscrow.TaskSettled(taskId, provider, PRICE);
        escrow.release(taskId);
    }

    // Test case 33 – TaskReclaimed event on reclaim
    function test_Event_TaskReclaimed() public {
        (uint256 taskId, uint64 deadline) = _createStandard();
        vm.warp(uint256(deadline) + 1);

        vm.prank(buyer);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit TaskEscrow.TaskReclaimed(taskId, buyer, PRICE);
        escrow.reclaim(taskId);
    }

    // Test case 34 – TaskDisputed event on reject
    function test_Event_TaskDisputed() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(buyer);
        vm.expectEmit(true, false, false, false, address(escrow));
        emit TaskEscrow.TaskDisputed(taskId);
        escrow.reject(taskId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑫ Miscellaneous revert paths
    // ─────────────────────────────────────────────────────────────────────────

    // Test case 36 – reclaim on a Delivered task: revert NotFunded
    function test_Reclaim_OnDeliveredTaskReverts() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        // Warp past deadline so reclaim deadline check passes if status were Funded
        // deliveredAt == block.timestamp when submitDelivery was called;
        // create used block.timestamp + 7 days as deadline, so we must go past that too
        (, , , uint64 deadline, , , ,) = escrow.tasks(taskId);
        vm.warp(uint256(deadline) + 1);

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.NotFunded.selector); // status is Delivered, not Funded
        escrow.reclaim(taskId);

        deliveredAt; // silence unused-var warning
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑬ Fuzz – key arithmetic (price, deadline, reviewWindow)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Fuzz: any valid price > 0 must route funds correctly through accept.
    function testFuzz_CreateDeliverAccept_ArbitraryPrice(uint96 rawPrice) public {
        uint256 price = bound(uint256(rawPrice), 1, 1_000_000e6); // 1 micro-USDC to 1M USDC

        // Mint and approve the fuzz price for buyer
        usdc.mint(buyer, price);
        vm.prank(buyer);
        usdc.approve(address(escrow), price);

        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        vm.prank(buyer);
        uint256 taskId = escrow.createTask(buyer, provider, price, deadline, REVIEW_WIN);

        vm.prank(provider);
        escrow.submitDelivery(taskId, keccak256("fuzz-proof"));

        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(buyer);
        escrow.accept(taskId);

        assertEq(usdc.balanceOf(provider), providerBefore + price, "provider should receive exact fuzz price");
    }

    /// @dev Fuzz: review window boundary — release at (deliveredAt + window) reverts,
    ///           release at (deliveredAt + window + 1) succeeds.
    function testFuzz_ReviewWindowBoundary(uint32 window) public {
        // Bound to [1, MAX_REVIEW_WINDOW] — the new upper-bound validation rejects anything larger.
        uint64 reviewWindow = uint64(bound(uint256(window), 1, escrow.MAX_REVIEW_WINDOW()));

        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        vm.prank(buyer);
        uint256 taskId = escrow.createTask(buyer, provider, PRICE, deadline, reviewWindow);

        uint64 deliveredAt = uint64(block.timestamp);
        vm.prank(provider);
        escrow.submitDelivery(taskId, keccak256("fuzz-proof"));

        // At boundary → must revert
        vm.warp(uint256(deliveredAt) + uint256(reviewWindow));
        vm.expectRevert(TaskEscrow.ReviewWindowNotExpired.selector);
        escrow.release(taskId);

        // One second later → must succeed
        vm.warp(uint256(deliveredAt) + uint256(reviewWindow) + 1);
        escrow.release(taskId);

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Settled));
    }

    /// @dev Fuzz: deadline boundary — reclaim at deadline reverts; at deadline+1 succeeds.
    function testFuzz_DeadlineBoundary(uint32 ttl) public {
        // Bound to [1, MAX_DEADLINE_HORIZON] — the new upper-bound validation rejects anything larger.
        uint64 futureTtl = uint64(bound(uint256(ttl), 1, escrow.MAX_DEADLINE_HORIZON()));
        uint64 deadline  = uint64(block.timestamp + futureTtl);

        vm.prank(buyer);
        uint256 taskId = escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);

        // Warp to exactly deadline → reclaim must revert
        vm.warp(uint256(deadline));
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.DeadlineNotPassed.selector);
        escrow.reclaim(taskId);

        // One second later → must succeed
        vm.warp(uint256(deadline) + 1);
        vm.prank(buyer);
        escrow.reclaim(taskId);

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Reclaimed));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑭ USDC balance invariant (test case 35)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The escrow contract's USDC balance must always be >= sum of prices
    ///      for tasks in Funded, Delivered, or Disputed status.
    ///      We verify this after each state-changing operation in a staged scenario.
    function test_Invariant_EscrowBalance_AfterEachOperation() public {
        // Helper: read task price and status, accumulate locked amount
        // We create 4 tasks and exercise different lifecycle paths, checking
        // the invariant after every mutating call.

        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        // ── Task A: will be accepted (Settled) ──
        vm.prank(buyer);
        uint256 tA = escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);
        _assertBalanceInvariant("after create A");

        vm.prank(provider);
        escrow.submitDelivery(tA, keccak256("A"));
        _assertBalanceInvariant("after deliver A");

        vm.prank(buyer);
        escrow.accept(tA);
        _assertBalanceInvariant("after accept A");

        // ── Task B: will be released (Settled) ──
        usdc.mint(buyer, PRICE);
        vm.prank(buyer);
        uint256 tB = escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);
        _assertBalanceInvariant("after create B");

        vm.prank(provider);
        escrow.submitDelivery(tB, keccak256("B"));
        _assertBalanceInvariant("after deliver B");

        uint256 relTime;
        (, , , , , uint64 deliveredAtB, ,) = escrow.tasks(tB);
        relTime = uint256(deliveredAtB) + REVIEW_WIN + 1;
        vm.warp(relTime);
        escrow.release(tB);
        _assertBalanceInvariant("after release B");

        // ── Task C: will be reclaimed (Reclaimed) ──
        // Need a fresh deadline in the future from current warp
        uint64 deadlineC = uint64(block.timestamp + TASK_TTL);
        usdc.mint(buyer, PRICE);
        vm.prank(buyer);
        uint256 tC = escrow.createTask(buyer, provider, PRICE, deadlineC, REVIEW_WIN);
        _assertBalanceInvariant("after create C");

        vm.warp(uint256(deadlineC) + 1);
        vm.prank(buyer);
        escrow.reclaim(tC);
        _assertBalanceInvariant("after reclaim C");

        // ── Task D: will be rejected (Disputed) ──
        uint64 deadlineD = uint64(block.timestamp + TASK_TTL);
        usdc.mint(buyer, PRICE);
        vm.prank(buyer);
        uint256 tD = escrow.createTask(buyer, provider, PRICE, deadlineD, REVIEW_WIN);
        _assertBalanceInvariant("after create D");

        vm.prank(provider);
        escrow.submitDelivery(tD, keccak256("D"));
        _assertBalanceInvariant("after deliver D");

        vm.prank(buyer);
        escrow.reject(tD);
        _assertBalanceInvariant("after reject D");
    }

    /// @dev Compute sum of prices for tasks whose status is Funded, Delivered, or Disputed,
    ///      then assert contract USDC balance >= that sum.
    function _assertBalanceInvariant(string memory label) internal view {
        uint256 count = escrow.taskCount();
        uint256 lockedSum;
        for (uint256 i; i < count; ++i) {
            (, , uint256 price, , , , TaskEscrow.TaskStatus status,) = escrow.tasks(i);
            if (
                status == TaskEscrow.TaskStatus.Funded     ||
                status == TaskEscrow.TaskStatus.Delivered  ||
                status == TaskEscrow.TaskStatus.Disputed
            ) {
                lockedSum += price;
            }
        }
        uint256 contractBalance = usdc.balanceOf(address(escrow));
        assertGe(
            contractBalance,
            lockedSum,
            string.concat("INVARIANT BROKEN: escrow balance < locked sum -- ", label)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑮ Additional: accept at exactly review window boundary (inclusive boundary)
    //    accept at deliveredAt + reviewWindow: must SUCCEED (still open)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Boundary_AcceptAtWindowBoundarySucceeds() public {
        (uint256 taskId, uint64 deliveredAt) = _createAndDeliver();

        vm.warp(uint256(deliveredAt) + REVIEW_WIN); // exactly at boundary

        vm.prank(buyer);
        escrow.accept(taskId); // should not revert

        (, , , , , , TaskEscrow.TaskStatus status,) = escrow.tasks(taskId);
        assertEq(uint8(status), uint8(TaskEscrow.TaskStatus.Settled));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑯ createTask increments taskCount correctly
    // ─────────────────────────────────────────────────────────────────────────

    function test_CreateTask_IncrementsTaskCount() public {
        assertEq(escrow.taskCount(), 0);
        _createStandard();
        assertEq(escrow.taskCount(), 1);
        _createStandard();
        assertEq(escrow.taskCount(), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑰ createTask stores task fields correctly
    // ─────────────────────────────────────────────────────────────────────────

    function test_CreateTask_StoresFieldsCorrectly() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        vm.prank(buyer);
        uint256 taskId = escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);

        (
            address storedBuyer,
            address storedProvider,
            uint256 storedPrice,
            uint64 storedDeadline,
            uint64 storedReviewWindow,
            uint64 storedDeliveredAt,
            TaskEscrow.TaskStatus storedStatus,
            bytes32 storedHash
        ) = escrow.tasks(taskId);

        assertEq(storedBuyer,        buyer,               "buyer mismatch");
        assertEq(storedProvider,     provider,            "provider mismatch");
        assertEq(storedPrice,        PRICE,               "price mismatch");
        assertEq(storedDeadline,     deadline,            "deadline mismatch");
        assertEq(storedReviewWindow, REVIEW_WIN,          "reviewWindow mismatch");
        assertEq(storedDeliveredAt,  0,                   "deliveredAt should be 0");
        assertEq(uint8(storedStatus),uint8(TaskEscrow.TaskStatus.Funded), "status should be Funded");
        assertEq(storedHash,         bytes32(0),          "deliveryHash should be zero");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑱ submitDelivery stores deliveryHash and deliveredAt
    // ─────────────────────────────────────────────────────────────────────────

    function test_SubmitDelivery_StoresHashAndTimestamp() public {
        (uint256 taskId,) = _createStandard();
        bytes32 hash = keccak256("my-delivery");
        uint64 expectedAt = uint64(block.timestamp);

        vm.prank(provider);
        escrow.submitDelivery(taskId, hash);

        (, , , , , uint64 storedDeliveredAt, , bytes32 storedHash) = escrow.tasks(taskId);

        assertEq(storedDeliveredAt, expectedAt, "deliveredAt should match block.timestamp");
        assertEq(storedHash,        hash,       "deliveryHash should match");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑲ USDC pulled from msg.sender on createTask (not from named buyer)
    // ─────────────────────────────────────────────────────────────────────────

    function test_CreateTask_PullsUsdcFromMsgSender() public {
        address funder = makeAddr("funder");
        usdc.mint(funder, PRICE);
        vm.prank(funder);
        usdc.approve(address(escrow), PRICE);

        uint256 funderBefore  = usdc.balanceOf(funder);
        uint256 buyerBefore   = usdc.balanceOf(buyer);
        uint256 escrowBefore  = usdc.balanceOf(address(escrow));

        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        // funder is msg.sender but buyer is a different address
        vm.prank(funder);
        escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);

        assertEq(usdc.balanceOf(funder),          funderBefore - PRICE,  "USDC must leave funder");
        assertEq(usdc.balanceOf(buyer),            buyerBefore,           "buyer balance unchanged");
        assertEq(usdc.balanceOf(address(escrow)), escrowBefore + PRICE,  "USDC must arrive in escrow");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ⑳ New tests — constants, bounds, double-submit, reject-on-wrong-status
    // ─────────────────────────────────────────────────────────────────────────

    // ── Constants are publicly readable ──────────────────────────────────────

    function test_Constants_MaxReviewWindow() public view {
        assertEq(escrow.MAX_REVIEW_WINDOW(),    30 days, "MAX_REVIEW_WINDOW should be 30 days");
    }

    function test_Constants_MaxDeadlineHorizon() public view {
        assertEq(escrow.MAX_DEADLINE_HORIZON(), 365 days, "MAX_DEADLINE_HORIZON should be 365 days");
    }

    // ── reviewWindow bounds ───────────────────────────────────────────────────

    // reviewWindow at the max (exactly 30 days): MUST succeed
    function test_Bounds_ReviewWindowAtMax_Succeeds() public {
        uint64 deadline    = uint64(block.timestamp + TASK_TTL);
        uint64 maxWindow   = escrow.MAX_REVIEW_WINDOW();

        vm.prank(buyer);
        uint256 taskId = escrow.createTask(buyer, provider, PRICE, deadline, maxWindow);

        // Verify the window was stored correctly
        (, , , , uint64 storedWindow, , ,) = escrow.tasks(taskId);
        assertEq(storedWindow, maxWindow, "reviewWindow should be stored as MAX_REVIEW_WINDOW");
    }

    // reviewWindow at max + 1: MUST revert ReviewWindowTooLong
    function test_Bounds_ReviewWindowAboveMax_Reverts() public {
        uint64 deadline   = uint64(block.timestamp + TASK_TTL);
        uint64 tooLong    = escrow.MAX_REVIEW_WINDOW() + 1;

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ReviewWindowTooLong.selector);
        escrow.createTask(buyer, provider, PRICE, deadline, tooLong);
    }

    // ── deadline horizon bounds ───────────────────────────────────────────────

    // deadline at exactly now + MAX_DEADLINE_HORIZON: MUST succeed
    function test_Bounds_DeadlineAtHorizon_Succeeds() public {
        uint64 horizon  = escrow.MAX_DEADLINE_HORIZON();
        uint64 deadline = uint64(block.timestamp) + horizon;

        vm.prank(buyer);
        uint256 taskId = escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);

        (, , , uint64 storedDeadline, , , ,) = escrow.tasks(taskId);
        assertEq(storedDeadline, deadline, "deadline should be stored correctly");
    }

    // deadline one second beyond the horizon: MUST revert DeadlineTooFar
    function test_Bounds_DeadlineBeyondHorizon_Reverts() public {
        uint64 horizon  = escrow.MAX_DEADLINE_HORIZON();
        uint64 deadline = uint64(block.timestamp) + horizon + 1;

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.DeadlineTooFar.selector);
        escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);
    }

    // ── double submitDelivery on same task ────────────────────────────────────

    // Second submitDelivery on the same task reverts NotFunded (status is now Delivered)
    function test_DoubleSubmit_RevertsNotFunded() public {
        (uint256 taskId,) = _createStandard();

        vm.prank(provider);
        escrow.submitDelivery(taskId, keccak256("first-proof"));

        vm.prank(provider);
        vm.expectRevert(TaskEscrow.NotFunded.selector);
        escrow.submitDelivery(taskId, keccak256("second-proof"));
    }

    // ── reject on wrong task status ───────────────────────────────────────────

    // reject on a Disputed task: MUST revert NotDelivered
    function test_Reject_OnDisputedTask_Reverts() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(buyer);
        escrow.reject(taskId); // → Disputed

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.NotDelivered.selector);
        escrow.reject(taskId); // second reject must revert
    }

    // reject on a Settled task: MUST revert NotDelivered
    function test_Reject_OnSettledTask_Reverts() public {
        (uint256 taskId,) = _createAndDeliver();

        vm.prank(buyer);
        escrow.accept(taskId); // → Settled

        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.NotDelivered.selector);
        escrow.reject(taskId);
    }
}
