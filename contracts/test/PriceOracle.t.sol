// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract PriceOracleTest is Test {
    PriceOracle private oracle;
    address private deployer = address(0xA0);
    address private nonOwner = address(0xC0);

    uint8 private constant DECIMALS = 8;
    int256 private constant INITIAL_ANSWER = 2_000e8; // USD 2 000 with 8 decimals

    function setUp() public {
        vm.label(deployer, "deployer");
        vm.label(nonOwner, "nonOwner");
        vm.prank(deployer);
        oracle = new PriceOracle(DECIMALS, INITIAL_ANSWER);
    }

    // ------------------------------------------------------------------
    // Constructor wiring
    // ------------------------------------------------------------------

    function test_ConstructorSetsDecimals() public view {
        assertEq(oracle.decimals(), DECIMALS);
    }

    function test_ConstructorSetsInitialAnswer() public view {
        assertEq(oracle.latestAnswer(), INITIAL_ANSWER);
    }

    function test_ConstructorSetsRoundIdToOne() public view {
        assertEq(oracle.roundId(), 1);
    }

    function test_ConstructorSetsUpdatedAtToBlockTimestamp() public view {
        assertEq(oracle.updatedAt(), block.timestamp);
    }

    function test_ConstructorSetsOwnerToDeployer() public view {
        assertEq(oracle.owner(), deployer);
    }

    // ------------------------------------------------------------------
    // latestAnswer
    // ------------------------------------------------------------------

    function test_LatestAnswerReturnsInitialAnswer() public view {
        assertEq(oracle.latestAnswer(), INITIAL_ANSWER);
    }

    // ------------------------------------------------------------------
    // latestRoundData — initial shape
    // ------------------------------------------------------------------

    function test_LatestRoundDataRoundIdIsOneInitially() public view {
        (uint80 roundId_,,,, uint80 answeredInRound) = oracle.latestRoundData();
        assertEq(roundId_, 1);
        assertEq(answeredInRound, 1);
    }

    function test_LatestRoundDataAnswerCorrectInitially() public view {
        (, int256 answer,,,) = oracle.latestRoundData();
        assertEq(answer, INITIAL_ANSWER);
    }

    function test_LatestRoundDataUpdatedAtIsNonZero() public view {
        (,, uint256 startedAt, uint256 updatedAt_,) = oracle.latestRoundData();
        assertGt(updatedAt_, 0);
        assertEq(startedAt, updatedAt_);
    }

    // ------------------------------------------------------------------
    // setAnswer — happy path
    // ------------------------------------------------------------------

    function test_SetAnswerUpdatesLatestAnswer() public {
        int256 newAnswer = 3_000e8;
        vm.prank(deployer);
        oracle.setAnswer(newAnswer);
        assertEq(oracle.latestAnswer(), newAnswer);
    }

    function test_SetAnswerBumpsRoundId() public {
        vm.prank(deployer);
        oracle.setAnswer(3_000e8);
        assertEq(oracle.roundId(), 2);
    }

    function test_SetAnswerUpdatesTimestamp() public {
        uint256 warpTime = 1_000;
        vm.warp(block.timestamp + warpTime);
        vm.prank(deployer);
        oracle.setAnswer(3_000e8);
        assertEq(oracle.updatedAt(), block.timestamp);
    }

    function test_SetAnswerUpdatesLatestRoundData() public {
        int256 newAnswer = 3_000e8;
        vm.warp(block.timestamp + 60);
        vm.prank(deployer);
        oracle.setAnswer(newAnswer);

        (
            uint80 roundId_,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt_,
            uint80 answeredInRound
        ) = oracle.latestRoundData();

        assertEq(roundId_, 2);
        assertEq(answer, newAnswer);
        assertEq(startedAt, updatedAt_);
        assertEq(updatedAt_, block.timestamp);
        assertEq(answeredInRound, 2);
    }

    function test_SetAnswerEmitsAnswerUpdatedEvent() public {
        int256 newAnswer = 3_000e8;
        vm.warp(block.timestamp + 60);

        vm.prank(deployer);
        vm.expectEmit(true, true, false, true);
        emit PriceOracle.AnswerUpdated(newAnswer, 2, block.timestamp);
        oracle.setAnswer(newAnswer);
    }

    function test_SetAnswerCanBeCalledMultipleTimes() public {
        vm.startPrank(deployer);
        oracle.setAnswer(3_000e8);
        oracle.setAnswer(4_000e8);
        oracle.setAnswer(1_500e8);
        vm.stopPrank();

        assertEq(oracle.latestAnswer(), 1_500e8);
        assertEq(oracle.roundId(), 4);
    }

    function test_SetAnswerAcceptsNegativeAnswer() public {
        vm.prank(deployer);
        oracle.setAnswer(-1e8);
        assertEq(oracle.latestAnswer(), -1e8);
    }

    function test_SetAnswerAcceptsZeroAnswer() public {
        vm.prank(deployer);
        oracle.setAnswer(0);
        assertEq(oracle.latestAnswer(), 0);
    }

    // ------------------------------------------------------------------
    // setAnswer — access control
    // ------------------------------------------------------------------

    function test_SetAnswerRevertsForNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner)
        );
        oracle.setAnswer(3_000e8);
    }
}
