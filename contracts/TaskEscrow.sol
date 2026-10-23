// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TaskEscrow
/// @notice USDC-only task escrow for Arc EVM chains with no admin roles.
/// @dev Funds are escrowed in USDC, provider submits delivery proof, buyer can accept/reject within a review window,
///      release is automatic after the review window via `release`, and reclaim is possible if delivery never happens.
///      This contract has no owner/admin and no fallback recipient.
///      Known limitation: if the intended payout/refund recipient is USDC-blacklisted at transfer time,
///      SafeERC20 transfer reverts and funds remain locked in this v1 design.
contract TaskEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum TaskStatus {
        Funded,
        Delivered,
        Settled,
        Reclaimed,
        Disputed
    }

    struct Task {
        address buyer;
        address provider;
        uint256 price;
        uint64 deadline;
        uint64 reviewWindow;
        uint64 deliveredAt;
        TaskStatus status;
        bytes32 deliveryHash;
    }

    /// @dev Maximum allowed review window: 30 days in seconds.
    uint64 public constant MAX_REVIEW_WINDOW   = 30 days;
    /// @dev Maximum allowed deadline horizon from the current block: 365 days in seconds.
    uint64 public constant MAX_DEADLINE_HORIZON = 365 days;

    error ZeroAddress();
    error ZeroPrice();
    error DeadlineInPast();
    error DeadlineTooFar();
    error ZeroReviewWindow();
    error ReviewWindowTooLong();
    error BuyerProviderSame();
    error NotBuyer();
    error NotProvider();
    error NotFunded();
    error NotDelivered();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ReviewWindowExpired();
    error ReviewWindowNotExpired();

    event TaskCreated(
        uint256 indexed taskId,
        address indexed buyer,
        address indexed provider,
        uint256 price,
        uint64 deadline,
        uint64 reviewWindow
    );
    event DeliverySubmitted(uint256 indexed taskId, bytes32 deliveryHash);
    event TaskSettled(uint256 indexed taskId, address indexed provider, uint256 price);
    event TaskReclaimed(uint256 indexed taskId, address indexed buyer, uint256 price);
    event TaskDisputed(uint256 indexed taskId);

    uint256 public taskCount;
    mapping(uint256 => Task) public tasks;
    address public immutable usdc;

    /// @notice Creates and funds a new task escrow in USDC.
    /// @dev The named buyer (`buyer`) can differ from `msg.sender` (third-party funding / auction-contract pattern).
    ///      USDC is always pulled from `msg.sender`; the named buyer is never charged by this function.
    /// @param buyer The address that gets buyer rights (accept/reject/reclaim) and receives reclaim refunds.
    /// @param provider The address that can submit delivery and receive payment on settlement.
    /// @param price The USDC escrow amount (6 decimals on Arc USDC).
    /// @param deadline Unix timestamp by which provider must submit delivery (inclusive).
    /// @param reviewWindow Number of seconds buyer has after delivery to accept or reject.
    /// @return taskId The id of the newly created task.
    function createTask(
        address buyer,
        address provider,
        uint256 price,
        uint64 deadline,
        uint64 reviewWindow
    ) external nonReentrant returns (uint256 taskId) {
        if (buyer == address(0) || provider == address(0)) revert ZeroAddress();
        if (price == 0) revert ZeroPrice();
        if (deadline <= block.timestamp) revert DeadlineInPast();
        // deadline must not exceed MAX_DEADLINE_HORIZON seconds from now.
        // Cast block.timestamp to uint64 safely: timestamps fit in uint64 until year 584 billion.
        if (deadline > uint64(block.timestamp) + MAX_DEADLINE_HORIZON) revert DeadlineTooFar();
        if (reviewWindow == 0) revert ZeroReviewWindow();
        if (reviewWindow > MAX_REVIEW_WINDOW) revert ReviewWindowTooLong();
        if (buyer == provider) revert BuyerProviderSame();

        taskId = taskCount;

        tasks[taskId] = Task({
            buyer: buyer,
            provider: provider,
            price: price,
            deadline: deadline,
            reviewWindow: reviewWindow,
            deliveredAt: 0,
            status: TaskStatus.Funded,
            deliveryHash: bytes32(0)
        });

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), price);

        emit TaskCreated(taskId, buyer, provider, price, deadline, reviewWindow);

        // Safety: taskCount is uint256; reaching 2**256 tasks is physically impossible.
        // The increment is safe to leave unchecked to save a small amount of gas.
        unchecked {
            taskCount = taskId + 1;
        }
    }

    /// @notice Submits delivery proof for a funded task.
    /// @param taskId The task id.
    /// @param deliveryHash Off-chain delivery content identifier hash.
    function submitDelivery(uint256 taskId, bytes32 deliveryHash) external {
        Task storage task = tasks[taskId];

        if (msg.sender != task.provider) revert NotProvider();
        if (task.status != TaskStatus.Funded) revert NotFunded();
        if (block.timestamp > task.deadline) revert DeadlinePassed();

        task.status = TaskStatus.Delivered;
        task.deliveredAt = uint64(block.timestamp);
        task.deliveryHash = deliveryHash;

        emit DeliverySubmitted(taskId, deliveryHash);
    }

    /// @notice Buyer accepts delivery and settles escrow to provider.
    /// @param taskId The task id.
    function accept(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        if (msg.sender != task.buyer) revert NotBuyer();
        if (task.status != TaskStatus.Delivered) revert NotDelivered();

        // Overflow-safe: both operands are uint64 widened to uint256 before addition.
        // reviewWindow <= MAX_REVIEW_WINDOW (30 days), so the sum stays well within uint256.
        uint256 reviewDeadline = uint256(task.deliveredAt) + uint256(task.reviewWindow);
        if (block.timestamp > reviewDeadline) revert ReviewWindowExpired();

        task.status = TaskStatus.Settled;

        IERC20(usdc).safeTransfer(task.provider, task.price);

        emit TaskSettled(taskId, task.provider, task.price);
    }

    /// @notice Releases escrow to provider after buyer review window expires.
    /// @param taskId The task id.
    function release(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        if (task.status != TaskStatus.Delivered) revert NotDelivered();

        // Overflow-safe: same reasoning as in accept() above.
        uint256 reviewDeadline = uint256(task.deliveredAt) + uint256(task.reviewWindow);
        if (block.timestamp <= reviewDeadline) revert ReviewWindowNotExpired();

        task.status = TaskStatus.Settled;

        IERC20(usdc).safeTransfer(task.provider, task.price);

        emit TaskSettled(taskId, task.provider, task.price);
    }

    /// @notice Buyer reclaims funds if provider did not deliver before deadline.
    /// @dev Refund is sent to the stored `tasks[taskId].buyer` address, not to `msg.sender`.
    /// @param taskId The task id.
    function reclaim(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        if (msg.sender != task.buyer) revert NotBuyer();
        if (task.status != TaskStatus.Funded) revert NotFunded();
        if (block.timestamp <= task.deadline) revert DeadlineNotPassed();

        task.status = TaskStatus.Reclaimed;

        IERC20(usdc).safeTransfer(tasks[taskId].buyer, task.price);

        emit TaskReclaimed(taskId, tasks[taskId].buyer, task.price);
    }

    /// @notice Buyer rejects delivery within the review window, marking the task as disputed.
    /// @dev In this v1 design, disputed funds are permanently locked with no on-chain resolution path.
    /// @param taskId The task id.
    function reject(uint256 taskId) external {
        Task storage task = tasks[taskId];

        if (msg.sender != task.buyer) revert NotBuyer();
        if (task.status != TaskStatus.Delivered) revert NotDelivered();

        // Overflow-safe: same reasoning as in accept() above.
        uint256 reviewDeadline = uint256(task.deliveredAt) + uint256(task.reviewWindow);
        if (block.timestamp > reviewDeadline) revert ReviewWindowExpired();

        task.status = TaskStatus.Disputed;

        emit TaskDisputed(taskId);
    }

    /// @notice Sets the USDC token address used by escrow.
    /// @param usdc_ The USDC token address.
    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }
}
