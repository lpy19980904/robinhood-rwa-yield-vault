import { isMultipleOfStep, parseDecimal } from "./decimal";

export const SUPPORTED_SYMBOLS = ["AAPLUSDT", "NVDAUSDT", "AMZNUSDT", "AVGOUSDT", "QQQUSDT"] as const;
export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

export interface RawMarketSnapshot {
  symbol: string;
  marketType: string;
  quoteAsset: string;
  observedAtMs: number;
  markPriceUsdt: string;
  fundingRateBps: string;
  fundingIntervalHours: number;
  metadata: {
    tickSize: string;
    stepSize: string;
    minQty: string;
    maxQty: string;
    contractSizeBase: string;
  };
}

export interface MarketValidationOptions {
  nowMs?: number;
  maxAgeMs?: number;
  allowedFutureSkewMs?: number;
}

interface ValidatedMarketData {
  symbol: SupportedSymbol;
  observedAtMs: number;
  markPriceUsdt: string;
  fundingRateBps: string;
  fundingIntervalHours: number;
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  contractSizeBase: string;
}

const MARKET_SNAPSHOT_TOKEN = Symbol("validated-read-only-market-snapshot");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function positiveDecimal(value: string, label: string): bigint {
  const parsed = parseDecimal(value, label);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

/**
 * An opaque runtime-validated snapshot. Construct it only through
 * validateMarketSnapshot() or loadValidatedMarketSnapshot().
 */
export class ValidatedMarketSnapshot {
  readonly symbol: SupportedSymbol;
  readonly observedAtMs: number;
  readonly markPriceUsdt: string;
  readonly fundingRateBps: string;
  readonly fundingIntervalHours: number;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minQty: string;
  readonly maxQty: string;
  readonly contractSizeBase: string;

  private constructor(data: ValidatedMarketData, token: typeof MARKET_SNAPSHOT_TOKEN) {
    if (token !== MARKET_SNAPSHOT_TOKEN) throw new Error("Market snapshots must pass runtime validation");
    Object.assign(this, data);
    this.symbol = data.symbol;
    this.observedAtMs = data.observedAtMs;
    this.markPriceUsdt = data.markPriceUsdt;
    this.fundingRateBps = data.fundingRateBps;
    this.fundingIntervalHours = data.fundingIntervalHours;
    this.tickSize = data.tickSize;
    this.stepSize = data.stepSize;
    this.minQty = data.minQty;
    this.maxQty = data.maxQty;
    this.contractSizeBase = data.contractSizeBase;
    Object.freeze(this);
  }

  /** @internal Use validateMarketSnapshot() as the public parsing boundary. */
  static fromValidatedData(data: ValidatedMarketData, token: typeof MARKET_SNAPSHOT_TOKEN): ValidatedMarketSnapshot {
    if (token !== MARKET_SNAPSHOT_TOKEN) throw new Error("Market snapshots must pass runtime validation");
    return new ValidatedMarketSnapshot(data, token);
  }
}

export function isSupportedSymbol(value: string): value is SupportedSymbol {
  return (SUPPORTED_SYMBOLS as readonly string[]).includes(value);
}

export function validateMarketSnapshot(
  input: unknown,
  expectedSymbol: SupportedSymbol,
  options: MarketValidationOptions = {},
): ValidatedMarketSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const allowedFutureSkewMs = options.allowedFutureSkewMs ?? 5_000;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("nowMs must be a nonnegative safe integer");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new Error("maxAgeMs must be a nonnegative safe integer");
  if (!Number.isSafeInteger(allowedFutureSkewMs) || allowedFutureSkewMs < 0) {
    throw new Error("allowedFutureSkewMs must be a nonnegative safe integer");
  }
  if (!isSupportedSymbol(expectedSymbol)) throw new Error(`Unsupported Binance symbol: ${expectedSymbol}`);
  if (!isRecord(input)) throw new Error("Market snapshot must be an object");

  const symbol = requireString(input, "symbol", "Market symbol");
  if (!isSupportedSymbol(symbol) || symbol !== expectedSymbol) {
    throw new Error(`Market symbol must match a supported requested symbol (${expectedSymbol})`);
  }
  if (input.marketType !== "EQUITY_PERPETUAL") throw new Error("marketType must be EQUITY_PERPETUAL");
  if (input.quoteAsset !== "USDT") throw new Error("quoteAsset must be USDT");

  const observedAtMs = input.observedAtMs;
  if (!Number.isSafeInteger(observedAtMs) || (observedAtMs as number) < 0) {
    throw new Error("observedAtMs must be a nonnegative safe integer");
  }
  const ageMs = nowMs - (observedAtMs as number);
  if (ageMs > maxAgeMs) throw new Error(`Market snapshot is stale by ${ageMs - maxAgeMs} ms`);
  if (ageMs < -allowedFutureSkewMs) throw new Error("Market snapshot timestamp is too far in the future");

  const markPriceUsdt = requireString(input, "markPriceUsdt", "markPriceUsdt");
  positiveDecimal(markPriceUsdt, "markPriceUsdt");
  const fundingRateBps = requireString(input, "fundingRateBps", "fundingRateBps");
  const fundingUnits = parseDecimal(fundingRateBps, "fundingRateBps");
  if (fundingUnits < -10_000n * 10n ** 12n || fundingUnits > 10_000n * 10n ** 12n) {
    throw new Error("fundingRateBps must be between -10000 and 10000 bps per funding interval");
  }
  const fundingIntervalHours = input.fundingIntervalHours;
  if (!Number.isSafeInteger(fundingIntervalHours) || (fundingIntervalHours as number) < 1 || (fundingIntervalHours as number) > 24) {
    throw new Error("fundingIntervalHours must be an integer from 1 through 24");
  }

  if (!isRecord(input.metadata)) throw new Error("metadata must be an object");
  const tickSize = requireString(input.metadata, "tickSize", "metadata.tickSize");
  const stepSize = requireString(input.metadata, "stepSize", "metadata.stepSize");
  const minQty = requireString(input.metadata, "minQty", "metadata.minQty");
  const maxQty = requireString(input.metadata, "maxQty", "metadata.maxQty");
  const contractSizeBase = requireString(input.metadata, "contractSizeBase", "metadata.contractSizeBase");
  positiveDecimal(tickSize, "metadata.tickSize");
  const stepUnits = positiveDecimal(stepSize, "metadata.stepSize");
  const minQtyUnits = positiveDecimal(minQty, "metadata.minQty");
  const maxQtyUnits = positiveDecimal(maxQty, "metadata.maxQty");
  positiveDecimal(contractSizeBase, "metadata.contractSizeBase");
  if (maxQtyUnits < minQtyUnits) throw new Error("metadata.maxQty must be at least metadata.minQty");
  if (!isMultipleOfStep(minQtyUnits, stepUnits) || !isMultipleOfStep(maxQtyUnits, stepUnits)) {
    throw new Error("metadata.minQty and metadata.maxQty must be exact multiples of metadata.stepSize");
  }

  return ValidatedMarketSnapshot.fromValidatedData({
    symbol,
    observedAtMs: observedAtMs as number,
    markPriceUsdt,
    fundingRateBps,
    fundingIntervalHours: fundingIntervalHours as number,
    tickSize,
    stepSize,
    minQty,
    maxQty,
    contractSizeBase,
  }, MARKET_SNAPSHOT_TOKEN);
}

/** Injected data source has a read-only shape; this module implements no HTTP or exchange client. */
export interface ReadOnlyMarketDataProvider {
  readMarketData(symbol: SupportedSymbol): Promise<unknown>;
}

export async function loadValidatedMarketSnapshot(
  provider: ReadOnlyMarketDataProvider,
  symbol: SupportedSymbol,
  options: MarketValidationOptions = {},
): Promise<ValidatedMarketSnapshot> {
  return validateMarketSnapshot(await provider.readMarketData(symbol), symbol, options);
}
