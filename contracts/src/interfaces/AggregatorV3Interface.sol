// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AggregatorV3Interface
/// @notice Chainlink AggregatorV3Interface-shaped interface for price feed consumers.
///         Defined locally so the contracts project has no external Chainlink dependency.
interface AggregatorV3Interface {
    /// @notice Returns the number of decimals the answer is expressed in.
    /// @return The decimals value.
    function decimals() external view returns (uint8);

    /// @notice Returns the latest answer from the feed.
    /// @return The latest price answer.
    function latestAnswer() external view returns (int256);

    /// @notice Returns the full data for the latest round.
    /// @return roundId       The round ID.
    /// @return answer        The price answer for this round.
    /// @return startedAt     Timestamp when the round started.
    /// @return updatedAt     Timestamp when the round was last updated.
    /// @return answeredInRound The round in which the answer was computed.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
