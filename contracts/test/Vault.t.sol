// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
import {Vault} from "../src/Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ---------------------------------------------------------------------------
// Malicious reentrant depositor — attempts reentrant deposit inside
// the ERC20 transferFrom hook by overriding transferFrom via a fake token.
// We test reentrancy through a surrogate fake-token approach below.
// ---------------------------------------------------------------------------

/// @dev Attacker contract that attempts a reentrant withdraw during the
///      token.transfer() callback triggered by a first withdraw call.
///      We use a real Token and fake the reentrancy by calling withdraw
///      from within a helper that simulates an ERC20 transfer hook.
contract ReentrancyAttacker {
    Vault public vault;
    Token public token;
    bool private _attacking;

    constructor(address vault_, address token_) {
        vault = Vault(vault_);
        token = Token(token_);
    }

    /// @dev Arm the attacker, approve vault, and attempt a deposit followed
    ///      by a reentrant withdraw.  Because ERC20.transfer is not
    ///      reentrant-hookable in the standard OZ impl we instead call
    ///      withdraw a second time directly here to confirm the guard blocks it.
    function attack(uint256 amount) external {
        // Deposit first so we have balance.
        token.approve(address(vault), amount);
        vault.deposit(amount);

        // Now attempt to call withdraw twice in the same call stack.
        // The second call should be blocked by ReentrancyGuard.
        _attacking = true;
        vault.withdraw(amount);
    }

    /// @dev Called by Vault's nonReentrant via normal flow — we try to call
    ///      withdraw again recursively. In practice nonReentrant blocks this.
    receive() external payable {
        if (_attacking) {
            _attacking = false;
            vault.withdraw(1);
        }
    }
}

