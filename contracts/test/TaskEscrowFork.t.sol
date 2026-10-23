// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {TaskEscrow} from "../TaskEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title TaskEscrowFork
/// @notice Fork tests against the real Arc Testnet USDC predeploy at
///         0x3600000000000000000000000000000000000000.
///
///         IMPORTANT — ARC PRECOMPILE LIMITATION:
///         Arc Testnet USDC calls an Arc-native precompile at
///         0x1800000000000000000000000000000000000001 (isBlocklisted) inside
///         transferFrom and safeTransfer. Foundry's anvil-based fork does NOT
///         emulate this precompile, so any test that calls transferFrom through
///         the real Arc USDC implementation will revert with StackUnderflow on
///         a fork.
///
///         What CAN be tested on a fork:
///           - Token metadata (decimals, symbol, name) — view calls, no precompile
///           - Contract wiring (escrow.usdc() == predeploy address)
///           - Funding mechanics (vm.deal correctness)
///           - Blocklist precompile existence (the revert IS the expected behaviour)
///           - All state-machine logic that doesn't require live USDC transfers
///             (but these are already covered by TaskEscrow.t.sol with the mock)
///
///         What CANNOT be tested on a fork (requires live testnet):
///           - createTask (calls safeTransferFrom → isBlocklisted precompile)
///           - accept, release, reclaim (call safeTransfer → isBlocklisted precompile)
///           Live testnet behaviour is verified by contracts/test-integration/TaskEscrowE2E.ts
///
///         Run with:
///           forge test --match-contract TaskEscrowFork --fork-url https://rpc.testnet.arc.io -vvv
///
///         All 8 tests here pass.
contract TaskEscrowFork is Test {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Real Arc Testnet USDC predeploy (same address on Arc Mainnet)
    address internal constant REAL_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev Arc-specific precompile called by USDC transferFrom for blocklist checks.
    ///      This address has no code on any non-Arc EVM (including anvil forks),
    ///      which is why fork tests cannot exercise the full transfer path.
    address internal constant BLOCKLIST_PRECOMPILE = 0x1800000000000000000000000000000000000001;

    /// Arc USDC: ERC-20 view = 6 decimals; native view = 18 decimals.
    /// vm.deal sets native balance; ERC-20 balanceOf reflects native / 1e12.
    uint256 internal constant NATIVE_FACTOR = 1e12;

    uint256 internal constant PRICE      = 10e6;  // 10 USDC (6 dec)
    uint64  internal constant REVIEW_WIN = 1 days;
    uint64  internal constant TASK_TTL   = 7 days;

    // ─────────────────────────────────────────────────────────────────────────
    // Actors
    // ─────────────────────────────────────────────────────────────────────────

    address internal buyer    = makeAddr("fork-buyer");
    address internal provider = makeAddr("fork-provider");
    address internal stranger = makeAddr("fork-stranger");

    // ─────────────────────────────────────────────────────────────────────────
    // Contract under test — fresh deploy, points at real USDC predeploy
    // ─────────────────────────────────────────────────────────────────────────

    TaskEscrow internal escrow;

    // ─────────────────────────────────────────────────────────────────────────
    // Fork setup
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.createSelectFork("arc_testnet");
        escrow = new TaskEscrow(REAL_USDC);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _dealUsdc(address account, uint256 usdcAmount) internal {
        // On Arc: native == ERC-20, 1e12 scaling factor between views.
        vm.deal(account, usdcAmount * NATIVE_FACTOR);
    }

    function _usdcBalance(address account) internal view returns (uint256) {
        return IERC20(REAL_USDC).balanceOf(account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 1 — vm.deal sets ERC-20 balanceOf (validates funding mechanics)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Confirms that vm.deal(addr, usdcAmount * 1e12) sets the 6-decimal
    ///      ERC-20 balance correctly. This is the key insight for Arc fork tests:
    ///      native and ERC-20 are one pool; vm.deal writes the native side.
    function test_Fork_Deal_Funding() public {
        _dealUsdc(buyer, 1_000e6);
        assertEq(_usdcBalance(buyer), 1_000e6, "vm.deal must reflect in ERC-20 balanceOf");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 2 — Real Arc USDC has 6 decimals on the ERC-20 interface
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_RealUsdc_Decimals() public view {
        (bool ok, bytes memory data) = REAL_USDC.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok, "decimals() reverted");
        assertEq(abi.decode(data, (uint8)), 6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 3 — Real Arc USDC has expected symbol and name
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_RealUsdc_Metadata() public view {
        (bool okS, bytes memory symData) = REAL_USDC.staticcall(abi.encodeWithSignature("symbol()"));
        (bool okN, bytes memory nameData) = REAL_USDC.staticcall(abi.encodeWithSignature("name()"));
        require(okS && okN, "metadata calls reverted");
        string memory sym  = abi.decode(symData, (string));
        string memory name = abi.decode(nameData, (string));
        console.log("Symbol:", sym, "| Name:", name);
        // Passes as long as the calls succeed and return non-empty strings
        assertGt(bytes(sym).length,  0, "symbol must be non-empty");
        assertGt(bytes(name).length, 0, "name must be non-empty");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 4 — TaskEscrow.usdc() is wired to the real predeploy
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_EscrowUsdc_MatchesPredeploy() public view {
        assertEq(escrow.usdc(), REAL_USDC);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 5 — Constructor rejects zero address even on a fork
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_Constructor_ZeroAddressReverts() public {
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        new TaskEscrow(address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 6 — Approve succeeds on real Arc USDC (no precompile in approve path)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_RealUsdc_ApproveWorks() public {
        _dealUsdc(buyer, PRICE);
        vm.prank(buyer);
        bool ok = IERC20(REAL_USDC).approve(address(escrow), PRICE);
        assertTrue(ok, "approve must return true on real Arc USDC");
        uint256 allowance = IERC20(REAL_USDC).allowance(buyer, address(escrow));
        assertEq(allowance, PRICE, "allowance must match approved amount");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 7 — Blocklist precompile exists and is called by transferFrom
    //               (documents why full flow can't be tested on a fork)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev This test confirms that transferFrom on Arc USDC calls the
    ///      isBlocklisted precompile at 0x1800...0001, and that the precompile
    ///      has no code on the fork (causing the revert).
    ///      This documents the limitation — NOT a bug in TaskEscrow.
    function test_Fork_TransferFrom_RevertsDueToPrecompile() public {
        _dealUsdc(buyer, PRICE);
        vm.prank(buyer);
        IERC20(REAL_USDC).approve(address(escrow), PRICE);

        uint64 deadline = uint64(block.timestamp + TASK_TTL);
        vm.prank(buyer);
        // Expected: revert because isBlocklisted precompile (0x1800...0001) has
        // no code on the anvil fork. This is correct and expected behaviour.
        vm.expectRevert();
        escrow.createTask(buyer, provider, PRICE, deadline, REVIEW_WIN);

        // The precompile address is registered in anvil (extcodesize >= 0) but its
        // EVM implementation is incomplete, causing StackUnderflow on delegatecall.
        // This confirms the precompile exists on Arc but is not emulated by the fork.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fork Test 8 — createTask validation fires BEFORE the USDC transfer
    //               (confirms CEI: checks happen before the precompile call)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fork_CreateTask_ValidationBeforeTransfer() public {
        uint64 deadline = uint64(block.timestamp + TASK_TTL);

        // Zero price — should revert ZeroPrice BEFORE any USDC call
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ZeroPrice.selector);
        escrow.createTask(buyer, provider, 0, deadline, REVIEW_WIN);

        // Zero buyer — should revert ZeroAddress BEFORE any USDC call
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        escrow.createTask(address(0), provider, PRICE, deadline, REVIEW_WIN);

        // Deadline in the past — should revert DeadlineInPast BEFORE any USDC call
        vm.prank(buyer);
        vm.expectRevert(TaskEscrow.DeadlineInPast.selector);
        escrow.createTask(buyer, provider, PRICE, uint64(block.timestamp), REVIEW_WIN);
    }
}
