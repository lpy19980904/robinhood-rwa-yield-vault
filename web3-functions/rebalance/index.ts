import { Interface } from "@ethersproject/abi";
import { Web3Function, Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk";
import { allocationDriftBps, computePortfolioApyBps, dynamicSlippageBps } from "./policy";

const BPS = 10_000n;
const GWEI = 1_000_000_000n;
const MAX_RUNTIME_MS = 22_000;

const vaultAbi = new Interface([
  "function totalAssets() view returns (uint256)",
  "function yieldStrategy() view returns (address)",
  "function perpProxy() view returns (address)",
  "function rebalance((uint16 yieldBps,uint16 perpBps,uint16 maxSlippageBps,uint64 deadline) params)",
]);
const adapterAbi = new Interface(["function totalAssets() view returns (uint256)"]);
const metricsAbi = new Interface([
  "function stakedAssetApyBps() view returns (uint256)",
  "function perpFundingRateBpsPerDay() view returns (int256)",
  "function volatilityBps() view returns (uint256)",
]);

interface Args {
  vaultAddress: string;
  metricsAddress: string;
  keeperAddress: string;
  chainId: number;
  yieldBps: number;
  perpBps: number;
  minPortfolioApyBps: number;
  baseSlippageBps: number;
  maxSlippageBps: number;
  volatilityFactorBps: number;
  minimumAllocationDriftBps: number;
  maxGasPriceGwei: number;
  gasLimitBufferBps: number;
  maxGasLimit: number;
  deadlineSeconds: number;
  rpcTimeoutMs: number;
  maxFundingAbsBpsPerDay: number;
  maxStakedApyBps: number;
  rpcUrls?: string[];
}

interface RpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

let requestId = 1;

function asArgs(value: Record<string, unknown>): Args {
  return value as unknown as Args;
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function boundedInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function parseUint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid ${label} RPC result`);
  }
  return BigInt(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function httpRpc(url: string, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as RpcResponse;
    if (body.error) throw new Error(`RPC ${body.error.code ?? "error"}`);
    if (body.result === undefined) throw new Error("RPC response has no result");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const runStartedAt = Date.now();
  try {
    const args = asArgs(context.userArgs as Record<string, unknown>);
    if (!isAddress(args.vaultAddress) || !isAddress(args.metricsAddress) || !isAddress(args.keeperAddress)) {
      throw new Error("vaultAddress, metricsAddress and keeperAddress must be valid EVM addresses");
    }

    const configuredChainId = boundedInt("chainId", args.chainId, 1, 2_147_483_647);
    const yieldBps = boundedInt("yieldBps", args.yieldBps, 0, 10_000);
    const perpBps = boundedInt("perpBps", args.perpBps, 0, 10_000);
    if (yieldBps + perpBps > 10_000) throw new Error("yieldBps + perpBps must not exceed 10000");

    const baseSlip = boundedInt("baseSlippageBps", args.baseSlippageBps, 0, 2_000);
    const maxSlip = boundedInt("maxSlippageBps", args.maxSlippageBps, 0, 2_000);
    if (baseSlip > maxSlip) throw new Error("baseSlippageBps must not exceed maxSlippageBps");
    const volatilityFactor = boundedInt("volatilityFactorBps", args.volatilityFactorBps, 0, 100_000);
    const driftThreshold = boundedInt("minimumAllocationDriftBps", args.minimumAllocationDriftBps, 0, 10_000);
    const maxGasPriceGwei = boundedInt("maxGasPriceGwei", args.maxGasPriceGwei, 1, 10_000);
    const gasBufferBps = boundedInt("gasLimitBufferBps", args.gasLimitBufferBps, 10_000, 30_000);
    const maxGasLimit = boundedInt("maxGasLimit", args.maxGasLimit, 21_000, 10_000_000);
    const deadlineSeconds = boundedInt("deadlineSeconds", args.deadlineSeconds, 1, 3_600);
    const rpcTimeoutMs = boundedInt("rpcTimeoutMs", args.rpcTimeoutMs, 500, 8_000);
    const maxFundingAbs = BigInt(boundedInt("maxFundingAbsBpsPerDay", args.maxFundingAbsBpsPerDay, 1, 100_000));
    const maxStakedApy = BigInt(boundedInt("maxStakedApyBps", args.maxStakedApyBps, 0, 1_000_000));
    if (!Number.isSafeInteger(args.minPortfolioApyBps)) {
      throw new Error("minPortfolioApyBps must be a safe integer");
    }

    if (context.gelatoArgs.chainId !== configuredChainId) {
      return { canExec: false, message: `Configured chain ${configuredChainId} does not match Gelato chain ${context.gelatoArgs.chainId}` };
    }

    const secretRpcUrls = (await context.secrets.get("RPC_URLS"))
      ?.split(/[\s,;]+/)
      .map((url) => url.trim())
      .filter(Boolean) ?? [];
    const publicRpcUrls = Array.isArray(args.rpcUrls) ? args.rpcUrls : [];
    const rpcUrls = [...new Set([...secretRpcUrls, ...publicRpcUrls])].filter((url) => /^https?:\/\//i.test(url));
    const managedProvider = context.multiChainProvider.chainId(configuredChainId);
    const runtimeDeadline = runStartedAt + MAX_RUNTIME_MS;

    const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
      const errors: string[] = [];
      for (let i = 0; i < rpcUrls.length; i += 1) {
        const remaining = runtimeDeadline - Date.now();
        if (remaining <= 100) break;
        try {
          return await httpRpc(rpcUrls[i], method, params, Math.min(rpcTimeoutMs, remaining));
        } catch (error) {
          errors.push(`configured RPC ${i + 1}: ${error instanceof Error ? error.message : "failed"}`);
        }
      }
      const remaining = runtimeDeadline - Date.now();
      if (remaining > 100) {
        try {
          return await withTimeout(
            managedProvider.send(method, params),
            Math.min(rpcTimeoutMs, remaining),
            "Gelato managed RPC",
          );
        } catch (error) {
          errors.push(`Gelato managed RPC: ${error instanceof Error ? error.message : "failed"}`);
        }
      }
      throw new Error(`${method} unavailable on configured and Gelato RPC fallbacks (${errors.join("; ") || "runtime timeout"})`);
    };

    const rpcChainId = parseUint(await rpc("eth_chainId"), "chain ID");
    if (rpcChainId !== BigInt(configuredChainId)) {
      return { canExec: false, message: `RPC chain ID ${rpcChainId} does not match configured chain ${configuredChainId}` };
    }

    const call = async (to: string, iface: Interface, functionName: string, values: unknown[] = []): Promise<unknown[]> => {
      const data = iface.encodeFunctionData(functionName, values);
      const raw = await rpc("eth_call", [{ to, data }, "latest"]);
      if (typeof raw !== "string") throw new Error(`Invalid eth_call result for ${functionName}`);
      return Array.from(iface.decodeFunctionResult(functionName, raw));
    };

    const [latestBlockRaw, gasPriceRaw] = await Promise.all([
      rpc("eth_getBlockByNumber", ["latest", false]),
      rpc("eth_gasPrice"),
    ]);
    const latestBlock = latestBlockRaw as { timestamp?: string };
    const blockTimestamp = parseUint(latestBlock?.timestamp, "block timestamp");
    const rpcGasPrice = parseUint(gasPriceRaw, "gas price");
    const gelatoGasPrice = BigInt(context.gelatoArgs.gasPrice.toString());
    const effectiveGasPrice = rpcGasPrice > gelatoGasPrice ? rpcGasPrice : gelatoGasPrice;
    const maxGasPrice = BigInt(maxGasPriceGwei) * GWEI;
    if (effectiveGasPrice > maxGasPrice) {
      return { canExec: false, message: `Gas price ${effectiveGasPrice / GWEI} gwei exceeds configured cap ${maxGasPriceGwei} gwei` };
    }

    const [navValue, yieldAddressValue, perpAddressValue] = await call(args.vaultAddress, vaultAbi, "totalAssets").then(async (navResult) => {
      const [yieldResult, perpResult] = await Promise.all([
        call(args.vaultAddress, vaultAbi, "yieldStrategy"),
        call(args.vaultAddress, vaultAbi, "perpProxy"),
      ]);
      return [navResult[0], yieldResult[0], perpResult[0]];
    });
    const nav = BigInt((navValue as { toString(): string }).toString());
    const yieldAddress = String(yieldAddressValue);
    const perpAddress = String(perpAddressValue);
    if (!isAddress(yieldAddress) || !isAddress(perpAddress) || /^0x0{40}$/i.test(yieldAddress) || /^0x0{40}$/i.test(perpAddress)) {
      return { canExec: false, message: "Vault strategy adapters are not configured" };
    }

    const [yieldAssetsRaw, perpAssetsRaw, apyResult, fundingResult, volatilityResult] = await Promise.all([
      call(yieldAddress, adapterAbi, "totalAssets"),
      call(perpAddress, adapterAbi, "totalAssets"),
      call(args.metricsAddress, metricsAbi, "stakedAssetApyBps"),
      call(args.metricsAddress, metricsAbi, "perpFundingRateBpsPerDay"),
      call(args.metricsAddress, metricsAbi, "volatilityBps"),
    ]);
    const yieldAssets = BigInt((yieldAssetsRaw[0] as { toString(): string }).toString());
    const perpAssets = BigInt((perpAssetsRaw[0] as { toString(): string }).toString());
    const stakedApyBps = BigInt((apyResult[0] as { toString(): string }).toString());
    const fundingBpsPerDay = BigInt((fundingResult[0] as { toString(): string }).toString());
    const volatilityBps = BigInt((volatilityResult[0] as { toString(): string }).toString());

    if (stakedApyBps > maxStakedApy) return { canExec: false, message: "Staked-asset APY exceeds the configured sanity bound" };
    if (fundingBpsPerDay > maxFundingAbs || fundingBpsPerDay < -maxFundingAbs) {
      return { canExec: false, message: "Perp funding exceeds the configured sanity bound" };
    }

    const portfolioApyBps = computePortfolioApyBps(stakedApyBps, fundingBpsPerDay, yieldBps, perpBps);
    if (portfolioApyBps < BigInt(Math.trunc(args.minPortfolioApyBps))) {
      return { canExec: false, message: `Estimated weighted APY ${portfolioApyBps} bps is below the configured threshold` };
    }
    const drift = allocationDriftBps(nav, yieldAssets, perpAssets, yieldBps, perpBps);
    if (nav === 0n) return { canExec: false, message: "Vault has no assets to rebalance" };
    if (drift < BigInt(driftThreshold)) {
      return { canExec: false, message: `Allocation drift ${drift} bps is below the execution threshold ${driftThreshold} bps` };
    }

    const slippageBps = dynamicSlippageBps(baseSlip, volatilityBps, volatilityFactor, maxSlip);
    const deadline = blockTimestamp + BigInt(deadlineSeconds);
    const encoded = vaultAbi.encodeFunctionData("rebalance", [[yieldBps, perpBps, slippageBps, deadline.toString()]]);
    const estimateRaw = await rpc("eth_estimateGas", [
      { from: args.keeperAddress, to: args.vaultAddress, data: encoded },
      "latest",
    ]);
    const estimate = parseUint(estimateRaw, "gas estimate");
    const bufferedEstimate = (estimate * BigInt(gasBufferBps) + BPS - 1n) / BPS;
    if (bufferedEstimate > BigInt(maxGasLimit)) {
      return { canExec: false, message: `Buffered gas estimate ${bufferedEstimate} exceeds configured cap ${maxGasLimit}` };
    }

    return {
      canExec: true,
      callData: [{ to: args.vaultAddress, data: encoded }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected Web3 Function error";
    console.error("rebalance evaluation failed:", message);
    return { canExec: false, message: message.slice(0, 240) };
  }
});
