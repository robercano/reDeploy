// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title VaultERC4626
/// @notice ERC-4626 tokenised vault fixture wired to a Chainlink-style price oracle.
///         Constructor dependencies:
///           - asset_  : any IERC20-compliant token (e.g. the fixture Token contract).
///           - oracle_ : any AggregatorV3Interface implementation (e.g. PriceOracle).
///
///         Extra views:
///           - assetPrice()  — latest oracle answer in oracle-native decimals.
///           - totalValue()  — totalAssets() converted to a 1e18-normalised USD value
///                             using the oracle price and its declared decimals.
///
///         Unit convention for totalValue():
///           result = totalAssets (asset tokens, 18 dec)
///                  * oracle answer (oracle.decimals() dec)
///                  / 10^oracle.decimals()
///           => result is expressed in the same units as oracle.decimals() implies
///              (e.g. USD with 18 decimals when oracle.decimals() == 18).
///
///         Dependency direction: builds on Token (as asset) and PriceOracle (as feed).
contract VaultERC4626 is ERC4626 {
    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------

    /// @dev Thrown by totalValue() when the oracle returns a non-positive answer.
    error NonPositiveOracleAnswer(int256 answer);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    // solhint-disable-next-line immutable-vars-naming
    /// @notice The price oracle used for asset valuation (immutable, set at construction).
    AggregatorV3Interface public immutable oracle;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param asset_   The underlying ERC-20 asset token.
    /// @param oracle_  Chainlink-style price feed for the asset.
    /// @param name_    ERC-20 name for the vault share token.
    /// @param symbol_  ERC-20 symbol for the vault share token.
    // solhint-disable-next-line func-visibility
    constructor(
        IERC20 asset_,
        AggregatorV3Interface oracle_,
        string memory name_,
        string memory symbol_
    ) ERC4626(asset_) ERC20(name_, symbol_) {
        oracle = oracle_;
    }

    // -------------------------------------------------------------------------
    // Oracle-based valuation views
    // -------------------------------------------------------------------------

    /// @notice Returns the latest price answer from the oracle.
    /// @dev    Delegates directly to oracle.latestAnswer(); callers should be aware that
    ///         a stale or manipulated oracle may return an outdated value — this contract
    ///         makes no freshness check.
    /// @return The oracle answer in oracle-native decimals.
    function assetPrice() public view returns (int256) {
        return oracle.latestAnswer();
    }

    /// @notice Returns the total vault assets expressed in oracle price units.
    /// @dev    Computes: totalAssets() * uint256(assetPrice()) / 10**oracle.decimals().
    ///         Reverts with {NonPositiveOracleAnswer} if the oracle returns 0 or a negative
    ///         value, which would produce a meaningless (or overflowing) result.
    ///
    ///         Unit example (oracle has 8 decimals, asset has 18 decimals):
    ///           totalAssets = 2e18  (2 tokens)
    ///           price       = 2_000e8  (USD 2 000 with 8-decimal oracle)
    ///           totalValue  = 2e18 * 2_000e8 / 1e8 = 4_000e18  (USD 4 000, 18 dec)
    ///
    /// @return value Total assets valued at the current oracle price, in units of
    ///               (asset decimals + oracle decimals − oracle decimals) = asset decimals.
    function totalValue() external view returns (uint256) {
        int256 price = assetPrice();
        if (price <= 0) revert NonPositiveOracleAnswer(price);
        return totalAssets() * uint256(price) / (10 ** uint256(oracle.decimals()));
    }
}
