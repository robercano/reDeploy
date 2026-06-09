// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Registry
/// @notice Minimal name->address registry used as a deployment/wiring fixture
///         for reDeploy's tests. Real fixtures land with the contracts ticket.
contract Registry {
    mapping(bytes32 => address) private _entries;

    event Registered(bytes32 indexed key, address indexed addr);

    function register(string calldata key, address addr) external {
        _entries[_hash(key)] = addr;
        emit Registered(_hash(key), addr);
    }

    function lookup(string calldata key) external view returns (address) {
        return _entries[_hash(key)];
    }

    function _hash(string calldata key) private pure returns (bytes32) {
        return keccak256(bytes(key));
    }
}
