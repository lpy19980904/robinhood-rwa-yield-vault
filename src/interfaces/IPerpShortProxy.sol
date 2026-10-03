// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategyAdapter} from "./IStrategyAdapter.sol";

/// @notice USDC-margin strategy adapter that maintains a 1x short perp position.
/// @dev Deposits must increase collateral and short notional together; withdrawals must
///      close/reduce the short before releasing collateral. totalAssets() is net USDC
///      equity (including unrealized PnL), while leverageBps() reports gross short
///      notional / net equity * 10_000. The vault rejects non-1x states at rebalance.
interface IPerpShortProxy is IStrategyAdapter {
    function shortNotionalUsdc() external view returns (uint256);
    function leverageBps() external view returns (uint256);
}
