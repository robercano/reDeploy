// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultERC4626} from "../src/VaultERC4626.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Minimal ERC-20 token used as the vault asset inside this test file.
///      Declared here so the test has no dependency on the existing Token.sol fixture,
///      keeping the test self-contained. Anyone with the MINTER role (initially the
///      deployer) can mint tokens.
contract MockAsset is ERC20 {
    address private _minter;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == _minter, "not minter");
        _mint(to, amount);
    }
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------

contract VaultERC4626Test is Test {
    MockAsset private asset;
    PriceOracle private oracle;
    VaultERC4626 private vault;

    address private deployer = address(0xA0);
    address private user = address(0xB0);
    address private user2 = address(0xC0);

    uint8 private constant ORACLE_DECIMALS = 8;
    int256 private constant INITIAL_PRICE = 2_000e8; // USD 2 000

    uint256 private constant INITIAL_BALANCE = 10_000e18;

    function setUp() public {
        vm.label(deployer, "deployer");
        vm.label(user, "user");
        vm.label(user2, "user2");

        vm.startPrank(deployer);
        asset = new MockAsset("Test Asset", "TASSET");
        oracle = new PriceOracle(ORACLE_DECIMALS, INITIAL_PRICE);
        vault = new VaultERC4626(IERC20(address(asset)), oracle, "Vault Shares", "vTASSET");
        vm.stopPrank();

        // Fund users.
        vm.startPrank(deployer);
        asset.mint(user, INITIAL_BALANCE);
        asset.mint(user2, INITIAL_BALANCE);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Constructor wiring
    // ------------------------------------------------------------------

    function test_ConstructorStoresOracle() public view {
        assertEq(address(vault.oracle()), address(oracle));
    }

    function test_ConstructorSetsShareName() public view {
        assertEq(vault.name(), "Vault Shares");
    }

    function test_ConstructorSetsShareSymbol() public view {
        assertEq(vault.symbol(), "vTASSET");
    }

    function test_ConstructorSetsAsset() public view {
        assertEq(vault.asset(), address(asset));
    }

    function test_InitialTotalAssetsIsZero() public view {
        assertEq(vault.totalAssets(), 0);
    }

    function test_InitialTotalSupplyIsZero() public view {
        assertEq(vault.totalSupply(), 0);
    }

    // ------------------------------------------------------------------
    // deposit — share minting math
    // ------------------------------------------------------------------

    function test_DepositMintsShares() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, user);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vault.balanceOf(user), shares);
    }

    function test_DepositTransfersAssetToVault() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();

        assertEq(asset.balanceOf(address(vault)), amount);
        assertEq(asset.balanceOf(user), INITIAL_BALANCE - amount);
    }

    function test_DepositUpdatesTotalAssets() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();

        assertEq(vault.totalAssets(), amount);
    }

    function test_DepositSharesEqualAssetsWhenVaultEmpty() public {
        // First deposit into an empty vault: shares == assets (1:1 ratio).
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, user);
        vm.stopPrank();

        assertEq(shares, amount);
    }

    // ------------------------------------------------------------------
    // withdraw / redeem — share math
    // ------------------------------------------------------------------

    function test_WithdrawBurnsShares() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        vault.deposit(amount, user);
        uint256 sharesBefore = vault.balanceOf(user);
        vault.withdraw(amount, user, user);
        vm.stopPrank();

        assertLt(vault.balanceOf(user), sharesBefore);
        assertEq(vault.balanceOf(user), 0);
    }

    function test_WithdrawReturnsAssets() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        vault.deposit(amount, user);
        vault.withdraw(amount, user, user);
        vm.stopPrank();

        assertEq(asset.balanceOf(user), INITIAL_BALANCE);
    }

    function test_RedeemBurnsSharesAndReturnsAssets() public {
        uint256 amount = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, user);
        uint256 assets = vault.redeem(shares, user, user);
        vm.stopPrank();

        assertEq(assets, amount);
        assertEq(vault.balanceOf(user), 0);
        assertEq(asset.balanceOf(user), INITIAL_BALANCE);
    }

    // ------------------------------------------------------------------
    // Non-1:1 ratio scenario (vault gains assets via direct transfer)
    // ------------------------------------------------------------------

    /// @dev Simulate vault yield by transferring extra assets directly into the vault
    ///      (as if yield had been accrued). After this, the share price is > 1:1,
    ///      so a second depositor gets fewer shares per asset than the first.
    function test_NonOneToOneRatioAfterYield() public {
        uint256 firstDeposit = 1_000e18;

        // First user deposits.
        vm.startPrank(user);
        asset.approve(address(vault), firstDeposit);
        uint256 firstShares = vault.deposit(firstDeposit, user);
        vm.stopPrank();

        // Simulate yield: transfer 1 000 extra tokens directly to vault.
        uint256 yield = 1_000e18;
        vm.prank(deployer);
        asset.mint(address(vault), yield);

        // Vault now holds 2 000 tokens but only firstShares shares outstanding.
        assertEq(vault.totalAssets(), firstDeposit + yield);

        // Second user deposits 1 000 tokens.
        uint256 secondDeposit = 1_000e18;
        vm.startPrank(user2);
        asset.approve(address(vault), secondDeposit);
        uint256 secondShares = vault.deposit(secondDeposit, user2);
        vm.stopPrank();

        // Second user should receive fewer shares than the first (price appreciation).
        assertLt(secondShares, firstShares);

        // First user redeems all shares and should receive more than their original deposit.
        vm.startPrank(user);
        uint256 assetsOut = vault.redeem(firstShares, user, user);
        vm.stopPrank();
        assertGt(assetsOut, firstDeposit);
    }

    // ------------------------------------------------------------------
    // assetPrice
    // ------------------------------------------------------------------

    function test_AssetPriceReturnsOracleLatestAnswer() public view {
        assertEq(vault.assetPrice(), INITIAL_PRICE);
    }

    function test_AssetPriceUpdatesWhenOracleChanges() public {
        int256 newPrice = 3_000e8;
        vm.prank(deployer);
        oracle.setAnswer(newPrice);

        assertEq(vault.assetPrice(), newPrice);
    }

    // ------------------------------------------------------------------
    // totalValue
    // ------------------------------------------------------------------

    function test_TotalValueIsZeroWhenVaultIsEmpty() public view {
        // totalAssets == 0 => totalValue == 0.
        assertEq(vault.totalValue(), 0);
    }

    function test_TotalValueReflectsTotalAssetsAndPrice() public {
        uint256 amount = 2e18; // 2 tokens
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();

        // price = 2_000e8, decimals = 8
        // totalValue = 2e18 * 2_000e8 / 1e8 = 4_000e18
        uint256 expected = amount * uint256(INITIAL_PRICE) / (10 ** uint256(ORACLE_DECIMALS));
        assertEq(vault.totalValue(), expected);
    }

    function test_TotalValueChangesWhenOraclePriceChanges() public {
        uint256 amount = 1e18; // 1 token
        vm.startPrank(user);
        asset.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();

        uint256 valueBefore = vault.totalValue();

        // Double the price.
        int256 newPrice = INITIAL_PRICE * 2;
        vm.prank(deployer);
        oracle.setAnswer(newPrice);

        uint256 valueAfter = vault.totalValue();
        assertEq(valueAfter, valueBefore * 2);
    }

    function test_TotalValueChangesWhenTotalAssetsChange() public {
        uint256 firstDeposit = 1_000e18;
        vm.startPrank(user);
        asset.approve(address(vault), firstDeposit);
        vault.deposit(firstDeposit, user);
        vm.stopPrank();

        uint256 valueBefore = vault.totalValue();

        uint256 secondDeposit = 1_000e18;
        vm.startPrank(user2);
        asset.approve(address(vault), secondDeposit);
        vault.deposit(secondDeposit, user2);
        vm.stopPrank();

        assertEq(vault.totalValue(), valueBefore * 2);
    }

    // ------------------------------------------------------------------
    // totalValue — non-positive price guard
    // ------------------------------------------------------------------

    function test_TotalValueRevertsOnZeroOracleAnswer() public {
        // Deposit so totalAssets > 0.
        vm.startPrank(user);
        asset.approve(address(vault), 1e18);
        vault.deposit(1e18, user);
        vm.stopPrank();

        vm.prank(deployer);
        oracle.setAnswer(0);

        vm.expectRevert(
            abi.encodeWithSelector(VaultERC4626.NonPositiveOracleAnswer.selector, int256(0))
        );
        vault.totalValue();
    }

    function test_TotalValueRevertsOnNegativeOracleAnswer() public {
        // Deposit so totalAssets > 0.
        vm.startPrank(user);
        asset.approve(address(vault), 1e18);
        vault.deposit(1e18, user);
        vm.stopPrank();

        int256 negPrice = -1e8;
        vm.prank(deployer);
        oracle.setAnswer(negPrice);

        vm.expectRevert(
            abi.encodeWithSelector(VaultERC4626.NonPositiveOracleAnswer.selector, negPrice)
        );
        vault.totalValue();
    }

    function test_TotalValueRevertsOnZeroPriceEvenWhenVaultEmpty() public {
        // totalAssets == 0, but assetPrice() == 0 triggers the non-positive guard
        // before any multiply — so totalValue() reverts even when the vault is empty.
        vm.prank(deployer);
        oracle.setAnswer(0);

        vm.expectRevert(
            abi.encodeWithSelector(VaultERC4626.NonPositiveOracleAnswer.selector, int256(0))
        );
        vault.totalValue();
    }
}
