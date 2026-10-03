# eVault-USDC RWA strategy vault

Foundry project for an ERC-4626 USDC vault whose share token is **eVault-USDC**. A designated keeper/relay is the only caller allowed to rebalance a configurable RWA swap/stake adapter and a 1x short perp proxy. The `web3-functions/rebalance` directory contains a Gelato Web3 Function that evaluates staked-asset APY plus perp funding, then produces encoded vault calldata when its execution gates pass.

The code is an integration-ready scaffold, **not a production deployment**. No Robinhood Chain USDC contract, RWA token, venue/router, staking pool, perp venue, oracle, or Gelato caller address was supplied, so no venue adapter or address is invented here. External adapters and metric feeds must be implemented and reviewed before assets are deposited.

**Arcus status:** the separate `web3-functions/arcus-testnet` module is a **TESTNET / NON-PRODUCTION prototype only**. It defaults to offline dry-run, accepts only `https://api.testnet.arcus.xyz`, and cannot route orders to Arcus mainnet. It is not connected to the Solidity vault and does not use Lighter.

## Project layout

```text
src/RwaYieldVault.sol                     ERC-4626 vault and keeper-gated rebalance
src/interfaces/IStrategyAdapter.sol       USDC-NAV strategy adapter boundary
src/interfaces/IPerpShortProxy.sol        1x short perp proxy requirements
script/DeployRwaVault.s.sol                Parameterized Foundry deployment
 test/RwaYieldVault.t.sol                  Vault behavior, access and risk tests
 test/mocks/                              Test-only USDC and strategy mocks
web3-functions/rebalance/index.ts          Gelato APY/funding evaluator and calldata builder
web3-functions/rebalance/schema.json       Gelato function configuration schema
web3-functions/arcus-testnet/               Separate Arcus TESTNET-only order prototype
config-robinhood.md                        Mainnet/testnet network parameters
```

The vault reports idle USDC plus both adapters' net USDC NAV as `totalAssets()`. Deposits mint ERC-4626 shares; withdrawals source liquidity from the yield adapter first and the perp proxy second. Rebalancing unwinds overweight legs, recomputes NAV, retains the target idle allocation, then invests the remaining balance. The owner configures adapters, keeper and hard risk bounds; **the owner has no keeper bypass**. Deposits and rebalances pause, while withdrawals remain enabled.

## Adapter contract required before live funds

Both adapters must implement `IStrategyAdapter` and use the vault's USDC as `asset()`:

- `totalAssets()` must be current **net USDC NAV**, including yield, fees, realized and unrealized PnL. A stale or optimistic NAV corrupts ERC-4626 share pricing.
- `maxWithdraw()` reports the maximum USDC output the adapter can currently guarantee. The vault uses this to report ERC-4626 `maxWithdraw` / `maxRedeem` limits; deposits and mints also report zero maximum while paused.
- `previewDeposit(assets)` returns the adapter-specific position units expected for the USDC input. `previewWithdraw(assetsOutRequested)` quotes proceeds for a requested USDC output amount, and `withdraw` must gross up the position as needed to deliver that amount subject to `minAssetsOut`, `maxSlippageBps` and `deadline`. Previews must be conservative.
- `deposit` pulls exactly the approved USDC amount; `withdraw` transfers the actual USDC proceeds to the vault and returns the exact transferred amount. The vault checks both the balance delta and the reported return.
- The RWA yield adapter is where the placeholder RWA-token swap and staking actions belong. It must constrain token, router, pool, oracle, approvals, and unwind paths to explicitly reviewed addresses.
- The perp proxy must create/reduce a **1x short** as collateral is deposited/withdrawn. `totalAssets()` is net USDC equity; `shortNotionalUsdc()` is gross short exposure; `leverageBps()` reports notional/equity × 10,000. The vault checks nonzero perp equity is exactly 10,000 bps at configuration and after each rebalance. The proxy must independently enforce margin, liquidation, oracle, funding, order-price, and emergency-close controls.

Adapter `preview*` values and on-chain venue checks are a trust boundary. The vault's BPS and deadline checks do not substitute for venue-specific validation or independent adapter audits.

## Arcus testnet prototype and the vault boundary

