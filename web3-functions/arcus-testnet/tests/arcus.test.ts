import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { ARCUS_TESTNET_BASE_URL, assertTestnetConfig, readArcusConfig } from "../src/config";
import { executePlaceOrder } from "../src/client";
import { buildCloseOrder, preparePlaceOrder, type CloseOrderInput, type PlaceOrderInput } from "../src/order";

const fixedNowNs = BigInt(Date.UTC(2026, 0, 1)) * 1_000_000n;
const goodTilTimeUs = (fixedNowNs / 1_000n + 60n * 24n * 60n * 60n * 1_000_000n).toString();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const address = "0xAabbccDDeeFf0011223344556677889900AaBbCc";

function config(submissionEnabled = false, overrides: Record<string, string | undefined> = {}) {
  return readArcusConfig({
    ARCUS_ENV: "testnet",
    ARCUS_ENABLE_TESTNET_SUBMISSION: submissionEnabled ? "true" : "false",
    ARCUS_ADDRESS: address,
    ARCUS_ACCOUNT_INDEX: "3",
    ...overrides,
  });
}

const sample: PlaceOrderInput = {
  marketId: 17,
  tickSize: "0.5",
  stepSize: "0.01",
  side: "SELL",
  orderType: "LIMIT",
  timeInForce: "GTT",
  quantity: "1.20",
  price: "123.5",
  goodTilTimeUs,
  clientId: "prototype_order_1",
};

const closeSample: CloseOrderInput = {
  marketId: 17,
  tickSize: "0.5",
  stepSize: "0.01",
  orderType: "LIMIT",
  timeInForce: "GTT",
  quantity: "1.20",
  price: "123.5",
  goodTilTimeUs,
};

function rawPublicKeyHex(key = publicKey): string {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
}

test("builds the official sorted integer order payload and signs those exact bytes offline", () => {
  const prepared = preparePlaceOrder(config(), sample, privateKey, fixedNowNs);
  const expected = `{"ad":"${address.toLowerCase()}","ai":3,"c":"prototype_order_1","ct":${fixedNowNs},"g":${BigInt(goodTilTimeUs) * 1_000n},"m":17,"op":1,"p":247,"q":120,"r":0,"s":1,"t":0,"v":1}`;
  assert.equal(prepared.signingMessage, expected);
  assert.equal(prepared.signingPayload.p, 247n);
  assert.equal(prepared.signingPayload.q, 120n);
  assert.equal(prepared.signingPayload.g, BigInt(goodTilTimeUs) * 1_000n);
  assert.equal(prepared.headers["X-Timestamp"], fixedNowNs.toString());
  assert.equal(prepared.headers["X-API-Key"], rawPublicKeyHex());
  assert.equal(prepared.signature.length, 128);
  assert.equal(verify(null, Buffer.from(expected), createPublicKey(privateKey), Buffer.from(prepared.signature, "hex")), true);
  assert.equal(prepared.url, `${ARCUS_TESTNET_BASE_URL}/v1/placeOrder`);
  assert.match(prepared.bodyText, new RegExp(`\\"timestamp\\":${fixedNowNs}`));
  assert.equal(prepared.body.clientTime, fixedNowNs.toString());
});

test("close of a long is an explicit SELL with reduceOnly=true", () => {
  const close = buildCloseOrder("LONG", closeSample);
  const prepared = preparePlaceOrder(config(), close, privateKey, fixedNowNs);
  assert.equal(close.side, "SELL");
  assert.equal(close.reduceOnly, true);
  assert.equal(prepared.signingPayload.s, 1);
  assert.equal(prepared.signingPayload.r, 1);
  assert.equal(prepared.body.reduceOnly, true);
});

test("close of a short is an explicit BUY with reduceOnly=true", () => {
  const close = buildCloseOrder("SHORT", closeSample);
  const prepared = preparePlaceOrder(config(), close, privateKey, fixedNowNs);
  assert.equal(close.side, "BUY");
  assert.equal(close.reduceOnly, true);
  assert.equal(prepared.signingPayload.s, 0);
  assert.equal(prepared.signingPayload.r, 1);
  assert.equal(prepared.body.reduceOnly, true);
});

