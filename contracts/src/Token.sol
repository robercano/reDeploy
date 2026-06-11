// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Token
/// @notice ERC20 fixture contract with role-based minting used for reDeploy tests.
///         Dependency direction: leaf — no constructor dependencies on other fixtures.
///
///         Roles:
///           - DEFAULT_ADMIN_ROLE: granted to deployer; can grant/revoke other roles.
///           - MINTER_ROLE: required to call `mint`; also granted to deployer for fixture
///             convenience (allows the deployer to seed balances without a separate step).
contract Token is ERC20, AccessControl {
    /// @notice Role identifier for accounts authorised to mint new tokens.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev Thrown when `mint` is called by an account without MINTER_ROLE.
    error NotMinter(address caller);

    /// @param name_   ERC20 token name.
    /// @param symbol_ ERC20 token symbol.
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    /// @notice Mint `amount` tokens to `to`.
    /// @dev Reverts with {NotMinter} if the caller lacks MINTER_ROLE.
    function mint(address to, uint256 amount) external {
        if (!hasRole(MINTER_ROLE, msg.sender)) revert NotMinter(msg.sender);
        _mint(to, amount);
    }
}
