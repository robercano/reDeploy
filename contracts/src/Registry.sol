// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Registry
/// @notice Admin-gated name→address registry used as a post-deployment wiring fixture
///         for reDeploy's tests.
///
///         Roles:
///           - DEFAULT_ADMIN_ROLE: granted to deployer; required to call `register`.
///
///         Dependency direction: no constructor dependencies on other fixtures;
///         it is wired *into* Vault post-deployment via Vault.setRegistry().
contract Registry is AccessControl {
    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------

    /// @dev Thrown by admin-gated functions when the caller lacks DEFAULT_ADMIN_ROLE.
    error NotAdmin(address caller);

    /// @dev Thrown when a zero address is registered for a key.
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    mapping(bytes32 => address) private _entries;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Registered(bytes32 indexed key, address indexed addr);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param admin Address to receive DEFAULT_ADMIN_ROLE (typically the deployer).
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // -------------------------------------------------------------------------
    // Admin functions
    // -------------------------------------------------------------------------

    /// @notice Register `addr` under `key`.
    /// @dev Only callable by DEFAULT_ADMIN_ROLE. Reverts with {NotAdmin} otherwise.
    function register(string calldata key, address addr) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (addr == address(0)) revert ZeroAddress();
        _entries[_hash(key)] = addr;
        emit Registered(_hash(key), addr);
    }

    // -------------------------------------------------------------------------
    // Read-only
    // -------------------------------------------------------------------------

    /// @notice Resolve `key` to its registered address, or address(0) if not registered.
    function lookup(string calldata key) external view returns (address) {
        return _entries[_hash(key)];
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _hash(string calldata key) private pure returns (bytes32) {
        return keccak256(bytes(key));
    }
}
