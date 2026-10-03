// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../../src/interfaces/IStrategyAdapter.sol";
import {IPerpShortProxy} from "../../src/interfaces/IPerpShortProxy.sol";

/// @dev Test-only adapter. NAV is tracked separately from token inventory to model fees/losses.
contract MockStrategyAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 internal immutable _asset;
    uint256 public override totalAssets;
    uint16 public depositFeeBps;
    uint16 public withdrawalFeeBps;
    uint256 public lastDeadline;
    uint16 public lastSlippageBps;

    error Expired(uint256 deadline);
    error TooLittleOut(uint256 actual, uint256 minimum);
    error InsufficientNav(uint256 requested, uint256 available);
    error InvalidFee();

    constructor(IERC20 asset_) {
        _asset = asset_;
    }

    function asset() external view override returns (address) {
        return address(_asset);
    }

    function maxWithdraw() external view override returns (uint256) {
        return totalAssets;
    }

    function setFees(uint16 depositFee, uint16 withdrawalFee) external {
        if (depositFee > 10_000 || withdrawalFee > 10_000) revert InvalidFee();
        if (totalAssets != 0 && withdrawalFee != withdrawalFeeBps) {
            if (withdrawalFeeBps == 10_000) {
                totalAssets = 0;
            } else {
                totalAssets = totalAssets * (10_000 - withdrawalFee) / (10_000 - withdrawalFeeBps);
            }
        }
        depositFeeBps = depositFee;
        withdrawalFeeBps = withdrawalFee;
    }

    function previewDeposit(uint256 assets) external pure override returns (uint256) {
        // Quote spot position units; execution fees are applied only in deposit().
        return assets;
    }

    function previewWithdraw(uint256 assetsOutRequested) external pure override returns (uint256) {
        return assetsOutRequested;
    }

    function deposit(uint256 assets, uint256 minPositionOut, uint16 slippageBps, uint256 deadline)
        external
        virtual
        override
        returns (uint256 positionOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        lastDeadline = deadline;
        lastSlippageBps = slippageBps;
        positionOut = assets * (10_000 - depositFeeBps) / 10_000;
        if (positionOut < minPositionOut) revert TooLittleOut(positionOut, minPositionOut);
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        totalAssets += positionOut * (10_000 - withdrawalFeeBps) / 10_000;
    }

    function withdraw(uint256 assetsOutRequested, uint256 minAssetsOut, uint16 slippageBps, uint256 deadline)
        external
        virtual
        override
        returns (uint256 assetsOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (assetsOutRequested > totalAssets) revert InsufficientNav(assetsOutRequested, totalAssets);
        lastDeadline = deadline;
        lastSlippageBps = slippageBps;
        totalAssets -= assetsOutRequested;
        assetsOut = assetsOutRequested;
        if (assetsOut < minAssetsOut) revert TooLittleOut(assetsOut, minAssetsOut);
        _asset.safeTransfer(msg.sender, assetsOut);
    }
}

/// @dev Test-only 1x short proxy; short notional is equal to net USDC equity.
contract MockPerpShortProxy is MockStrategyAdapter, IPerpShortProxy {
    using SafeERC20 for IERC20;

    uint256 public override shortNotionalUsdc;
    uint256 public override leverageBps;
    bool public forceInvalidLeverage;

    constructor(IERC20 asset_) MockStrategyAdapter(asset_) {}

    function setForceInvalidLeverage(bool forceInvalid) external {
        forceInvalidLeverage = forceInvalid;
        _syncLeverage();
    }

    function deposit(uint256 assets, uint256 minPositionOut, uint16 slippageBps, uint256 deadline)
        external
        override(IStrategyAdapter, MockStrategyAdapter)
        returns (uint256 positionOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        lastDeadline = deadline;
        lastSlippageBps = slippageBps;
        positionOut = assets * (10_000 - depositFeeBps) / 10_000;
        if (positionOut < minPositionOut) revert TooLittleOut(positionOut, minPositionOut);
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        totalAssets += positionOut * (10_000 - withdrawalFeeBps) / 10_000;
        _syncLeverage();
    }

    function withdraw(uint256 assetsOutRequested, uint256 minAssetsOut, uint16 slippageBps, uint256 deadline)
        external
        override(IStrategyAdapter, MockStrategyAdapter)
        returns (uint256 assetsOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (assetsOutRequested > totalAssets) revert InsufficientNav(assetsOutRequested, totalAssets);
        lastDeadline = deadline;
        lastSlippageBps = slippageBps;
        totalAssets -= assetsOutRequested;
        assetsOut = assetsOutRequested;
        if (assetsOut < minAssetsOut) revert TooLittleOut(assetsOut, minAssetsOut);
        _asset.safeTransfer(msg.sender, assetsOut);
        _syncLeverage();
    }

    function _syncLeverage() internal {
        shortNotionalUsdc = forceInvalidLeverage ? totalAssets * 2 : totalAssets;
        leverageBps = totalAssets == 0 ? 0 : (shortNotionalUsdc * 10_000) / totalAssets;
    }
}
