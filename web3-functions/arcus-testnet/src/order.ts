import { createPublicKey, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { ARCUS_TESTNET_BASE_URL, assertTestnetConfig, type ArcusTestnetConfig } from "./config";

const NANOSECONDS_PER_MICROSECOND = 1_000n;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const MIN_GTT_LEAD_MICROSECONDS = 31n * 24n * 60n * 60n * MICROSECONDS_PER_SECOND;
const MAX_SIGNED_TIMESTAMP = 9_223_372_036_854_775_807n;
const TIME_IN_FORCE_CODE: Record<ArcusTimeInForce, 0 | 1 | 2 | 3> = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };

export type ArcusSide = "BUY" | "SELL";
export type ArcusOrderType = "LIMIT" | "MARKET";
export type ArcusTimeInForce = "GTT" | "FOK" | "IOC" | "ALO";
export type PositionSide = "LONG" | "SHORT";

export interface MarketPrecision {
  marketId: number;
  tickSize: string;
  stepSize: string;
}

export interface PlaceOrderInput extends MarketPrecision {
  quantity: string;
  price: string;
  side: ArcusSide;
  orderType: ArcusOrderType;
  timeInForce: ArcusTimeInForce;
  goodTilTimeUs: string;
  reduceOnly?: boolean;
  clientId?: string;
}

export type CloseOrderInput = Omit<PlaceOrderInput, "side" | "reduceOnly">;

export interface ArcusSigningPayload {
  ad: string;
  ai: number;
  c?: string;
  ct: bigint;
  g: bigint;
  m: number;
  op: 1;
  p: bigint;
  q: bigint;
  r: 0 | 1;
  s: 0 | 1;
  t: 0 | 1 | 2 | 3;
  v: 1;
}

export interface ArcusOrderBody {
  address: string;
  accountIndex: number;
  marketId: number;
  side: ArcusSide;
  orderType: ArcusOrderType;
  quantity: string;
  price: string;
  timeInForce: ArcusTimeInForce;
  goodTilTime: string;
  timestamp: bigint;
  clientTime: string;
  reduceOnly: boolean;
  clientId?: string;
}

export interface PreparedArcusOrder {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: ArcusOrderBody;
  bodyText: string;
  signingPayload: ArcusSigningPayload;
  signingMessage: string;
  signature: string;
}

function decimalParts(value: string, label: string): { units: bigint; scale: number } {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`${label} must be a plain non-negative decimal string`);
  }
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function exactUnits(value: string, quantum: string, label: string): bigint {
  const v = decimalParts(value, label);
  const q = decimalParts(quantum, `${label} quantum`);
  if (q.units <= 0n || v.units <= 0n) throw new Error(`${label} and its quantum must be positive`);
  const scale = Math.max(v.scale, q.scale);
  const scaledValue = v.units * 10n ** BigInt(scale - v.scale);
  const scaledQuantum = q.units * 10n ** BigInt(scale - q.scale);
  if (scaledValue % scaledQuantum !== 0n) {
    throw new Error(`${label} must be an exact multiple of its market quantum`);
  }
  return scaledValue / scaledQuantum;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical payload numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${entries.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported value in canonical JSON");
}

function publicApiKey(privateKey: KeyObject): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Arcus request signer must be an Ed25519 private KeyObject");
  }
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(publicDer).subarray(-32);
  if (rawPublicKey.length !== 32) throw new Error("Could not derive the Arcus Ed25519 public API key");
  return rawPublicKey.toString("hex");
}

