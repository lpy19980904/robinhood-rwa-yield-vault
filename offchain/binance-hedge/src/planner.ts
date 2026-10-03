import { createHash } from "node:crypto";
import {
  divideDecimal,
  floorToStep,
  formatDecimal,
  isMultipleOfStep,
  multiplyDecimal,
  parseDecimal,
} from "./decimal";
import { SUPPORTED_SYMBOLS, type SupportedSymbol, ValidatedMarketSnapshot } from "./market-data";

const BPS = 10_000n;
const SUPPORTED_ORDER = new Map(SUPPORTED_SYMBOLS.map((symbol, index) => [symbol, index]));

export type PositionMode = "ONE_WAY" | "HEDGE";
export type OrderSide = "BUY" | "SELL";
export type HedgeIntent = "INCREASE_SHORT" | "REDUCE_SHORT";

interface PlannedOrderBase {
  planId: string;
  symbol: SupportedSymbol;
  side: OrderSide;
  intent: HedgeIntent;
  quantity: string;
  positionMode: PositionMode;
}

export type PlannedOrder =
  | (PlannedOrderBase & { positionMode: "ONE_WAY"; positionSide: "BOTH"; reduceOnly: boolean })
  | (PlannedOrderBase & { positionMode: "HEDGE"; positionSide: "SHORT"; reduceOnly?: never });

export interface HedgeAssetInput {
  symbol: SupportedSymbol;
  /** Robinhood Chain spot quantity supplied by the caller; this module does not query chain balances. */
  spotQuantity: string;
  /** Off-chain spot valuation input, in USDT. This is not vault NAV. */
  spotPriceUsdt: string;
  /** Externally observed current Binance short quantity; zero means no short position. */
  currentShortQuantity: string;
  market: ValidatedMarketSnapshot;
}

export interface HedgePlanningRequest {
  hedgeRatioBps: number;
  positionMode: PositionMode;
  assets: HedgeAssetInput[];
}

export interface AssetHedgePlan {
  symbol: SupportedSymbol;
  status: "PLANNED" | "NOOP" | "BLOCKED";
  reason?: "TARGET_ALREADY_MET" | "CHANGE_BELOW_MIN_QTY";
  spotQuantity: string;
  spotPriceUsdt: string;
  spotValueUsdt: string;
  currentShortQuantity: string;
  targetShortNotionalUsdt: string;
  targetShortQuantity: string;
  roundedTargetNotionalUsdt: string;
  markPriceUsdt: string;
  fundingRateBps: string;
  fundingIntervalHours: number;
  marketObservedAtMs: number;
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  contractSizeBase: string;
  orders: PlannedOrder[];
}

export interface HedgePlan {
  mode: "DRY_RUN_ONLY";
  positionMode: PositionMode;
  hedgeRatioBps: number;
  assets: AssetHedgePlan[];
}

function compareSupportedSymbols(left: SupportedSymbol, right: SupportedSymbol): number {
  return (SUPPORTED_ORDER.get(left) ?? 0) - (SUPPORTED_ORDER.get(right) ?? 0);
}

function planId(fields: string): string {
  return `plan-${createHash("sha256").update(fields).digest("hex").slice(0, 20)}`;
}

function splitIntoOrderChunks(total: bigint, step: bigint, minQty: bigint, maxQty: bigint): bigint[] {
  if (total <= 0n || !isMultipleOfStep(total, step)) throw new Error("Order delta must be a positive step-size multiple");
  const totalSteps = total / step;
  const maxSteps = maxQty / step;
  const chunkCount = (totalSteps + maxSteps - 1n) / maxSteps;
  const baseSteps = totalSteps / chunkCount;
  const extraSteps = totalSteps % chunkCount;
  const minSteps = minQty / step;
  const chunks: bigint[] = [];

  for (let index = 0n; index < chunkCount; index += 1n) {
    const chunkSteps = baseSteps + (index < extraSteps ? 1n : 0n);
    const chunk = chunkSteps * step;
    if (chunk < minQty || chunk > maxQty) throw new Error("Cannot split order delta into valid min/max quantity chunks");
    chunks.push(chunk);
  }
  if (chunks.reduce((sum, chunk) => sum + chunk, 0n) !== total || baseSteps < minSteps) {
    throw new Error("Cannot split order delta into valid quantity chunks");
  }
  return chunks;
}

function createOrders(
  asset: HedgeAssetInput,
  request: HedgePlanningRequest,
  currentQty: bigint,
  targetQty: bigint,
  delta: bigint,
  step: bigint,
  minQty: bigint,
  maxQty: bigint,
): PlannedOrder[] {
  const intent: HedgeIntent = targetQty > currentQty ? "INCREASE_SHORT" : "REDUCE_SHORT";
  const side: OrderSide = intent === "INCREASE_SHORT" ? "SELL" : "BUY";
  const chunks = splitIntoOrderChunks(delta, step, minQty, maxQty);
  const orders: PlannedOrder[] = [];

  chunks.forEach((quantityUnits, index) => {
    const quantity = formatDecimal(quantityUnits);
    const identity = [
      asset.symbol,
      request.positionMode,
      intent,
      side,
      quantity,
      index.toString(),
      formatDecimal(currentQty),
      formatDecimal(targetQty),
      request.hedgeRatioBps.toString(),
      asset.market.markPriceUsdt,
      asset.market.observedAtMs.toString(),
      asset.market.fundingRateBps,
    ].join("|");
    const base: PlannedOrderBase = {
      planId: planId(identity),
      symbol: asset.symbol,
      side,
      intent,
      quantity,
      positionMode: request.positionMode,
    };

    if (request.positionMode === "ONE_WAY") {
      orders.push({ ...base, positionMode: "ONE_WAY", positionSide: "BOTH", reduceOnly: intent === "REDUCE_SHORT" });
    } else {
      // Binance hedge mode does not accept reduceOnly; SHORT positionSide + BUY closes/reduces this leg.
      orders.push({ ...base, positionMode: "HEDGE", positionSide: "SHORT" });
    }
  });
  return orders;
}

