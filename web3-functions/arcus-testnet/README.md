# Arcus testnet prototype

This is a separate, offline-first Arcus REST order-routing prototype. It is **TESTNET / NON-PRODUCTION only** and does not connect Arcus positions to the Solidity vault or its `totalAssets()`.

- The environment must explicitly be `testnet`; the only accepted API host is `https://api.testnet.arcus.xyz`.
- Execution defaults to dry-run. HTTP submission is gated by `ARCUS_ENABLE_TESTNET_SUBMISSION=true` and has an injectable transport for offline tests.
- `preparePlaceOrder` derives the Ed25519 API public key from a Node.js Ed25519 private `KeyObject`, signs Arcus's documented sorted typed payload, and constructs the REST request. The Arcus API Signing Key's exported serialization is not specified in the API pages reviewed, so this module deliberately does not parse `ARCUS_API_SIGNING_KEY` or load credentials. An approved key loader must supply the `KeyObject` before any testnet use.
- No order is sent by the tests. The submit test uses a fake transport.

Use `npm install`, `npm run typecheck`, and `npm test` in this directory. See the repository root README for the trust boundary, official Arcus references, and unresolved production prerequisites.
