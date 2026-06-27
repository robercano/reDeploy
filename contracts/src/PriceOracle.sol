// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title PriceOracle
/// @notice Chainlink AggregatorV3Interface-shaped mock price feed (MockV3Aggregator style).
///         Implements AggregatorV3Interface so it can be wired directly into VaultERC4626 and
///         other consumers. The owner (deployer) can update the answer at any time via
///         setAnswer(); each update bumps the round bookkeeping so latestRoundData() always
///         returns a consistent, non-zero snapshot.
///
///         Intended for testing and local development only — not audited for production.
contract PriceOracle is Ownable, AggregatorV3Interface {
    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    // solhint-disable-next-line immutable-vars-naming
    /// @notice Number of decimals the answer is expressed in (set at construction, immutable).
    uint8 public immutable override decimals;

    /// @notice Current round ID; starts at 1 and is incremented on every setAnswer call.
    uint80 public roundId;

    /// @notice Latest price answer.
    int256 public latestAnswer;

    /// @notice Timestamp when the current round started / was last updated.
    uint256 public updatedAt;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted whenever the answer is updated (including the initial construction).
    /// @param current     New answer value.
    /// @param roundId_    Round ID for this update.
    /// @param updatedAt_  Block timestamp of the update.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId_, uint256 updatedAt_);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param decimals_      Number of decimals the price feed answers are expressed in.
    /// @param initialAnswer_ Initial price answer (round 1).
    // solhint-disable-next-line func-visibility
    constructor(uint8 decimals_, int256 initialAnswer_) Ownable(msg.sender) {
        decimals = decimals_;

        // Initialise round 1.
        roundId = 1;
        latestAnswer = initialAnswer_;
        updatedAt = block.timestamp;

        emit AnswerUpdated(initialAnswer_, 1, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // AggregatorV3Interface view functions
    // -------------------------------------------------------------------------

    /// @notice Returns the full data for the latest round.
    /// @return roundId_       The current round ID.
    /// @return answer         The price answer for this round.
    /// @return startedAt      Timestamp when the round started (same as updatedAt).
    /// @return updatedAt_     Timestamp when the round was last updated.
    /// @return answeredInRound The round in which the answer was computed (same as roundId_).
    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId_,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt_,
            uint80 answeredInRound
        )
    {
        roundId_ = roundId;
        answer = latestAnswer;
        startedAt = updatedAt;
        updatedAt_ = updatedAt;
        answeredInRound = roundId;
    }

    // -------------------------------------------------------------------------
    // Admin functions
    // -------------------------------------------------------------------------

    /// @notice Update the price answer.
    ///         Bumps the round ID, refreshes updatedAt/startedAt to block.timestamp,
    ///         and emits AnswerUpdated.
    /// @dev Only callable by the owner (deployer).
    /// @param answer_ New price answer.
    function setAnswer(int256 answer_) external onlyOwner {
        // Effects
        roundId += 1;
        latestAnswer = answer_;
        updatedAt = block.timestamp;

        emit AnswerUpdated(answer_, roundId, block.timestamp);
    }
}