export function planHedges(request: HedgePlanningRequest): HedgePlan {
  if (!Number.isSafeInteger(request.hedgeRatioBps) || request.hedgeRatioBps < 0 || request.hedgeRatioBps > 10_000) {
    throw new Error("hedgeRatioBps must be an integer from 0 through 10000");
  }
  if (request.positionMode !== "ONE_WAY" && request.positionMode !== "HEDGE") {
    throw new Error("positionMode must be ONE_WAY or HEDGE");
  }
  if (!Array.isArray(request.assets)) throw new Error("assets must be an array");

  const symbols = new Set<SupportedSymbol>();
  for (const asset of request.assets) {
    if (!SUPPORTED_ORDER.has(asset.symbol)) throw new Error(`Unsupported symbol: ${String(asset.symbol)}`);
    if (symbols.has(asset.symbol)) throw new Error(`Duplicate symbol: ${asset.symbol}`);
    symbols.add(asset.symbol);
    if (!(asset.market instanceof ValidatedMarketSnapshot)) {
      throw new Error(`${asset.symbol} market data must come from validateMarketSnapshot()`);
    }
    if (asset.market.symbol !== asset.symbol) throw new Error(`${asset.symbol} market snapshot symbol mismatch`);
  }

  const assets = [...request.assets].sort((left, right) => compareSupportedSymbols(left.symbol, right.symbol));
  const plannedAssets = assets.map((asset): AssetHedgePlan => {
    const spotQuantity = parseDecimal(asset.spotQuantity, `${asset.symbol} spotQuantity`);
    const spotPrice = parseDecimal(asset.spotPriceUsdt, `${asset.symbol} spotPriceUsdt`);
    const currentQty = parseDecimal(asset.currentShortQuantity, `${asset.symbol} currentShortQuantity`);
    if (spotQuantity < 0n) throw new Error(`${asset.symbol} spotQuantity must be nonnegative`);
    if (spotPrice <= 0n) throw new Error(`${asset.symbol} spotPriceUsdt must be greater than zero`);
    if (currentQty < 0n) throw new Error(`${asset.symbol} currentShortQuantity must be nonnegative`);

    const step = parseDecimal(asset.market.stepSize, `${asset.symbol} stepSize`);
    const minQty = parseDecimal(asset.market.minQty, `${asset.symbol} minQty`);
    const maxQty = parseDecimal(asset.market.maxQty, `${asset.symbol} maxQty`);
    const markPrice = parseDecimal(asset.market.markPriceUsdt, `${asset.symbol} markPriceUsdt`);
    const contractSize = parseDecimal(asset.market.contractSizeBase, `${asset.symbol} contractSizeBase`);
    if (!isMultipleOfStep(currentQty, step)) {
      throw new Error(`${asset.symbol} currentShortQuantity must be aligned to the perpetual step size`);
    }

    const spotValue = multiplyDecimal(spotQuantity, spotPrice);
    const targetNotional = (spotValue * BigInt(request.hedgeRatioBps)) / BPS;
    const contractNotional = multiplyDecimal(markPrice, contractSize);
    const rawTargetQty = divideDecimal(targetNotional, contractNotional);
    const targetQty = floorToStep(rawTargetQty, step);
    const roundedTargetNotional = multiplyDecimal(multiplyDecimal(targetQty, contractSize), markPrice);
    const delta = targetQty >= currentQty ? targetQty - currentQty : currentQty - targetQty;

    const base: Omit<AssetHedgePlan, "orders" | "status" | "reason"> = {
      symbol: asset.symbol,
      spotQuantity: formatDecimal(spotQuantity),
      spotPriceUsdt: formatDecimal(spotPrice),
      spotValueUsdt: formatDecimal(spotValue),
      currentShortQuantity: formatDecimal(currentQty),
      targetShortNotionalUsdt: formatDecimal(targetNotional),
      targetShortQuantity: formatDecimal(targetQty),
      roundedTargetNotionalUsdt: formatDecimal(roundedTargetNotional),
      markPriceUsdt: asset.market.markPriceUsdt,
      fundingRateBps: asset.market.fundingRateBps,
      fundingIntervalHours: asset.market.fundingIntervalHours,
      marketObservedAtMs: asset.market.observedAtMs,
      tickSize: asset.market.tickSize,
      stepSize: asset.market.stepSize,
      minQty: asset.market.minQty,
      maxQty: asset.market.maxQty,
      contractSizeBase: asset.market.contractSizeBase,
    };

    if (delta === 0n) return { ...base, status: "NOOP", reason: "TARGET_ALREADY_MET", orders: [] };
    if (delta < minQty) return { ...base, status: "BLOCKED", reason: "CHANGE_BELOW_MIN_QTY", orders: [] };

    return {
      ...base,
      status: "PLANNED",
      orders: createOrders(asset, request, currentQty, targetQty, delta, step, minQty, maxQty),
    };
  });

  return {
    mode: "DRY_RUN_ONLY",
    positionMode: request.positionMode,
    hedgeRatioBps: request.hedgeRatioBps,
    assets: plannedAssets,
  };
}