test("dry-run prepares and signs locally without invoking the transport", async () => {
  let transportCalled = false;
  const result = await executePlaceOrder(config(false), sample, privateKey, fixedNowNs, async () => {
    transportCalled = true;
    throw new Error("network transport must not be called in dry-run");
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(transportCalled, false);
  assert.equal(result.prepared.url, `${ARCUS_TESTNET_BASE_URL}/v1/placeOrder`);
});

test("explicit testnet-submit mode uses only the fixed testnet host with a mock transport", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await executePlaceOrder(config(true), sample, privateKey, fixedNowNs, async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response('{"status":"ACK"}', { status: 202 });
  });
  assert.equal(result.mode, "testnet-submit");
  assert.equal(result.status, 202);
  assert.equal(capturedUrl, `${ARCUS_TESTNET_BASE_URL}/v1/placeOrder`);
  assert.equal(capturedInit?.method, "POST");
  assert.equal((capturedInit?.headers as Record<string, string>)["X-API-Key"], rawPublicKeyHex());
});

test("rejects production or alternate API hosts and requires explicit testnet selection", () => {
  assert.throws(() => readArcusConfig({}), /explicitly set to "testnet"/);
  assert.throws(() => readArcusConfig({ ARCUS_ENV: "mainnet" }), /explicitly set to "testnet"/);
  assert.throws(
    () => readArcusConfig({ ARCUS_ENV: "testnet", ARCUS_BASE_URL: "https://api.arcus.xyz" }),
    /permits only/,
  );
  assert.throws(() => readArcusConfig({ ARCUS_ENV: "testnet", ARCUS_BASE_URL: "http://localhost:9999" }), /permits only/);
  assert.throws(() => assertTestnetConfig({ ...config(), baseUrl: "https://api.arcus.xyz" as typeof ARCUS_TESTNET_BASE_URL }), /hard-gated/);
  assert.equal(config().submissionEnabled, false);
  assert.throws(() => readArcusConfig({ ARCUS_ENV: "testnet", ARCUS_ENABLE_TESTNET_SUBMISSION: "yes" }), /must be "true" or "false"/);
});

test("rejects mismatched public key and non-exact market tick/step values", () => {
  assert.throws(
    () => preparePlaceOrder({ ...config(), apiKey: "00".repeat(32) }, sample, privateKey, fixedNowNs),
    /does not match/,
  );
  assert.throws(() => preparePlaceOrder(config(), { ...sample, price: "123.6" }, privateKey, fixedNowNs), /exact multiple/);
  assert.throws(() => preparePlaceOrder(config(), { ...sample, quantity: "1.201" }, privateKey, fixedNowNs), /exact multiple/);
});

test("rejects unsafe short expiry and malformed account configuration", () => {
  const expiry30DaysUs = (fixedNowNs / 1_000n + 30n * 24n * 60n * 60n * 1_000_000n).toString();
  assert.throws(() => preparePlaceOrder(config(), { ...sample, goodTilTimeUs: expiry30DaysUs }, privateKey, fixedNowNs), /31 days ahead/);
  assert.throws(() => readArcusConfig({ ARCUS_ENV: "testnet", ARCUS_ACCOUNT_INDEX: "10" }), /0 through 9/);
  assert.throws(() => readArcusConfig({ ARCUS_ENV: "testnet", ARCUS_ADDRESS: "not-an-address" }), /20-byte/);
});

test("configuration schema declares only testnet and defaults to dry-run", () => {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), "config.schema.json"), "utf8")) as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { const?: string; default?: string | boolean; pattern?: string; minimum?: number; maximum?: number }>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("environment"));
  assert.ok(schema.required.includes("baseUrl"));
  assert.ok(schema.required.includes("submissionEnabled"));
  assert.equal(schema.properties.environment.const, "testnet");
  assert.equal(schema.properties.baseUrl.const, ARCUS_TESTNET_BASE_URL);
  assert.equal(schema.properties.submissionEnabled.default, false);
  assert.equal(schema.properties.accountIndex.minimum, 0);
  assert.equal(schema.properties.accountIndex.maximum, 9);
  assert.equal(schema.properties.address.pattern, "^0x[0-9a-fA-F]{40}$");
  assert.equal(schema.properties.apiKey.pattern, "^[0-9a-fA-F]{64}$");
});
