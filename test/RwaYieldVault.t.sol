// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RwaYieldVault} from "../src/RwaYieldVault.sol";
import {IStrategyAdapter} from "../src/interfaces/IStrategyAdapter.sol";
import {IPerpShortProxy} from "../src/interfaces/IPerpShortProxy.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockStrategyAdapter, MockPerpShortProxy} from "./mocks/MockStrategyAdapter.sol";

contract RwaYieldVaultTest is Test {
    uint256 internal constant USDC = 1e6;
    address internal owner = address(this);
    address internal keeper = address(0xBEEF);
    address internal alice = address(0xA11CE);

    MockUSDC internal usdc;
    RwaYieldVault internal vault;
    MockStrategyAdapter internal yieldAdapter;
    MockPerpShortProxy internal perpAdapter;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new RwaYieldVault(usdc, keeper);
        yieldAdapter = new MockStrategyAdapter(usdc);
        perpAdapter = new MockPerpShortProxy(usdc);
        vault.setStrategies(yieldAdapter, IPerpShortProxy(address(perpAdapter)));
        usdc.mint(alice, 2_000_000 * USDC);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function testShareMetadataAndSixDecimalAsset() public {
        assertEq(vault.name(), "eVault USDC");
        assertEq(vault.symbol(), "eVault-USDC");
        assertEq(vault.decimals(), 6);
        assertEq(vault.asset(), address(usdc));
    }

    function testDepositMintsProRataShares() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * USDC, alice);
        assertEq(shares, 1_000 * USDC);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), 1_000 * USDC);
    }

    function testRebalanceRestrictedToDesignatedKeeper() public {
        _depositAndRebalance(6_000, 2_000, 500, uint64(block.timestamp + 300));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RwaYieldVault.InvalidKeeper.selector, alice));
        vault.rebalance(_params(6_000, 2_000, 500, uint64(block.timestamp + 300)));
    }

    function testRebalanceAllocatesYieldPerpAndIdleAtOneX() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC, alice);
        _rebalance(6_000, 2_000, 500, uint64(block.timestamp + 300));

        assertEq(yieldAdapter.totalAssets(), 600 * USDC);
        assertEq(perpAdapter.totalAssets(), 200 * USDC);
        assertEq(perpAdapter.shortNotionalUsdc(), 200 * USDC);
        assertEq(perpAdapter.leverageBps(), 10_000);
        assertEq(usdc.balanceOf(address(vault)), 200 * USDC);
        assertApproxEqAbs(vault.totalAssets(), 1_000 * USDC, 1);
    }

    function testRebalanceUnwindsExcessBeforeInvestingNewTargets() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC, alice);
        _rebalance(6_000, 2_000, 500, uint64(block.timestamp + 300));
        _rebalance(2_000, 3_000, 500, uint64(block.timestamp + 300));

        assertEq(yieldAdapter.totalAssets(), 200 * USDC);
        assertEq(perpAdapter.totalAssets(), 300 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 500 * USDC);
    }

    function testRejectsExpiredDeadline() public {
        vm.prank(alice);
        vault.deposit(100 * USDC, alice);
        vm.warp(10_000);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                RwaYieldVault.InvalidDeadline.selector, uint256(block.timestamp - 1), block.timestamp, uint256(1_800)
            )
        );
        vault.rebalance(_params(5_000, 3_000, 100, uint64(block.timestamp - 1)));
    }

    function testRejectsSlippageAboveOwnerBound() public {
        vm.prank(alice);
        vault.deposit(100 * USDC, alice);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(RwaYieldVault.InvalidSlippage.selector, uint256(501), uint256(500)));
        vault.rebalance(_params(5_000, 3_000, 501, uint64(block.timestamp + 300)));
    }

    function testAdapterEnforcesMinimumOutputAndWholeTransactionReverts() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC, alice);
        yieldAdapter.setFees(600, 0);
        vm.prank(keeper);
        vm.expectRevert();
        vault.rebalance(_params(10_000, 0, 500, uint64(block.timestamp + 300)));
        assertEq(usdc.balanceOf(address(vault)), 1_000 * USDC);
        assertEq(yieldAdapter.totalAssets(), 0);
    }

    function testWithdrawSourcesLiquidityFromStrategies() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC, alice);
        _rebalance(6_000, 2_000, 500, uint64(block.timestamp + 300));
        assertEq(vault.maxWithdraw(alice), 1_000 * USDC);

        vm.prank(alice);
        uint256 sharesBurned = vault.withdraw(500 * USDC, alice, alice);
        assertEq(sharesBurned, 500 * USDC);
        assertEq(usdc.balanceOf(alice), 2_000_000 * USDC - 500 * USDC);
        assertEq(vault.totalAssets(), 500 * USDC);
    }

    function testMaxWithdrawReflectsNetStrategyNavAndIsWithdrawable() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC, alice);
        _rebalance(6_000, 2_000, 500, uint64(block.timestamp + 300));
        yieldAdapter.setFees(0, 1_000);

        assertEq(vault.totalAssets(), 940 * USDC);
        uint256 maxAssets = vault.maxWithdraw(alice);
        uint256 maxShares = vault.maxRedeem(alice);
        assertApproxEqAbs(maxAssets, 940 * USDC, 1);
        assertApproxEqAbs(maxShares, 1_000 * USDC, 1);

        vm.prank(alice);
        uint256 sharesBurned = vault.withdraw(maxAssets, alice, alice);
        assertApproxEqAbs(sharesBurned, maxShares, 1);
        assertEq(usdc.balanceOf(alice), 2_000_000 * USDC - 1_000 * USDC + maxAssets);
    }

    function testWithdrawRemainsAvailableWhenPausedButDepositDoesNot() public {
        vm.prank(alice);
        vault.deposit(100 * USDC, alice);
        _rebalance(5_000, 2_000, 500, uint64(block.timestamp + 300));
        vault.pause();
        assertEq(vault.maxDeposit(alice), 0);
        assertEq(vault.maxMint(alice), 0);

        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(1 * USDC, alice);

        vm.prank(alice);
        vault.redeem(10 * USDC, alice, alice);
        assertEq(vault.totalAssets(), 90 * USDC);
    }

    function testRebalanceRejectsInvalidPerpLeverage() public {
        vm.prank(alice);
        vault.deposit(100 * USDC, alice);
        _rebalance(0, 10_000, 500, uint64(block.timestamp + 300));
        perpAdapter.setForceInvalidLeverage(true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(RwaYieldVault.PerpLeverageNotOneX.selector, uint256(20_000)));
        vault.rebalance(_params(0, 10_000, 500, uint64(block.timestamp + 300)));
    }

    function testOnlyOwnerCanChangeKeeperAndRiskLimits() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setKeeper(alice);
        vault.setRiskLimits(750, 900);
        assertEq(vault.maxAllowedSlippageBps(), 750);
        assertEq(vault.maxDeadlineSeconds(), 900);
    }

    function _depositAndRebalance(uint16 yieldBps, uint16 perpBps, uint16 slip, uint64 deadline) internal {
        vm.prank(alice);
        vault.deposit(1_000 * USDC, alice);
        _rebalance(yieldBps, perpBps, slip, deadline);
    }

    function _rebalance(uint16 yieldBps, uint16 perpBps, uint16 slip, uint64 deadline) internal {
        vm.prank(keeper);
        vault.rebalance(_params(yieldBps, perpBps, slip, deadline));
    }

    function _params(uint16 yieldBps, uint16 perpBps, uint16 slip, uint64 deadline)
        internal
        pure
        returns (RwaYieldVault.RebalanceParams memory)
    {
        return RwaYieldVault.RebalanceParams({
            yieldBps: yieldBps, perpBps: perpBps, maxSlippageBps: slip, deadline: deadline
        });
    }
}
