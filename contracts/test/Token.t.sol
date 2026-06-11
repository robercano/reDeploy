// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";

contract TokenTest is Test {
    Token private token;
    address private deployer = address(0xA0);
    address private user = address(0xB0);
    address private nonMinter = address(0xC0);

    function setUp() public {
        vm.label(deployer, "deployer");
        vm.label(user, "user");
        vm.label(nonMinter, "nonMinter");
        vm.prank(deployer);
        token = new Token("Test Token", "TTK");
    }

    // ------------------------------------------------------------------
    // Constructor wiring
    // ------------------------------------------------------------------

    function test_ConstructorSetsNameAndSymbol() public view {
        assertEq(token.name(), "Test Token");
        assertEq(token.symbol(), "TTK");
    }

    function test_ConstructorGrantsAdminRole() public view {
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), deployer));
    }

    function test_ConstructorGrantsMinterRoleToDeployer() public view {
        assertTrue(token.hasRole(token.MINTER_ROLE(), deployer));
    }

    function test_ConstructorDoesNotGrantRolesToOthers() public view {
        assertFalse(token.hasRole(token.DEFAULT_ADMIN_ROLE(), user));
        assertFalse(token.hasRole(token.MINTER_ROLE(), user));
    }

    // ------------------------------------------------------------------
    // mint — MINTER_ROLE gating
    // ------------------------------------------------------------------

    function test_MintByDeployer() public {
        vm.prank(deployer);
        token.mint(user, 1_000e18);
        assertEq(token.balanceOf(user), 1_000e18);
        assertEq(token.totalSupply(), 1_000e18);
    }

    function test_MintByGrantedMinter() public {
        address minter = address(0xD0);
        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(deployer);
        token.grantRole(minterRole, minter);

        vm.prank(minter);
        token.mint(user, 500e18);
        assertEq(token.balanceOf(user), 500e18);
    }

    function test_MintRevertsForNonMinter() public {
        vm.prank(nonMinter);
        vm.expectRevert(abi.encodeWithSelector(Token.NotMinter.selector, nonMinter));
        token.mint(user, 1e18);
    }

    // ------------------------------------------------------------------
    // role management
    // ------------------------------------------------------------------

    function test_AdminCanGrantMinterRole() public {
        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(deployer);
        token.grantRole(minterRole, user);
        assertTrue(token.hasRole(minterRole, user));
    }

    function test_AdminCanRevokeMinterRole() public {
        // First grant, then revoke deployer's own MINTER_ROLE.
        bytes32 minterRole = token.MINTER_ROLE();
        vm.startPrank(deployer);
        token.revokeRole(minterRole, deployer);
        vm.stopPrank();
        assertFalse(token.hasRole(minterRole, deployer));
    }

    function test_RevokedMinterCannotMint() public {
        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(deployer);
        token.revokeRole(minterRole, deployer);

        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(Token.NotMinter.selector, deployer));
        token.mint(user, 1e18);
    }

    // ------------------------------------------------------------------
    // ERC20 basics
    // ------------------------------------------------------------------

    function test_TransferBetweenAccounts() public {
        vm.prank(deployer);
        token.mint(deployer, 100e18);

        vm.prank(deployer);
        bool ok = token.transfer(user, 40e18);
        assertTrue(ok);

        assertEq(token.balanceOf(deployer), 60e18);
        assertEq(token.balanceOf(user), 40e18);
    }
}
