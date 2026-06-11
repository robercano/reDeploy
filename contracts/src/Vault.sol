// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Vault
/// @notice Token-holding vault fixture for reDeploy tests.
///         Constructor dependency: requires a Token address.
///         Post-deploy circular link: setRegistry() wires the Registry back in (one-time only).
///
///         Roles:
///           - DEFAULT_ADMIN_ROLE: granted to deployer; governs setFeeBps, pause/unpause,
///             setRegistry.
///
///         Invariants:
///           - deposit / withdraw follow CEI ordering and are guarded by ReentrancyGuard.
///           - feeBps is always <= 10 000 (100 %).
///           - registry address can only be set once.
contract Vault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------

    /// @dev Thrown by admin-gated functions when the caller lacks DEFAULT_ADMIN_ROLE.
    error NotAdmin(address caller);

    /// @dev Thrown by setFeeBps when `bps` exceeds 10 000.
    error FeeBpsTooHigh(uint16 bps);

    /// @dev Thrown by setRegistry when the registry address has already been set.
    error RegistryAlreadySet();

    /// @dev Thrown by deposit/withdraw when the amount is zero.
    error ZeroAmount();

    /// @dev Thrown by withdraw when the caller has insufficient balance.
    error InsufficientBalance(uint256 requested, uint256 available);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    // solhint-disable-next-line immutable-vars-naming
    /// @notice The ERC20 token managed by this vault (set at construction, immutable).
    IERC20 public immutable token;

    /// @notice Fee charged on deposits, expressed in basis points (1 bps = 0.01 %).
    uint16 public feeBps;

    /// @notice Registry address — set once post-deployment via setRegistry().
    address public registry;

    /// @dev Per-user deposited balances (net of fees).
    mapping(address => uint256) private _balances;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Deposited(address indexed user, uint256 amount, uint256 fee);
    event Withdrawn(address indexed user, uint256 amount);
    event FeeBpsSet(uint16 oldBps, uint16 newBps);
    event RegistrySet(address indexed registry_);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param token_ Address of the ERC20 token this vault accepts.
    // solhint-disable-next-line func-visibility
    constructor(address token_) {
        token = IERC20(token_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // -------------------------------------------------------------------------
    // User-facing
    // -------------------------------------------------------------------------

    /// @notice Deposit `amount` tokens into the vault.
    ///         A fee of `feeBps` basis-points is deducted from the deposited amount.
    ///         Follows Checks-Effects-Interactions ordering.
    /// @dev Requires token allowance from the caller.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        // Checks
        if (amount == 0) revert ZeroAmount();

        // Effects
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 net = amount - fee;
        _balances[msg.sender] += net;

        // Interactions
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, net, fee);
    }

    /// @notice Withdraw `amount` tokens from the caller's vault balance.
    ///         Follows Checks-Effects-Interactions ordering.
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        // Checks
        if (amount == 0) revert ZeroAmount();
        uint256 bal = _balances[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);

        // Effects
        _balances[msg.sender] = bal - amount;

        // Interactions
        token.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Return the vault balance of `user`.
    function balanceOf(address user) external view returns (uint256) {
        return _balances[user];
    }

    // -------------------------------------------------------------------------
    // Admin functions
    // -------------------------------------------------------------------------

    /// @notice Set the fee applied to deposits.
    /// @param bps New fee in basis points; must be <= 10 000.
    function setFeeBps(uint16 bps) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (bps > 10_000) revert FeeBpsTooHigh(bps);
        emit FeeBpsSet(feeBps, bps);
        feeBps = bps;
    }

    /// @notice Pause deposit and withdraw operations.
    function pause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        _pause();
    }

    /// @notice Unpause deposit and withdraw operations.
    function unpause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        _unpause();
    }

    /// @notice Wire the Registry address (post-deploy circular link).
    ///         Can only be called ONCE; subsequent calls revert with {RegistryAlreadySet}.
    /// @param registry_ Address of the deployed Registry contract.
    function setRegistry(address registry_) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (registry != address(0)) revert RegistryAlreadySet();
        registry = registry_;
        emit RegistrySet(registry_);
    }
}