Arcus is wired only as an off-chain REST order-routing prototype. The module builds the documented `POST /v1/placeOrder` typed signing payload, derives the Ed25519 public API key from an injected Node.js `KeyObject`, and signs locally. The official [authentication guide](https://docs.arcus.xyz/api-reference/authentication) specifies sorted compact order payloads, nanosecond `X-Timestamp`/`ct`, integer price ticks and quantity quantums; the [market API](https://docs.arcus.xyz/api-reference/public/get-markets) supplies `tickSize` and `stepSize`. The [testnet trading guide](https://docs.arcus.xyz/guides/websocket-trading) identifies `https://api.testnet.arcus.xyz` as the testnet endpoint. This prototype is REST-only; tests use generated throwaway keys and a mock transport and do not contact Arcus.

The API account and the ERC-4626 vault are **separate identities and trust domains**. An Arcus API signature is not a vault-contract signature, and this project does not claim that a vault contract can control an Arcus account. The [Arcus architecture overview](https://docs.arcus.xyz/concepts/exchange-architecture) describes an off-chain matching core with rootchain custody/settlement; API-reported account equity therefore must **not** be added to vault `totalAssets()` today. Before any Arcus exposure could be counted in share pricing, the project needs a designed and reviewed identity link, funding/withdrawal path, source-freshness policy, and independently verifiable signed position/NAV reports.

The close-order helper maps a long close to `SELL` and a short close to `BUY`, always with `reduceOnly=true`. This prevents the prototype from silently choosing a reverse direction, but it is not a substitute for checking the live position, order status, margin, or execution result. No order is sent unless testnet submission is explicitly enabled, and no production host can be configured.

The module deliberately leaves private-key deserialization out: the official pages reviewed identify an Ed25519 API key and its signing behavior but do not specify the API Signing Key's export serialization. A future secure loader must provide the matching Ed25519 `KeyObject`; `.env.example` keeps API credentials blank. No credential was requested or used for this work.

## Build and tests

Requirements: Foundry, Git, Node.js 18+ and npm.

```sh
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2
forge install foundry-rs/forge-std@v1.9.7
forge build
forge test -vvv
cd web3-functions/rebalance && npm install && npm run typecheck && npm test
cd ../arcus-testnet && npm install && npm run typecheck && npm test && npm run build
```

The tests use a six-decimal mock USDC and deterministic in-memory adapters. They do not fork Robinhood Chain or verify live venue integrations.

## Robinhood Chain deployment

Official Robinhood Chain docs list mainnet chain ID **4663** (`https://rpc.mainnet.chain.robinhood.com`) and testnet chain ID **46630** (`https://rpc.testnet.chain.robinhood.com`). The official deploy guide recommends testing on testnet first. Public RPC endpoints are rate-limited; use an authenticated production provider where appropriate. See the [official deploy guide](https://docs.robinhood.com/chain/deploy-smart-contracts/) and [network connection details](https://docs.robinhood.com/chain/connecting/).

Copy `.env.example` to a local `.env` (ignored by Git), set the network RPC and the **verified network-specific** `USDC_ADDRESS` and `KEEPER_ADDRESS`, then run from this project directory:

```sh
set -a && source .env && set +a
export RH_RPC_URL="$RH_TESTNET_RPC_URL"
forge script script/DeployRwaVault.s.sol:DeployRwaVault \
  --rpc-url "$RH_RPC_URL" --chain-id 46630 --broadcast
```

For mainnet, set `RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com` and `--chain-id 4663`. Verify the address printed by the script and the chain ID before broadcasting. A real private key must never be committed; use a dedicated deployer and independently check the USDC and keeper addresses. The example addresses in `.env.example` are zero placeholders and cannot be deployed with as-is.

After deploying and verifying audited adapters, configure them from the owner account using the ABI:

```sh
cast send "$VAULT_ADDRESS" \
  'setStrategies(address,address)' "$YIELD_ADAPTER_ADDRESS" "$PERP_PROXY_ADDRESS" \
  --rpc-url "$RH_RPC_URL" --private-key "$PRIVATE_KEY"
```

The vault cannot replace adapters while they have nonzero NAV; unwind them to zero first. Verify the adapters' USDC asset and one-times leverage before configuration. `setKeeper(address)` can rotate the keeper. The configured keeper must be the actual transaction sender used by the Gelato execution route; do not assume an EOA or relay address without checking the configured Gelato task/wallet path.

The Robinhood deploy guide documents Blockscout verification. For example, to verify the vault on testnet after deployment:

```sh
forge verify-contract "$VAULT_ADDRESS" src/RwaYieldVault.sol:RwaYieldVault \
  --chain-id 46630 --rpc-url "$RH_RPC_URL" --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/ \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$USDC_ADDRESS" "$KEEPER_ADDRESS")"
```

For mainnet use `--chain-id 4663` and `--verifier-url https://robinhoodchain.blockscout.com/api/`. Confirm the current Blockscout API behavior in the official deployment guide if verification flags change.

## Gelato Web3 Function

The function reads `stakedAssetApyBps()`, `perpFundingRateBpsPerDay()` (positive means shorts receive funding; negative means shorts pay), and `volatilityBps()` from a configured metrics contract. It annualizes daily funding by 365, weights staking APY and funding by target yield/perp allocations, checks an APY threshold and allocation-drift threshold, and derives slippage as `baseSlippageBps + volatilityBps × volatilityFactorBps / 10,000`, capped at `maxSlippageBps`.

RPC endpoints are tried in configured order, then the Gelato managed provider is used. Set the `RPC_URLS` Gelato secret to a comma/space/semicolon-separated endpoint list; `rpcUrls` is available for non-secret public endpoints. Each RPC call has a timeout, the whole evaluation has a runtime budget, and failures return `canExec: false`. The function rejects chain-ID mismatches, implausible APY/funding, gas prices over the configured cap, and gas estimates over a buffered limit before returning `callData`.

The Gelato SDK result type supports `canExec` and `callData` entries (`to`, `data`, optional `value`), but not a per-call `gasLimit`. Therefore `maxGasPriceGwei` and `maxGasLimit` are **execution admission gates**; configure actual Gelato task gas/fee behavior in its supported task settings. No executable transaction is sent by this project.

Install and validate the function:

```sh
cd web3-functions/rebalance
cp .env.example .env
cp userArgs.example.json userArgs.json
# Replace zero placeholders with deployed testnet vault, metrics, and actual Gelato caller addresses.
npm install
npm run typecheck
npm test
# With valid testnet contracts/args and PROVIDER_URLS set in .env:
npm run simulate:testnet
```

`userArgs.example.json` is only a local CLI fixture and contains zero-address placeholders; it is not deployable or expected to return executable calldata. `schema.json` requires all parameters; use the actual vault, metrics, and keeper addresses and set `chainId` to 46630 for testnet or 4663 for mainnet. Configure `yieldBps + perpBps <= 10,000`, align the function's slippage cap with the vault's owner-configured cap, and ensure the metrics contract's APY/funding conventions match the function. Gelato's simulated `from`/keeper execution address must match the vault's `keeper()`.

The metrics ABI is intentionally a small interface, not an oracle implementation. The metrics contract and each adapter need freshness checks, source validation, outage behavior, and monitoring appropriate to the selected venues.

## Arcus prototype: completed and unresolved

Implemented and testable offline: explicit testnet-only configuration, dry-run-by-default behavior, an Arcus `placeOrder` request/signing boundary, exact decimal-to-tick/quantum checks, and close-direction/`reduceOnly` tests. The existing Solidity `IPerpShortProxy` and strategy adapter interfaces remain unchanged as integration boundaries; no official Solidity order API or Arcus contract ABI was identified in the official API documentation reviewed.

Still unresolved before real positions or production use: explicit confirmation of smart-contract-wallet/API-key registration support (the docs describe wallet EIP-712 registration but do not state EIP-1271/Safe support); verified Arcus mainnet contract addresses and ABI; a fresh, oracle-based NAV design and signed reports; the Arcus identity, funding and withdrawal model for vault-owned exposure; and an audited official mainnet integration. None of these are implemented or implied by this prototype. Until they are resolved, keep Arcus positions outside vault `totalAssets()` and do not use real positions.
