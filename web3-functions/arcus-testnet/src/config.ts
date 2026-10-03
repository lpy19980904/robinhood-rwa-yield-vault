export const ARCUS_TESTNET_BASE_URL = "https://api.testnet.arcus.xyz" as const;

export interface ArcusTestnetConfig {
  environment: "testnet";
  baseUrl: typeof ARCUS_TESTNET_BASE_URL;
  submissionEnabled: boolean;
  address?: string;
  accountIndex: number;
  apiKey?: string;
}

export type Environment = Record<string, string | undefined>;

/**
 * Parse only explicit testnet configuration. The host is an invariant, not a
 * user-selectable endpoint. Dry-run is the default and does not perform I/O.
 */
export function readArcusConfig(env: Environment): ArcusTestnetConfig {
  if (env.ARCUS_ENV !== "testnet") {
    throw new Error('ARCUS_ENV must be explicitly set to "testnet"');
  }

  const requestedBaseUrl = env.ARCUS_BASE_URL;
  if (requestedBaseUrl !== undefined && requestedBaseUrl !== ARCUS_TESTNET_BASE_URL) {
    throw new Error(`Arcus prototype permits only ${ARCUS_TESTNET_BASE_URL}`);
  }

  const submitSetting = env.ARCUS_ENABLE_TESTNET_SUBMISSION;
  if (submitSetting !== undefined && submitSetting !== "true" && submitSetting !== "false") {
    throw new Error('ARCUS_ENABLE_TESTNET_SUBMISSION must be "true" or "false"');
  }

  const accountIndex = env.ARCUS_ACCOUNT_INDEX === undefined || env.ARCUS_ACCOUNT_INDEX === ""
    ? 0
    : Number(env.ARCUS_ACCOUNT_INDEX);
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > 9) {
    throw new Error("ARCUS_ACCOUNT_INDEX must be an integer from 0 through 9");
  }

  const address = env.ARCUS_ADDRESS?.trim() || undefined;
  if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("ARCUS_ADDRESS must be a 20-byte 0x-prefixed EVM address");
  }

  const apiKey = env.ARCUS_API_KEY?.trim() || undefined;
  if (apiKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(apiKey)) {
    throw new Error("ARCUS_API_KEY must be a 32-byte hex Ed25519 public key without 0x");
  }

  return {
    environment: "testnet",
    baseUrl: ARCUS_TESTNET_BASE_URL,
    submissionEnabled: submitSetting === "true",
    address,
    accountIndex,
    apiKey,
  };
}

export function assertTestnetConfig(config: ArcusTestnetConfig): void {
  if (config.environment !== "testnet" || config.baseUrl !== ARCUS_TESTNET_BASE_URL) {
    throw new Error("Refusing Arcus request: this prototype is hard-gated to the Arcus testnet host");
  }
  if (!Number.isSafeInteger(config.accountIndex) || config.accountIndex < 0 || config.accountIndex > 9) {
    throw new Error("Arcus accountIndex must be an integer from 0 through 9");
  }
  if (config.address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(config.address)) {
    throw new Error("Arcus master address is invalid");
  }
  if (config.apiKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(config.apiKey)) {
    throw new Error("Arcus API public key is invalid");
  }
}
