const BPS = 10_000n;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function dynamicSlippageBps(base: number, volatility: bigint, factor: number, maximum: number): number {
  const volatilityAddition = (volatility * BigInt(factor) + BPS - 1n) / BPS;
  const computed = BigInt(base) + volatilityAddition;
  return Number(min(computed, BigInt(maximum)));
}

export function computePortfolioApyBps(
  stakedApyBps: bigint,
  fundingBpsPerDay: bigint,
  yieldBps: number,
  perpBps: number,
): bigint {
  const yieldContribution = (stakedApyBps * BigInt(yieldBps)) / BPS;
  const annualizedShortFunding = fundingBpsPerDay * 365n;
  const fundingContribution = (annualizedShortFunding * BigInt(perpBps)) / BPS;
  return yieldContribution + fundingContribution;
}

export function allocationDriftBps(
  nav: bigint,
  yieldAssets: bigint,
  perpAssets: bigint,
  targetYieldBps: number,
  targetPerpBps: number,
): bigint {
  if (nav === 0n) return 0n;
  const targetYield = (nav * BigInt(targetYieldBps)) / BPS;
  const targetPerp = (nav * BigInt(targetPerpBps)) / BPS;
  const yieldDrift = (abs(yieldAssets - targetYield) * BPS) / nav;
  const perpDrift = (abs(perpAssets - targetPerp) * BPS) / nav;
  return yieldDrift > perpDrift ? yieldDrift : perpDrift;
}
