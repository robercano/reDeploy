// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Registry} from "../src/Registry.sol";

contract RegistryTest is Test {
    Registry private registry;
    address private admin = address(0xA0);
    address private nonAdmin = address(0xB0);

    function setUp() public {
        vm.label(admin, "admin");
        vm.label(nonAdmin, "nonAdmin");
        registry = new Registry(admin);
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    function test_ConstructorGrantsAdminRole() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_ConstructorDoesNotGrantRoleToOthers() public view {
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), nonAdmin));
    }

    // ------------------------------------------------------------------
    // register — happy path
    // ------------------------------------------------------------------

    function test_RegisterAndLookup() public {
        address token = address(0xBEEF);
        vm.prank(admin);
        registry.register("token", token);
        assertEq(registry.lookup("token"), token);
    }

    function test_RegisterEmitsEvent() public {
        address token = address(0xBEEF);
        bytes32 key = keccak256(bytes("token"));
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit Registry.Registered(key, token);
        registry.register("token", token);
    }

    function test_RegisterOverwritesPreviousEntry() public {
        address first = address(0x1);
        address second = address(0x2);
        vm.startPrank(admin);
        registry.register("vault", first);
        registry.register("vault", second);
        vm.stopPrank();
        assertEq(registry.lookup("vault"), second);
    }

    // ------------------------------------------------------------------
    // register — access control (negative)
    // ------------------------------------------------------------------

    function test_RegisterRevertsForNonAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Registry.NotAdmin.selector, nonAdmin));
        registry.register("token", address(0xBEEF));
    }

    // ------------------------------------------------------------------
    // register — zero address guard
    // ------------------------------------------------------------------

    function test_RegisterRevertsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(Registry.ZeroAddress.selector);
        registry.register("zero", address(0));
    }

    // ------------------------------------------------------------------
    // lookup — not registered
    // ------------------------------------------------------------------

    function test_UnknownKeyReturnsZero() public view {
        assertEq(registry.lookup("missing"), address(0));
    }
}
