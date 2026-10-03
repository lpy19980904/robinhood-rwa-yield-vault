import assert from "node:assert/strict";
import test from "node:test";
import { OFFLINE_FIXTURE_AS_OF_MS, OFFLINE_MARKET_FIXTURES } from "../src/fixtures";
import {
  loadValidatedMarketSnapshot,
  SUPPORTED_SYMBOLS,
  type RawMarketSnapshot,
  type SupportedSymbol,
  validateMarketSnapshot,
} from "../src/market-data";
import { planHedges, type HedgeAssetInput } from "../src/planner";

const testNowMs = OFFLINE_FIXTURE_AS_OF_MS;

function rawMarket(symbol: SupportedSymbol): RawMarketSnapshot {
  const fixture = OFFLINE_MARKET_FIXTURES.find((item) => item.symbol === symbol);
  assert.ok(fixture, `missing offline fixture for ${symbol}`);
  return { ...fixture, metadata: { ...fixture.metadata } };
}

function validatedMarket(symbol: SupportedSymbol, overrides: Partial<RawMarketSnapshot> = {}) {
  const raw = { ...rawMarket(symbol), ...overrides };
  if (overrides.metadata) raw.metadata = { ...rawMarket(symbol).metadata, ...overrides.metadata };
  return validateMarketSnapshot(raw, symbol, { nowMs: testNowMs, maxAgeMs: 0 });
}

function asset(
  symbol: SupportedSymbol,
  overrides: Partial<Omit<HedgeAssetInput, "symbol" | "market">> = {},
  marketOverrides: Partial<RawMarketSnapshot> = {},
): HedgeAssetInput {
  return {
    symbol,
    spotQuantity: "10",
    spotPriceUsdt: "200",
    currentShortQuantity: "2",
    market: validatedMarket(symbol, marketOverrides),
    ...overrides,
  };
}

test("supports exactly the five confirmed Binance equity perpetual symbols", () => {
  assert.deepEqual(SUPPORTED_SYMBOLS, ["AAPLUSDT", "NVDAUSDT", "AMZNUSDT", "AVGOUSDT", "QQQUSDT"]);
  for (const symbol of SUPPORTED_SYMBOLS) {
    assert.doesNotThrow(() => validateMarketSnapshot(rawMarket(symbol), symbol, { nowMs: testNowMs, maxAgeMs: 0 }));
  }
});

test("calculates target short notional and builds a deterministic, step-rounded one-way open plan", () => {
  const input = asset("AAPLUSDT", { spotPriceUsdt: "200", currentShortQuantity: "2" }, { markPriceUsdt: "205" });
  const request = { hedgeRatioBps: 5_000, positionMode: "ONE_WAY" as const, assets: [input] };
  const first = planHedges(request);
  const second = planHedges(request);
  const result = first.assets[0];

  assert.equal(first.mode, "DRY_RUN_ONLY");
  assert.equal(result.targetShortNotionalUsdt, "1000");
  assert.equal(result.targetShortQuantity, "4.878");
  assert.equal(result.roundedTargetNotionalUsdt, "999.99");
  assert.equal(result.spotPriceUsdt, "200");
  assert.equal(result.markPriceUsdt, "205");
  assert.equal(result.fundingRateBps, "0.15");
  assert.equal(result.stepSize, "0.001");
  assert.equal(result.contractSizeBase, "1");
  assert.equal(result.status, "PLANNED");
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].side, "SELL");
  assert.equal(result.orders[0].intent, "INCREASE_SHORT");
  assert.equal(result.orders[0].positionSide, "BOTH");
  assert.equal(result.orders[0].reduceOnly, false);
  assert.equal(result.orders[0].quantity, "2.878");
  assert.equal(result.orders[0].planId, second.assets[0].orders[0].planId);
});

test("one-way short reductions use BUY and reduceOnly=true", () => {
  const input = asset("NVDAUSDT", { currentShortQuantity: "6" }, { markPriceUsdt: "200" });
  const result = planHedges({ hedgeRatioBps: 5_000, positionMode: "ONE_WAY", assets: [input] }).assets[0];
  assert.equal(result.targetShortQuantity, "5");
  assert.equal(result.orders[0].side, "BUY");
  assert.equal(result.orders[0].intent, "REDUCE_SHORT");
  assert.equal(result.orders[0].reduceOnly, true);
  assert.equal(result.orders[0].positionSide, "BOTH");
});

test("hedge-mode opens and closes the SHORT leg without sending reduceOnly", () => {
  const opening = planHedges({
    hedgeRatioBps: 5_000,
    positionMode: "HEDGE",
    assets: [asset("AAPLUSDT", { currentShortQuantity: "0" }, { markPriceUsdt: "200" })],
  }).assets[0].orders[0];
  assert.equal(opening.side, "SELL");
  assert.equal(opening.positionSide, "SHORT");
  assert.equal("reduceOnly" in opening, false);

  const closing = planHedges({
    hedgeRatioBps: 5_000,
    positionMode: "HEDGE",
    assets: [asset("AAPLUSDT", { currentShortQuantity: "15" }, { markPriceUsdt: "200" })],
  }).assets[0].orders[0];
  assert.equal(closing.side, "BUY");
  assert.equal(closing.intent, "REDUCE_SHORT");
  assert.equal(closing.positionSide, "SHORT");
  assert.equal("reduceOnly" in closing, false);
});

