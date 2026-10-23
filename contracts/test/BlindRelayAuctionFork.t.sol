// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BlindRelayAuction} from "../BlindRelayAuction.sol";
import {TaskEscrow} from "../TaskEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title BlindRelayAuctionFork
/// @notice Fork tests against the real Arc Testnet USDC predeploy and the real deployed TaskEscrow.
///
///         IMPORTANT — ARC PRECOMPILE LIMITATION:
///         Arc Testnet USDC calls an Arc-native precompile at
///         0x1800000000000000000000000000000000000001 (isBlocklisted) inside
///         transferFrom and safeTransfer.  Foundry's anvil-based fork does NOT
///         emulate this precompile, so any test that calls transferFrom through
///         the real Arc USDC implementation will revert with StackUnderflow.
///
///         What CAN be tested on a fork:
///           - Constructor wiring: code.length checks pass for both USDC and escrow
///           - Immutable accessors: usdc() and escrow() return correct addresses
///           - Constant values: MIN_DURATION, MAX_DURATION, MAX_BIDDERS,
///             MAX_DELIVERY_DURATION, MAX_REVIEW_WINDOW
///           - TaskEscrow.taskCount() is readable (reflects deployed state)
///           - That full USDC flows (createAuction) revert due to the Arc
///             blocklist precompile — this is the EXPECTED behaviour on a local fork
///
///         What CANNOT be tested on a fork:
///           - createAuction (calls safeTransferFrom → isBlocklisted precompile)
///           - commitBid, revealBid, finalize, withdraw (all depend on USDC transfers)
///           Full end-to-end flows are verified on the live testnet via the
///           integration test lane (separate process, Circle developer wallets).
///
///         Run with:
///           forge test --match-contract BlindRelayAuctionFork --fork-url https://rpc.testnet.arc.io -vvv
///
///         All 7 tests here pass.
contract BlindRelayAuctionFork is Test {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Real Arc Testnet USDC predeploy (proxy, same address on Arc Mainnet)
    address internal constant REAL_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev Real deployed TaskEscrow on Arc Testnet
    address internal constant REAL_ESCROW = 0xe7C20Bd2834814E160f7CEf8fD2Cfe8fC6A0f59D;

    /// @dev Arc-specific precompile called by USDC transferFrom for blocklist checks.
    ///      This address has no code on any non-Arc EVM (including anvil forks),
    ///      which is why fork tests cannot exercise the full transfer path.
    address internal constant BLOCKLIST_PRECOMPILE = 0x1800000000000000000000000000000000000001;

    // ─────────────────────────────────────────────────────────────────────────
    // Contract under test — freshly deployed on the fork
    // ─────────────────────────────────────────────────────────────────────────

    BlindRelayAuction internal auction;

    // ─────────────────────────────────────────────────────────────────────────
    // Fork setup
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        // Select Arc Testnet fork (RPC key matches foundry.toml [rpc_endpoints])
        vm.createSelectFork("arc_testnet");

        // Deploy a fresh BlindRelayAuction pointing at the real USDC and the
        // real deployed TaskEscrow.  The constructor does code.length checks on
        // both — this call proves both contracts exist on the fork.
        auction = new BlindRelayAuction(REAL_USDC, REAL_ESCROW);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 1 — Constructor passes: USDC and escrow code.length checks
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Verifies the constructor did not revert — if the deploy in setUp()
    ///      completed, both code.length checks passed.
    function test_Fork_ConstructorPasses() public view {
        assertTrue(address(auction) != address(0), "auction deployed");
        assertTrue(address(auction).code.length > 0, "auction has code");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 2 — usdc() returns the Arc USDC predeploy address
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_UsdcAccessor() public view {
        assertEq(auction.usdc(), REAL_USDC, "usdc() == REAL_USDC");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 3 — escrow() returns the real TaskEscrow address
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_EscrowAccessor() public view {
        assertEq(auction.escrow(), REAL_ESCROW, "escrow() == REAL_ESCROW");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 4 — Constants match spec
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_Constants() public view {
        assertEq(auction.MIN_DURATION(),           60,          "MIN_DURATION == 60");
        assertEq(auction.MAX_DURATION(),           7 days,      "MAX_DURATION == 7 days");
        assertEq(auction.MAX_BIDDERS(),            100,         "MAX_BIDDERS == 100");
        assertEq(auction.MIN_DELIVERY_DURATION(),  60,          "MIN_DELIVERY_DURATION == 60");
        assertEq(auction.MAX_DELIVERY_DURATION(),  365 days,    "MAX_DELIVERY_DURATION == 365 days");
        assertEq(auction.MIN_REVIEW_WINDOW(),      1,           "MIN_REVIEW_WINDOW == 1");
        assertEq(auction.MAX_REVIEW_WINDOW(),      30 days,     "MAX_REVIEW_WINDOW == 30 days");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 5 — TaskEscrow.taskCount() is readable
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev This is a view call only; it reflects whatever state the deployed
    ///      TaskEscrow has accumulated on Arc Testnet.
    function test_Fork_TaskEscrowTaskCountReadable() public view {
        TaskEscrow escrowOnFork = TaskEscrow(REAL_ESCROW);
        uint256 count = escrowOnFork.taskCount();
        // We cannot assert a specific value (deployed state may vary), but the
        // call must not revert — a non-reverting call proves the ABI is compatible.
        console.log("TaskEscrow.taskCount() on fork:", count);
        // taskCount is a uint256; any value is valid here.
        assertTrue(count >= 0, "taskCount readable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 6 — USDC view calls work (metadata)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_UsdcViewCallsWork() public view {
        // ERC-20 view calls don't hit the blocklist precompile
        uint8 dec = IERC20Metadata(REAL_USDC).decimals();
        assertEq(dec, 6, "Arc USDC has 6 decimals");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 7 — Full USDC flow reverts due to Arc blocklist precompile
    //
    //   EXPECTED BEHAVIOUR ON A LOCAL FORK:
    //   createAuction calls IERC20(REAL_USDC).safeTransferFrom(...) which
    //   internally calls the Arc blocklist precompile at
    //   0x1800000000000000000000000000000000000001.  anvil does not emulate
    //   this precompile (no code at that address), so the call reverts.
    //   This test documents and asserts that known limitation.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Documents that USDC safeTransferFrom reverts on an anvil fork
    ///      due to the missing Arc blocklist precompile.
    function test_Fork_UsdcTransferRevertsOnForkDueToPrecompile() public {
        address forkBuyer = makeAddr("fork-buyer");
        // Deal native balance so Arc ERC-20 view shows a non-zero balance
        // (Arc: native == ERC-20, 1e12 scaling factor)
        vm.deal(forkBuyer, 1_000e6 * 1e12);

        vm.prank(forkBuyer);
        IERC20(REAL_USDC).approve(address(auction), type(uint256).max);

        // createAuction calls safeTransferFrom → isBlocklisted precompile → revert
        // This is the EXPECTED outcome on a local fork; live testnet works correctly.
        vm.prank(forkBuyer);
        vm.expectRevert(); // precompile missing → revert (no specific selector available)
        auction.createAuction(
            1_000e6,
            1 hours,
            1 hours,
            50e6,
            7 days,
            1 days,
            keccak256("fork task")
        );
    }
}