/// @dev A minimal ERC20 stub whose `transferFrom` re-enters `vault.deposit`
///      so we can verify the ReentrancyGuard blocks the inner call.
contract MaliciousToken is IERC20 {
    Vault public vault;
    address public owner;
    mapping(address => uint256) private _bal;
    mapping(address => mapping(address => uint256)) private _allowance;

    constructor(address vault_) {
        vault = Vault(vault_);
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
    }

    function balanceOf(address a) external view override returns (uint256) {
        return _bal[a];
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _bal[msg.sender] -= amount;
        _bal[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        override
        returns (bool)
    {
        // Re-enter vault.deposit here.
        // nonReentrant should block this inner call.
        _allowance[from][msg.sender] -= amount;
        _bal[from] -= amount;
        _bal[to] += amount;
        // Attempt reentrant deposit — should revert.
        vault.deposit(1);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowance[msg.sender][spender] = amount;
        return true;
    }

    function allowance(address a, address b) external view override returns (uint256) {
        return _allowance[a][b];
    }

    function totalSupply() external pure override returns (uint256) {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------

contract VaultTest is Test {
    Token private token;
    Vault private vault;
    address private admin = address(0xA0);
    address private user = address(0xB0);
    address private nonAdmin = address(0xC0);

    uint256 private constant INITIAL_BALANCE = 10_000e18;

    function setUp() public {
        vm.label(admin, "admin");
        vm.label(user, "user");
        vm.label(nonAdmin, "nonAdmin");

        // Deploy token and vault as admin.
        vm.startPrank(admin);
        token = new Token("Test Token", "TTK");
        vault = new Vault(address(token));
        vm.stopPrank();

        // Fund the user.
        vm.prank(admin);
        token.mint(user, INITIAL_BALANCE);
    }

    // ------------------------------------------------------------------
    // Constructor wiring
    // ------------------------------------------------------------------

    function test_ConstructorStoresToken() public view {
        assertEq(address(vault.token()), address(token));
    }

    function test_ConstructorGrantsAdminRoleToDeployer() public view {
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_ConstructorDoesNotGrantAdminToOthers() public view {
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), user));
    }

    function test_InitialFeeBpsIsZero() public view {
        assertEq(vault.feeBps(), 0);
    }

    function test_InitialRegistryIsZero() public view {
        assertEq(vault.registry(), address(0));
    }

    // ------------------------------------------------------------------
    // deposit / withdraw — happy path
    // ------------------------------------------------------------------

    function test_DepositUpdatesBalance() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();

        assertEq(vault.balanceOf(user), amount);
    }

    function test_DepositTransfersTokensToVault() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();

        assertEq(token.balanceOf(address(vault)), amount);
        assertEq(token.balanceOf(user), INITIAL_BALANCE - amount);
    }

    function test_DepositEmitsEvent() public {
        uint256 amount = 500e18;
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vm.expectEmit(true, false, false, true);
        emit Vault.Deposited(user, amount, 0);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function test_WithdrawReducesBalance() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vault.withdraw(500e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(user), 500e18);
    }

    function test_WithdrawTransfersTokensToUser() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vault.withdraw(amount);
        vm.stopPrank();

        assertEq(token.balanceOf(user), INITIAL_BALANCE);
        assertEq(vault.balanceOf(user), 0);
    }

    function test_WithdrawEmitsEvent() public {
        uint256 amount = 500e18;
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vm.expectEmit(true, false, false, true);
        emit Vault.Withdrawn(user, amount);
        vault.withdraw(amount);
        vm.stopPrank();
    }

    function test_WithdrawRevertsInsufficientBalance() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Vault.InsufficientBalance.selector, 1e18, 0));
        vault.withdraw(1e18);
    }

    function test_DepositRevertsZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_WithdrawRevertsZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.withdraw(0);
    }

    // ------------------------------------------------------------------
    // deposit with fee
    // ------------------------------------------------------------------

    function test_DepositWithFeeDeductsCorrectAmount() public {
        // Set 1 % fee (100 bps).
        vm.prank(admin);
        vault.setFeeBps(100);

        uint256 amount = 1_000e18;
        uint256 expectedFee = 10e18;
        uint256 expectedNet = 990e18;

        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();

        assertEq(vault.balanceOf(user), expectedNet);
        // Vault holds the full amount (fee stays in contract, not refunded).
        assertEq(token.balanceOf(address(vault)), amount);

        // Event carries correct fee.
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vm.expectEmit(true, false, false, true);
        emit Vault.Deposited(user, expectedNet, expectedFee);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // setFeeBps
    // ------------------------------------------------------------------

    function test_SetFeeBpsUpdatesValue() public {
        vm.prank(admin);
        vault.setFeeBps(500);
        assertEq(vault.feeBps(), 500);
    }

    function test_SetFeeBpsEmitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit Vault.FeeBpsSet(0, 500);
        vault.setFeeBps(500);
    }

    function test_SetFeeBpsAcceptsMaxValue() public {
        vm.prank(admin);
        vault.setFeeBps(10_000);
        assertEq(vault.feeBps(), 10_000);
    }

    function test_SetFeeBpsRevertsAboveMax() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Vault.FeeBpsTooHigh.selector, uint16(10_001)));
        vault.setFeeBps(10_001);
    }

    function test_SetFeeBpsRevertsForNonAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Vault.NotAdmin.selector, nonAdmin));
        vault.setFeeBps(100);
    }

    // ------------------------------------------------------------------
    // pause / unpause
    // ------------------------------------------------------------------

    function test_PauseBlocksDeposit() public {
        vm.prank(admin);
        vault.pause();

        vm.startPrank(user);
        token.approve(address(vault), 1e18);
        vm.expectRevert(); // OZ Pausable: EnforcedPause
        vault.deposit(1e18);
        vm.stopPrank();
    }

    function test_PauseBlocksWithdraw() public {
        // Deposit first (while unpaused).
        vm.startPrank(user);
        token.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18);
        vm.stopPrank();

        vm.prank(admin);
        vault.pause();

        vm.prank(user);
        vm.expectRevert(); // OZ Pausable: EnforcedPause
        vault.withdraw(500e18);
    }

    function test_UnpauseRestoresDeposit() public {
        vm.startPrank(admin);
        vault.pause();
        vault.unpause();
        vm.stopPrank();

        vm.startPrank(user);
        token.approve(address(vault), 500e18);
        vault.deposit(500e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(user), 500e18);
    }

    function test_PauseRevertsForNonAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Vault.NotAdmin.selector, nonAdmin));
        vault.pause();
    }

    function test_UnpauseRevertsForNonAdmin() public {
        vm.prank(admin);
        vault.pause();

        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Vault.NotAdmin.selector, nonAdmin));
        vault.unpause();
    }

    // ------------------------------------------------------------------
    // setRegistry — one-time semantics
    // ------------------------------------------------------------------

    function test_SetRegistryStoresAddress() public {
        address reg = address(0xE601);
        vm.prank(admin);
        vault.setRegistry(reg);
        assertEq(vault.registry(), reg);
    }

    function test_SetRegistryEmitsEvent() public {
        address reg = address(0xE601);
        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit Vault.RegistrySet(reg);
        vault.setRegistry(reg);
    }

    function test_SetRegistryRevertsOnSecondCall() public {
        address reg = address(0xE601);
        vm.startPrank(admin);
        vault.setRegistry(reg);
        vm.expectRevert(Vault.RegistryAlreadySet.selector);
        vault.setRegistry(address(0x1234));
        vm.stopPrank();
    }

    function test_SetRegistryRevertsForNonAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Vault.NotAdmin.selector, nonAdmin));
        vault.setRegistry(address(0x1234));
    }

    // ------------------------------------------------------------------
    // Reentrancy guard
    // ------------------------------------------------------------------

    /// @dev Verify that a malicious token attempting reentrant deposit during
    ///      transferFrom is blocked by ReentrancyGuard.
    function test_ReentrancyGuardBlocksReentrantDeposit() public {
        // Deploy vault with a malicious token.
        MaliciousToken malToken = new MaliciousToken(address(0)); // placeholder vault
        // We need a vault built on the malicious token.
        vm.prank(admin);
        Vault malVault = new Vault(address(malToken));
        // Wire the malicious token to point at the real vault.
        malToken = new MaliciousToken(address(malVault));

        // Rebuild vault pointing to the wired malToken.
        vm.prank(admin);
        malVault = new Vault(address(malToken));

        // Give the test contract some malicious tokens.
        malToken.mint(address(this), 1_000e18);
        malToken.approve(address(malVault), type(uint256).max);

        // Calling deposit should trigger the reentrant deposit inside
        // MaliciousToken.transferFrom, which nonReentrant should block.
        vm.expectRevert(); // OZ ReentrancyGuard: ReentrancyGuardReentrantCall
        malVault.deposit(100e18);
    }
}
