import type { KeyObject } from "node:crypto";
import { assertTestnetConfig, type ArcusTestnetConfig } from "./config";
import { preparePlaceOrder, type PlaceOrderInput, type PreparedArcusOrder } from "./order";

export type ArcusExecutionResult =
  | { mode: "dry-run"; prepared: PreparedArcusOrder }
  | { mode: "testnet-submit"; status: number; responseText: string; prepared: PreparedArcusOrder };

/**
 * Dry-run by default. Network I/O is reachable only after explicit testnet
 * opt-in and the URL is always reconstructed from the hard-coded testnet host.
 */
export async function executePlaceOrder(
  config: ArcusTestnetConfig,
  input: PlaceOrderInput,
  privateKey: KeyObject,
  nowNs?: bigint,
  transport: typeof fetch = fetch,
): Promise<ArcusExecutionResult> {
  assertTestnetConfig(config);
  const prepared = preparePlaceOrder(config, input, privateKey, nowNs);
  if (!config.submissionEnabled) return { mode: "dry-run", prepared };
  if (!config.address) throw new Error("ARCUS_ADDRESS is required before testnet submission");

  const response = await transport(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.bodyText,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Arcus testnet request failed (${response.status}): ${responseText.slice(0, 400)}`);
  }
  return { mode: "testnet-submit", status: response.status, responseText, prepared };
}
