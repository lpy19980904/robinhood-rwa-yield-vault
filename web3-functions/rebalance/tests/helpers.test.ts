import assert from "node:assert/strict";
import test from "node:test";
import { allocationDriftBps, computePortfolioApyBps, dynamicSlippageBps } from "../policy";

test("weights staked APY and annualized short funding into portfolio bps", () => {
  assert.equal(computePortfolioApyBps(800n, 20n, 6_000, 2_000), 1_940n);
});

test("negative funding reduces the short contribution", () => {
  assert.equal(computePortfolioApyBps(800n, -20n, 6_000, 2_000), -980n);
});

test("computes maximum allocation drift against target leg values", () => {
  assert.equal(allocationDriftBps(10_000n, 7_000n, 1_000n, 6_000, 2_000), 1_000n);
});

test("adds volatility premium to base slippage and respects the hard cap", () => {
  assert.equal(dynamicSlippageBps(50, 250n, 10_000, 500), 300);
  assert.equal(dynamicSlippageBps(400, 500n, 10_000, 500), 500);
});
