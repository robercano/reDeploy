// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Registry} from "../src/Registry.sol";

/// @dev forge-std-free test so the skeleton compiles and passes with no
///      network install. Migrate to forge-std `Test` in the contracts ticket.
contract RegistryTest {
    Registry private registry;

    function setUp() public {
        registry = new Registry();
    }

    function test_RegisterAndLookup() public {
        registry.register("token", address(0xBEEF));
        require(registry.lookup("token") == address(0xBEEF), "lookup mismatch");
    }

    function test_UnknownReturnsZero() public view {
        require(registry.lookup("missing") == address(0), "expected zero address");
    }
}
