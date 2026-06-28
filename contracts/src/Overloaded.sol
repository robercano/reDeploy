// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Overloaded
/// @notice Fixture contract with overloaded admin setters used to exercise reDeploy's
///         overloaded-function support (issue #47).
///
///         Roles:
///           - DEFAULT_ADMIN_ROLE: granted to `admin` at construction; required to call either
///             variant of `setLimit`.
///
///         Overloads:
///           - setLimit(uint256)           — sets `limit` only; emits LimitSet(uint256).
///           - setLimit(uint256,address)   — sets both `limit` and `beneficiary`;
///                                           emits LimitWithBeneficiarySet(uint256,address).
contract Overloaded is AccessControl {
    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------

    /// @dev Thrown by admin-gated functions when the caller lacks DEFAULT_ADMIN_ROLE.
    error NotAdmin(address caller);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice The current limit value (last set by either overload of setLimit).
    uint256 public limit;

    /// @notice The beneficiary address (set only by the two-argument overload of setLimit).
    address public beneficiary;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event LimitSet(uint256 limit);
    event LimitWithBeneficiarySet(uint256 limit, address beneficiary);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param admin Address to receive DEFAULT_ADMIN_ROLE (typically the deployer).
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // -------------------------------------------------------------------------
    // Admin functions — overloaded setLimit
    // -------------------------------------------------------------------------

    /// @notice Set the limit only.
    /// @dev Only callable by DEFAULT_ADMIN_ROLE. Reverts with {NotAdmin} otherwise.
    /// @param limit_ New limit value.
    function setLimit(uint256 limit_) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        limit = limit_;
        emit LimitSet(limit_);
    }

    /// @notice Set the limit and a beneficiary address.
    /// @dev Only callable by DEFAULT_ADMIN_ROLE. Reverts with {NotAdmin} otherwise.
    /// @param limit_       New limit value.
    /// @param beneficiary_ Address of the beneficiary.
    function setLimit(uint256 limit_, address beneficiary_) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        limit = limit_;
        beneficiary = beneficiary_;
        emit LimitWithBeneficiarySet(limit_, beneficiary_);
    }
}