function validateInput(input: PlaceOrderInput, nowNs: bigint): { p: bigint; q: bigint; goodTilTimeUs: bigint } {
  if (!Number.isSafeInteger(input.marketId) || input.marketId < 0 || input.marketId > 65_535) {
    throw new Error("marketId must be an integer from 0 through 65535");
  }
  if (!(input.side === "BUY" || input.side === "SELL")) throw new Error("side must be BUY or SELL");
  if (!(input.orderType === "LIMIT" || input.orderType === "MARKET")) throw new Error("orderType must be LIMIT or MARKET");
  if (!Object.hasOwn(TIME_IN_FORCE_CODE, input.timeInForce)) throw new Error("Unsupported timeInForce");
  if (input.clientId !== undefined && !/^[A-Za-z0-9_-]{1,36}$/.test(input.clientId)) {
    throw new Error("clientId must contain 1–36 ASCII letters, digits, hyphens or underscores");
  }
  if (!/^[0-9]+$/.test(input.goodTilTimeUs)) throw new Error("goodTilTimeUs must be an epoch-microseconds integer string");
  const goodTilTimeUs = BigInt(input.goodTilTimeUs);
  if (nowNs <= 0n || nowNs > MAX_SIGNED_TIMESTAMP) throw new Error("X-Timestamp must be a valid Unix-nanoseconds integer");
  const nowUs = nowNs / NANOSECONDS_PER_MICROSECOND;
  if (goodTilTimeUs < nowUs + MIN_GTT_LEAD_MICROSECONDS) {
    throw new Error("Arcus goodTilTime must be at least 31 days ahead (conservative one-month guard)");
  }
  return {
    p: exactUnits(input.price, input.tickSize, "price"),
    q: exactUnits(input.quantity, input.stepSize, "quantity"),
    goodTilTimeUs,
  };
}

/**
 * Map an existing position side to the opposite order side and force reduceOnly.
 * The caller cannot choose a potentially position-increasing close direction.
 */
export function buildCloseOrder(positionSide: PositionSide, input: CloseOrderInput): PlaceOrderInput {
  if (positionSide !== "LONG" && positionSide !== "SHORT") throw new Error("positionSide must be LONG or SHORT");
  return {
    ...input,
    side: positionSide === "LONG" ? "SELL" : "BUY",
    reduceOnly: true,
  };
}

export function preparePlaceOrder(
  config: ArcusTestnetConfig,
  input: PlaceOrderInput,
  privateKey: KeyObject,
  nowNs: bigint = BigInt(Date.now()) * 1_000_000n,
): PreparedArcusOrder {
  assertTestnetConfig(config);
  if (!config.address) throw new Error("ARCUS_ADDRESS is required to sign an Arcus order");

  const address = config.address.toLowerCase();
  const { p, q, goodTilTimeUs } = validateInput(input, nowNs);
  const apiKey = publicApiKey(privateKey);
  if (config.apiKey !== undefined && config.apiKey.toLowerCase() !== apiKey) {
    throw new Error("ARCUS_API_KEY does not match the supplied Ed25519 signing key");
  }

  const signingPayload: ArcusSigningPayload = {
    ad: address,
    ai: config.accountIndex,
    ...(input.clientId ? { c: input.clientId } : {}),
    ct: nowNs,
    g: goodTilTimeUs * NANOSECONDS_PER_MICROSECOND,
    m: input.marketId,
    op: 1,
    p,
    q,
    r: input.reduceOnly ? 1 : 0,
    s: input.side === "BUY" ? 0 : 1,
    t: TIME_IN_FORCE_CODE[input.timeInForce],
    v: 1,
  };
  const signingMessage = canonicalJson(signingPayload);
  const signature = ed25519Sign(null, Buffer.from(signingMessage, "utf8"), privateKey).toString("hex");

  const body: ArcusOrderBody = {
    address,
    accountIndex: config.accountIndex,
    marketId: input.marketId,
    side: input.side,
    orderType: input.orderType,
    quantity: input.quantity,
    price: input.price,
    timeInForce: input.timeInForce,
    goodTilTime: goodTilTimeUs.toString(10),
    timestamp: nowNs,
    clientTime: nowNs.toString(10),
    reduceOnly: Boolean(input.reduceOnly),
    ...(input.clientId ? { clientId: input.clientId } : {}),
  };
  const bodyText = canonicalJson(body);
  return {
    method: "POST",
    url: `${ARCUS_TESTNET_BASE_URL}/v1/placeOrder`,
    headers: {
      "content-type": "application/json",
      "X-API-Key": apiKey,
      "X-Signature": signature,
      "X-Timestamp": nowNs.toString(10),
    },
    body,
    bodyText,
    signingPayload,
    signingMessage,
    signature,
  };
}

export { canonicalJson };
