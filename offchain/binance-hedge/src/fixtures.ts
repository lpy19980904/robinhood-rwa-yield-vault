import type { RawMarketSnapshot } from "./market-data";

/** Synthetic offline data only; values are illustrative and are not live Binance market data. */
export const OFFLINE_FIXTURE_AS_OF_MS = 1_791_072_000_000;

export const OFFLINE_MARKET_FIXTURES: readonly RawMarketSnapshot[] = [
  {
    symbol: "AAPLUSDT",
    marketType: "EQUITY_PERPETUAL",
    quoteAsset: "USDT",
    observedAtMs: OFFLINE_FIXTURE_AS_OF_MS,
    markPriceUsdt: "200",
    fundingRateBps: "0.15",
    fundingIntervalHours: 8,
    metadata: { tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "100000", contractSizeBase: "1" },
  },
  {
    symbol: "NVDAUSDT",
    marketType: "EQUITY_PERPETUAL",
    quoteAsset: "USDT",
    observedAtMs: OFFLINE_FIXTURE_AS_OF_MS,
    markPriceUsdt: "120",
    fundingRateBps: "-0.2",
    fundingIntervalHours: 8,
    metadata: { tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "100000", contractSizeBase: "1" },
  },
  {
    symbol: "AMZNUSDT",
    marketType: "EQUITY_PERPETUAL",
    quoteAsset: "USDT",
    observedAtMs: OFFLINE_FIXTURE_AS_OF_MS,
    markPriceUsdt: "180",
    fundingRateBps: "0.05",
    fundingIntervalHours: 8,
    metadata: { tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "100000", contractSizeBase: "1" },
  },
  {
    symbol: "AVGOUSDT",
    marketType: "EQUITY_PERPETUAL",
    quoteAsset: "USDT",
    observedAtMs: OFFLINE_FIXTURE_AS_OF_MS,
    markPriceUsdt: "170",
    fundingRateBps: "0.1",
    fundingIntervalHours: 8,
    metadata: { tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "100000", contractSizeBase: "1" },
  },
  {
    symbol: "QQQUSDT",
    marketType: "EQUITY_PERPETUAL",
    quoteAsset: "USDT",
    observedAtMs: OFFLINE_FIXTURE_AS_OF_MS,
    markPriceUsdt: "500",
    fundingRateBps: "-0.1",
    fundingIntervalHours: 8,
    metadata: { tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "100000", contractSizeBase: "1" },
  },
];
