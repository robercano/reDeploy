// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Overloaded} from "../src/Overloaded.sol";

contract OverloadedTest is Test {
    Overloaded private overloaded;
    address private admin = address(0xA0);
    address private nonAdmin = address(0xB0);
    address private beneficiary = address(0xC0);

    function setUp() public {
        vm.label(admin, "admin");
        vm.label(nonAdmin, "nonAdmin");
        vm.label(beneficiary, "beneficiary");
        overloaded = new Overloaded(admin);
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    function test_ConstructorGrantsAdminRole() public view {
        assertTrue(overloaded.hasRole(overloaded.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_ConstructorDoesNotGrantRoleToOthers() public view {
        assertFalse(overloaded.hasRole(overloaded.DEFAULT_ADMIN_ROLE(), nonAdmin));
    }

    function test_InitialLimitIsZero() public view {
        assertEq(overloaded.limit(), 0);
    }

    function test_InitialBeneficiaryIsZeroAddress() public view {
        assertEq(overloaded.beneficiary(), address(0));
    }

    // ------------------------------------------------------------------
    // setLimit(uint256) — happy path
    // ------------------------------------------------------------------

    function test_SetLimitUint256_SetsLimit() public {
        vm.prank(admin);
        overloaded.setLimit(uint256(42));
        assertEq(overloaded.limit(), 42);
    }

    function test_SetLimitUint256_DoesNotChangeBeneficiary() public {
        vm.prank(admin);
        overloaded.setLimit(uint256(100));
        assertEq(overloaded.beneficiary(), address(0));
    }

    function test_SetLimitUint256_EmitsLimitSet() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit Overloaded.LimitSet(99);
        overloaded.setLimit(uint256(99));
    }

    // ------------------------------------------------------------------
    // setLimit(uint256,address) — happy path
    // ------------------------------------------------------------------

    function test_SetLimitUint256Address_SetsBothFields() public {
        vm.prank(admin);
        overloaded.setLimit(uint256(500), beneficiary);
        assertEq(overloaded.limit(), 500);
        assertEq(overloaded.beneficiary(), beneficiary);
    }

    function test_SetLimitUint256Address_EmitsLimitWithBeneficiarySet() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit Overloaded.LimitWithBeneficiarySet(500, beneficiary);
        overloaded.setLimit(uint256(500), beneficiary);
    }

    // ------------------------------------------------------------------
    // Overloads are DISTINCT: calling the single-arg overload does NOT
    // update beneficiary, calling the two-arg overload DOES.
    // ------------------------------------------------------------------

    function test_Overloads_AreDistinct() public {
        // First, set both via the two-arg overload.
        vm.prank(admin);
        overloaded.setLimit(uint256(1000), beneficiary);
        assertEq(overloaded.limit(), 1000);
        assertEq(overloaded.beneficiary(), beneficiary);

        // Now call the one-arg overload; only limit changes.
        vm.prank(admin);
        overloaded.setLimit(uint256(2000));
        assertEq(overloaded.limit(), 2000);
        // beneficiary is unchanged from the previous two-arg call.
        assertEq(overloaded.beneficiary(), beneficiary);
    }

    // ------------------------------------------------------------------
    // Access control — setLimit(uint256)
    // ------------------------------------------------------------------

    function test_SetLimitUint256_RevertsForNonAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Overloaded.NotAdmin.selector, nonAdmin));
        overloaded.setLimit(uint256(1));
    }

    // ------------------------------------------------------------------
    // Access control — setLimit(uint256,address)
    // ------------------------------------------------------------------

    function test_SetLimitUint256Address_RevertsForNonAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(abi.encodeWithSelector(Overloaded.NotAdmin.selector, nonAdmin));
        overloaded.setLimit(uint256(1), beneficiary);
    }
}
