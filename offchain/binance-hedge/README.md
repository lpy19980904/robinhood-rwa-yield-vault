# Binance equity-perpetual hedge planner (off-chain, dry-run only)

This standalone TypeScript module produces deterministic **plans only** for pairing Robinhood Chain spot holdings with the confirmed Binance equity-perpetual symbols `AAPLUSDT`, `NVDAUSDT`, `AMZNUSDT`, `AVGOUSDT`, and `QQQUSDT`. It is intentionally outside `web3-functions/rebalance` and outside vault keeper execution. It does not implement an order endpoint, exchange HTTP client, WebSocket, API signing, credentials, or any path to place, amend, or cancel an order. A returned order-shaped object is a local dry-run plan, not a submitted order or an instruction that `RwaYieldVault.rebalance()` executes.

## Inputs and calculation

The caller supplies a Robinhood Chain spot quantity and a separately sourced USDT spot valuation, the observed current Binance short quantity, and a market snapshot that has passed `validateMarketSnapshot()`. The snapshot validates the supported symbol, equity-perpetual market type, USDT quote, observation freshness, mark price, funding rate and interval, tick/step/min/max quantity, and contract size. Decimal values must be strings with at most 12 fractional digits; binary floating-point inputs are rejected.

For each asset, the planner computes:

```text
spot value = spot quantity × supplied spot price
requested short notional = spot value × hedge ratio (basis points) / 10,000
target short quantity = floor-to-step(requested notional / (perp mark price × contract size))
```

The target quantity is rounded down to avoid exceeding the requested hedge. A delta smaller than the market minimum is marked `BLOCKED` rather than turned into an invalid order. Larger deltas are partitioned deterministically into chunks within `maxQty`. Market metadata must be obtained and reviewed by the caller for the intended contract; fixture metadata is synthetic and not asserted to match current exchange filters.

| Position mode | Increase short | Reduce short |
| --- | --- | --- |
| One-way | `SELL`, `positionSide: BOTH`, `reduceOnly: false` | `BUY`, `positionSide: BOTH`, `reduceOnly: true` |
| Hedge | `SELL`, `positionSide: SHORT`, no `reduceOnly` field | `BUY`, `positionSide: SHORT`, no `reduceOnly` field |

In hedge mode the planner omits `reduceOnly`, because Binance's [USDⓈ-M Futures New Order documentation](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade) says that `positionSide` must be sent in Hedge Mode and `reduceOnly` cannot be sent there. Each plan carries the supplied spot price, validated mark price, funding value and interval, observation timestamp, and validated contract filters for review. Funding is not annualized or used to decide whether to hedge. Each `planId` is a stable local identifier, not an exchange client-order ID.

## Offline-first boundary

`OFFLINE_MARKET_FIXTURES` contains synthetic, deterministic examples only. Tests use those fixtures and injected in-memory providers; they do not contact Binance, Robinhood Chain, an RPC, or another network. There is no built-in fetcher. A caller may inject a provider implementing only `readMarketData(symbol)` if it separately builds an approved read-only source; this module has no order-capable transport API.

Binance collateral, balances, positions, and account identity are external to the Robinhood vault and are not controlled by it. The existing ERC-4626 `totalAssets()` remains based on vault-held USDC and adapter-reported NAV; do **not** add Binance account balances or PnL to share pricing without a separate, trusted NAV, identity, freshness, and oracle/reporting design. No module here establishes that identity or NAV link.

## Run checks

From this directory:

```sh
npm install
npm run typecheck
npm test
```

All tests are offline. This package has no start, deploy, transaction, or order-submission script.
