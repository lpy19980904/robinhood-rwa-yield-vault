// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Adapter boundary for a strategy denominated in the vault's USDC asset.
/// @dev totalAssets() MUST report current net USDC NAV, including accrued yield, fees,
///      realized PnL, unrealized PnL, and estimated exit costs. maxWithdraw() reports
///      the maximum USDC output the adapter can currently guarantee. previewWithdraw()
///      quotes output for a requested USDC amount. Deposit output units are adapter-specific.
interface IStrategyAdapter {
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    /// @notice Maximum USDC output the adapter can currently guarantee to deliver.
    function maxWithdraw() external view returns (uint256 assetsOut);
    function previewDeposit(uint256 assets) external view returns (uint256 positionOut);
    function previewWithdraw(uint256 assetsOutRequested) external view returns (uint256 expectedAssetsOut);

    function deposit(uint256 assets, uint256 minPositionOut, uint16 maxSlippageBps, uint256 deadline)
        external
        returns (uint256 positionOut);

    /// @dev assetsOutRequested is the desired USDC proceeds; the adapter grosses up its position as needed.
    function withdraw(uint256 assetsOutRequested, uint256 minAssetsOut, uint16 maxSlippageBps, uint256 deadline)
        external
        returns (uint256 assetsOut);
}