test("splits large planned changes into deterministic chunks within maxQty", () => {
  const input = asset(
    "AAPLUSDT",
    { spotQuantity: "10", spotPriceUsdt: "200", currentShortQuantity: "0" },
    { markPriceUsdt: "205", metadata: { ...rawMarket("AAPLUSDT").metadata, maxQty: "1" } },
  );
  const result = planHedges({ hedgeRatioBps: 5_000, positionMode: "ONE_WAY", assets: [input] }).assets[0];
  assert.equal(result.targetShortQuantity, "4.878");
  assert.equal(result.orders.length, 5);
  assert.ok(result.orders.every((order) => Number(order.quantity) <= 1));
  assert.equal(result.orders.reduce((sum, order) => sum + Number(order.quantity), 0), 4.878);
  assert.equal(new Set(result.orders.map((order) => order.planId)).size, result.orders.length);
});

test("does not fabricate an order for a below-minimum change", () => {
  const input = asset(
    "AAPLUSDT",
    { spotQuantity: "0.005", spotPriceUsdt: "100", currentShortQuantity: "0" },
    { markPriceUsdt: "100", metadata: { ...rawMarket("AAPLUSDT").metadata, minQty: "0.01" } },
  );
  const result = planHedges({ hedgeRatioBps: 10_000, positionMode: "ONE_WAY", assets: [input] }).assets[0];
  assert.equal(result.targetShortQuantity, "0.005");
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "CHANGE_BELOW_MIN_QTY");
  assert.deepEqual(result.orders, []);
});

test("returns a no-op when the current short equals the rounded target", () => {
  const result = planHedges({
    hedgeRatioBps: 5_000,
    positionMode: "ONE_WAY",
    assets: [asset("AAPLUSDT", { currentShortQuantity: "5" }, { markPriceUsdt: "200" })],
  }).assets[0];
  assert.equal(result.status, "NOOP");
  assert.equal(result.reason, "TARGET_ALREADY_MET");
  assert.deepEqual(result.orders, []);
});

test("sorts output in the fixed supported-symbol order regardless of input order", () => {
  const result = planHedges({
    hedgeRatioBps: 5_000,
    positionMode: "ONE_WAY",
    assets: [asset("QQQUSDT"), asset("AMZNUSDT"), asset("NVDAUSDT")],
  });
  assert.deepEqual(result.assets.map((item) => item.symbol), ["NVDAUSDT", "AMZNUSDT", "QQQUSDT"]);
});

test("rejects stale, future, malformed, mismatched, or unsupported market data", () => {
  const good = rawMarket("AAPLUSDT");
  assert.throws(() => validateMarketSnapshot(good, "AAPLUSDT", { nowMs: testNowMs + 1_001, maxAgeMs: 1_000 }), /stale/);
  assert.throws(() => validateMarketSnapshot({ ...good, observedAtMs: testNowMs + 10_000 }, "AAPLUSDT", { nowMs: testNowMs }), /future/);
  assert.throws(() => validateMarketSnapshot({ ...good, symbol: "BTCUSDT" }, "AAPLUSDT", { nowMs: testNowMs }), /supported requested symbol/);
  assert.throws(() => validateMarketSnapshot({ ...good, markPriceUsdt: "NaN" }, "AAPLUSDT", { nowMs: testNowMs }), /markPriceUsdt/);
  assert.throws(() => validateMarketSnapshot({ ...good, fundingRateBps: "10001" }, "AAPLUSDT", { nowMs: testNowMs }), /fundingRateBps/);
  assert.throws(
    () => validateMarketSnapshot({ ...good, metadata: { ...good.metadata, maxQty: "100000.0005" } }, "AAPLUSDT", { nowMs: testNowMs }),
    /multiples/,
  );
  assert.throws(() => validateMarketSnapshot(good, "BTCUSDT" as SupportedSymbol, { nowMs: testNowMs }), /Unsupported Binance symbol/);
});

test("requires current position sizes to align with the validated quantity step", () => {
  assert.throws(
    () => planHedges({ hedgeRatioBps: 5_000, positionMode: "ONE_WAY", assets: [asset("AAPLUSDT", { currentShortQuantity: "2.0005" })] }),
    /aligned to the perpetual step size/,
  );
});

test("uses only an injected read-only provider when market data is requested", async () => {
  const reads: string[] = [];
  const snapshot = await loadValidatedMarketSnapshot(
    {
      async readMarketData(symbol) {
        reads.push(symbol);
        return rawMarket(symbol);
      },
    },
    "AVGOUSDT",
    { nowMs: testNowMs, maxAgeMs: 0 },
  );
  assert.deepEqual(reads, ["AVGOUSDT"]);
  assert.equal(snapshot.symbol, "AVGOUSDT");
  assert.equal(snapshot.fundingRateBps, "0.1");
});

test("rejects unvalidated market objects and duplicate symbols", () => {
  const raw = rawMarket("AAPLUSDT");
  assert.throws(
    () => planHedges({
      hedgeRatioBps: 5_000,
      positionMode: "ONE_WAY",
      assets: [{ ...asset("AAPLUSDT"), market: raw as unknown as ReturnType<typeof validatedMarket> }],
    }),
    /validateMarketSnapshot/,
  );
  assert.throws(
    () => planHedges({ hedgeRatioBps: 5_000, positionMode: "ONE_WAY", assets: [asset("AAPLUSDT"), asset("AAPLUSDT")] }),
    /Duplicate symbol/,
  );
});
