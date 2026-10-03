// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";
import {IPerpShortProxy} from "./interfaces/IPerpShortProxy.sol";

/// @title RWA Yield USDC Vault
/// @notice ERC-4626 shares represent a pro-rata claim on idle USDC and two USDC-NAV strategies.
/// @dev The RWA swap/stake adapter and perp venue integration are deliberately external
///      interfaces. Their implementations, venue addresses, oracle policy, custody model,
///      and audits must be selected and reviewed before funds are deployed.
contract RwaYieldVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint16 public constant BPS = 10_000;
    uint16 public constant HARD_MAX_SLIPPAGE_BPS = 2_000;
    uint32 public constant HARD_MAX_DEADLINE_SECONDS = 3_600;

    struct RebalanceParams {
        uint16 yieldBps;
        uint16 perpBps;
        uint16 maxSlippageBps;
        uint64 deadline;
    }

    IStrategyAdapter public yieldStrategy;
    IPerpShortProxy public perpProxy;
    address public keeper;
    uint16 public maxAllowedSlippageBps = 500;
    uint32 public maxDeadlineSeconds = 1_800;

    error ZeroAddress();
    error InvalidKeeper(address caller);
    error InvalidAllocation(uint256 sumBps);
    error InvalidSlippage(uint256 requested, uint256 configuredMax);
    error InvalidDeadline(uint256 deadline, uint256 nowTimestamp, uint256 maxSeconds);
    error InvalidAdapter(address adapter);
    error AdapterAssetMismatch(address adapter, address expectedAsset);
    error ActiveStrategyAssets(uint256 yieldAssets, uint256 perpAssets);
    error InvalidRiskLimits();
    error InvalidPreview(address adapter, uint256 requestedAmount);
    error SlippageExceeded(address adapter, uint256 received, uint256 minimum);
    error AdapterAccountingMismatch(address adapter, uint256 reported, uint256 observed);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error PerpLeverageNotOneX(uint256 leverageBps);
    error UnexpectedAdapterSpend(address adapter, uint256 expected, uint256 actual);

    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event StrategiesUpdated(address indexed yieldStrategy, address indexed perpProxy);
    event RiskLimitsUpdated(uint16 maxSlippageBps, uint32 maxDeadlineSeconds);
    event Rebalanced(
        address indexed keeper,
        uint16 yieldBps,
        uint16 perpBps,
        uint16 maxSlippageBps,
        uint256 deadline,
        uint256 totalAssetsAfter
    );
    event StrategyDeposit(address indexed adapter, uint256 assets, uint256 positionOut);
    event StrategyWithdrawal(address indexed adapter, uint256 assetsRequested, uint256 assetsReceived);

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert InvalidKeeper(msg.sender);
        _;
    }

    constructor(IERC20 usdc, address initialKeeper)
        ERC20("eVault USDC", "eVault-USDC")
        ERC4626(usdc)
        Ownable(msg.sender)
    {
        if (address(usdc) == address(0) || initialKeeper == address(0)) revert ZeroAddress();
        keeper = initialKeeper;
    }

    /// @notice Combined USDC-denominated NAV; adapters must return net equity, not gross deposits.
    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));
        if (address(yieldStrategy) != address(0)) total += yieldStrategy.totalAssets();
        if (address(perpProxy) != address(0)) total += perpProxy.totalAssets();
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return previewRedeem(maxRedeem(owner_));
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 ownerShares = balanceOf(owner_);
        uint256 nav = totalAssets();
        if (ownerShares == 0 || nav == 0) return 0;

        IERC20 underlying = IERC20(asset());
        uint256 liquidAssets = underlying.balanceOf(address(this));
        if (address(yieldStrategy) != address(0)) {
            liquidAssets += yieldStrategy.maxWithdraw();
        }
        if (address(perpProxy) != address(0)) {
            liquidAssets += perpProxy.maxWithdraw();
        }
        if (liquidAssets > nav) liquidAssets = nav;
        uint256 liquidShares = convertToShares(liquidAssets);
        return Math.min(ownerShares, liquidShares);
    }

    /// @notice Configure one yield adapter and one 1x-short perp proxy. Old strategies must be empty.
    function setStrategies(IStrategyAdapter newYieldStrategy, IPerpShortProxy newPerpProxy) external onlyOwner {
        address yieldAddress = address(newYieldStrategy);
        address perpAddress = address(newPerpProxy);
        if (yieldAddress == address(0) || perpAddress == address(0) || yieldAddress == perpAddress) {
            revert ZeroAddress();
        }
        if (yieldAddress.code.length == 0) revert InvalidAdapter(yieldAddress);
        if (perpAddress.code.length == 0) revert InvalidAdapter(perpAddress);

        uint256 oldYieldAssets = address(yieldStrategy) == address(0) ? 0 : yieldStrategy.totalAssets();
        uint256 oldPerpAssets = address(perpProxy) == address(0) ? 0 : perpProxy.totalAssets();
        if (oldYieldAssets != 0 || oldPerpAssets != 0) {
            revert ActiveStrategyAssets(oldYieldAssets, oldPerpAssets);
        }

        address underlying = asset();
        if (newYieldStrategy.asset() != underlying) revert AdapterAssetMismatch(yieldAddress, underlying);
        if (newPerpProxy.asset() != underlying) revert AdapterAssetMismatch(perpAddress, underlying);
        uint256 leverage = newPerpProxy.leverageBps();
        if (leverage != 0 && leverage != BPS) revert PerpLeverageNotOneX(leverage);

        yieldStrategy = newYieldStrategy;
        perpProxy = newPerpProxy;
        emit StrategiesUpdated(yieldAddress, perpAddress);
    }

    /// @notice Set the sole address permitted to rebalance; owner has no rebalance bypass.
    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        address oldKeeper = keeper;
        keeper = newKeeper;
        emit KeeperUpdated(oldKeeper, newKeeper);
    }

    /// @notice Set vault-side bounds. Adapter implementations must also enforce these controls.
    function setRiskLimits(uint16 newMaxSlippageBps, uint32 newMaxDeadlineSeconds) external onlyOwner {
        if (
            newMaxSlippageBps > HARD_MAX_SLIPPAGE_BPS || newMaxDeadlineSeconds == 0
                || newMaxDeadlineSeconds > HARD_MAX_DEADLINE_SECONDS
        ) revert InvalidRiskLimits();
        maxAllowedSlippageBps = newMaxSlippageBps;
        maxDeadlineSeconds = newMaxDeadlineSeconds;
        emit RiskLimitsUpdated(newMaxSlippageBps, newMaxDeadlineSeconds);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rebalance strategy values; only the configured keeper/relay may call this entry point.
    function rebalance(RebalanceParams calldata params) external nonReentrant whenNotPaused onlyKeeper {
        _validateRebalance(params);
        _requireStrategies();

        uint256 nav = totalAssets();
        uint256 targetYield = nav.mulDiv(params.yieldBps, BPS);
        uint256 targetPerp = nav.mulDiv(params.perpBps, BPS);

        _unwindExcess(yieldStrategy, targetYield, params);
        _unwindExcess(IStrategyAdapter(address(perpProxy)), targetPerp, params);

        // Recompute targets after realized fees/PnL during exits.
        nav = totalAssets();
        targetYield = nav.mulDiv(params.yieldBps, BPS);
        targetPerp = nav.mulDiv(params.perpBps, BPS);
        uint256 idleFloor = nav.mulDiv(BPS - params.yieldBps - params.perpBps, BPS);
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        uint256 investable = idle > idleFloor ? idle - idleFloor : 0;

        investable = _investDeficit(yieldStrategy, targetYield, investable, params);
        _investDeficit(IStrategyAdapter(address(perpProxy)), targetPerp, investable, params);

        uint256 perpAssets = perpProxy.totalAssets();
        if (perpAssets != 0) {
            uint256 leverage = perpProxy.leverageBps();
            if (leverage != BPS) revert PerpLeverageNotOneX(leverage);
        }

        emit Rebalanced(
            msg.sender, params.yieldBps, params.perpBps, params.maxSlippageBps, params.deadline, totalAssets()
        );
    }

    function deposit(uint256 assets_, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        return super.deposit(assets_, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets_)
    {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets_, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        return super.withdraw(assets_, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 assets_)
    {
        return super.redeem(shares, receiver, owner_);
    }

    function _deposit(address caller, address receiver, uint256 assets_, uint256 shares) internal override {
        super._deposit(caller, receiver, assets_, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets_, uint256 shares)
        internal
        override
    {
        _ensureLiquidity(assets_);
        super._withdraw(caller, receiver, owner_, assets_, shares);
    }

    function _validateRebalance(RebalanceParams calldata params) internal view {
        uint256 sumBps = uint256(params.yieldBps) + params.perpBps;
        if (sumBps > BPS) revert InvalidAllocation(sumBps);
        if (params.maxSlippageBps > maxAllowedSlippageBps) {
            revert InvalidSlippage(params.maxSlippageBps, maxAllowedSlippageBps);
        }
        if (params.deadline < block.timestamp || params.deadline > block.timestamp + maxDeadlineSeconds) {
            revert InvalidDeadline(params.deadline, block.timestamp, maxDeadlineSeconds);
        }
    }

    function _requireStrategies() internal view {
        if (address(yieldStrategy) == address(0) || address(perpProxy) == address(0)) {
            revert InvalidAdapter(address(0));
        }
    }

    function _unwindExcess(IStrategyAdapter adapter, uint256 targetAssets, RebalanceParams calldata params) internal {
        uint256 current = adapter.totalAssets();
        if (current <= targetAssets) return;
        uint256 amountOut = current - targetAssets;
        uint256 capacity = adapter.maxWithdraw();
        if (amountOut > capacity) revert InsufficientLiquidity(amountOut, capacity);
        _withdrawFromAdapter(adapter, amountOut, params.maxSlippageBps, params.deadline, 0);
    }

    function _investDeficit(
        IStrategyAdapter adapter,
        uint256 targetAssets,
        uint256 investable,
        RebalanceParams calldata params
    ) internal returns (uint256 remaining) {
        remaining = investable;
        uint256 current = adapter.totalAssets();
        if (current >= targetAssets || remaining == 0) return remaining;

        uint256 amount = targetAssets - current;
        if (amount > remaining) amount = remaining;
        uint256 expectedPosition = adapter.previewDeposit(amount);
        uint256 minimumPosition = _minimumOut(expectedPosition, params.maxSlippageBps);
        if (minimumPosition == 0) revert InvalidPreview(address(adapter), amount);

        IERC20 underlying = IERC20(asset());
        uint256 beforeBalance = underlying.balanceOf(address(this));
        underlying.forceApprove(address(adapter), amount);
        uint256 reportedPosition = adapter.deposit(amount, minimumPosition, params.maxSlippageBps, params.deadline);
        underlying.forceApprove(address(adapter), 0);
        uint256 afterBalance = underlying.balanceOf(address(this));
        uint256 spent = beforeBalance > afterBalance ? beforeBalance - afterBalance : 0;
        if (spent != amount) revert UnexpectedAdapterSpend(address(adapter), amount, spent);
        if (reportedPosition < minimumPosition) {
            revert SlippageExceeded(address(adapter), reportedPosition, minimumPosition);
        }
        emit StrategyDeposit(address(adapter), amount, reportedPosition);
        remaining -= amount;
    }

    function _withdrawFromAdapter(
        IStrategyAdapter adapter,
        uint256 amount,
        uint16 slippageBps,
        uint256 deadline,
        uint256 minimumAssetsOverride
    ) internal returns (uint256 received) {
        uint256 expectedAssets = adapter.previewWithdraw(amount);
        uint256 minimumAssets =
            minimumAssetsOverride == 0 ? _minimumOut(expectedAssets, slippageBps) : minimumAssetsOverride;
        if (minimumAssets == 0) revert InvalidPreview(address(adapter), amount);
        if (expectedAssets < minimumAssets) {
            revert SlippageExceeded(address(adapter), expectedAssets, minimumAssets);
        }

        IERC20 underlying = IERC20(asset());
        uint256 beforeBalance = underlying.balanceOf(address(this));
        uint256 reportedAssets = adapter.withdraw(amount, minimumAssets, slippageBps, deadline);
        uint256 afterBalance = underlying.balanceOf(address(this));
        received = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
        if (received < minimumAssets) revert SlippageExceeded(address(adapter), received, minimumAssets);
        if (reportedAssets != received) {
            revert AdapterAccountingMismatch(address(adapter), reportedAssets, received);
        }
        emit StrategyWithdrawal(address(adapter), amount, received);
    }

    function _ensureLiquidity(uint256 requestedAssets) internal {
        IERC20 underlying = IERC20(asset());
        uint256 idle = underlying.balanceOf(address(this));
        if (idle >= requestedAssets) return;
        _requireStrategies();

        uint256 shortfall = requestedAssets - idle;
        uint256 yieldCapacity = yieldStrategy.maxWithdraw();
        uint256 yieldToWithdraw = shortfall < yieldCapacity ? shortfall : yieldCapacity;
        if (yieldToWithdraw != 0) {
            _withdrawFromAdapter(
                yieldStrategy,
                yieldToWithdraw,
                maxAllowedSlippageBps,
                block.timestamp + maxDeadlineSeconds,
                yieldToWithdraw
            );
        }

        idle = underlying.balanceOf(address(this));
        if (idle < requestedAssets) {
            shortfall = requestedAssets - idle;
            uint256 perpCapacity = perpProxy.maxWithdraw();
            uint256 perpToWithdraw = shortfall < perpCapacity ? shortfall : perpCapacity;
            if (perpToWithdraw != 0) {
                _withdrawFromAdapter(
                    IStrategyAdapter(address(perpProxy)),
                    perpToWithdraw,
                    maxAllowedSlippageBps,
                    block.timestamp + maxDeadlineSeconds,
                    perpToWithdraw
                );
            }
        }

        idle = underlying.balanceOf(address(this));
        if (idle < requestedAssets) revert InsufficientLiquidity(requestedAssets, idle);
    }

    function _minimumOut(uint256 expected, uint16 slippageBps) internal pure returns (uint256) {
        return expected.mulDiv(BPS - slippageBps, BPS);
    }
}
