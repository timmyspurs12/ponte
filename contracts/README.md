# PONTE Route-Decision Evidence Registry contracts

This directory is a self-contained Foundry project for the local Solidity implementation and unit tests of `PonteRouteDecisionEvidenceRegistry`.

It contains an offline, configuration-guarded deployment script but no RPC configuration, private keys, credentials, hardcoded deployment addresses, wallet operations, broadcast record, public deployment, or application integration code.

## Pinned tooling

| Tool                   | Exact pinned version | Purpose                                                       |
| ---------------------- | -------------------: | ------------------------------------------------------------- |
| Foundry Forge          |              `1.7.1` | Build, formatter, and local unit-test runner                  |
| Solidity compiler      |             `0.8.28` | Solidity compiler provided by the `solc` npm package          |
| Solidity source pragma |             `0.8.28` | Prevents compiling this project with another compiler version |

The exact package artifacts and transitive package versions are locked in `package-lock.json`. The Foundry package is published by the `@foundry-rs` npm scope. `tools/forge.mjs` selects the corresponding locked platform package and forwards Forge's exit status, avoiding a floating global Foundry installation. The compiler implementation is the locked `solc` package's Solidity `0.8.28` Emscripten build.

`foundry.toml` sets an explicit local compiler path and `offline = true`, preventing Foundry from downloading or auto-selecting a different compiler. Foundry's official configuration reference permits `solc` to be a local compiler path. The repository-local `tools/solcjs-foundry-wrapper.mjs` delegates to the locked Standard JSON compiler while removing only Foundry's native-`solc` `--allow-paths` CLI option, which `solcjs` does not support. It also strips solcjs's non-JSON SMT-availability prelude so Foundry receives the Standard JSON object it expects. It does not alter Standard JSON compiler input, JSON output, optimizer settings, or the compiler exit status.

The official Solidity compiler documentation distinguishes native `solc` command-line options from `solcjs`; this wrapper exists solely for that documented CLI difference while retaining the standard JSON compiler interface used by Foundry.

No Solidity test-library dependency is used. The test suite declares the small Foundry cheatcode interface it needs directly, avoiding a floating `forge-std` dependency.

## Reproducible local commands

From this directory:

```bash
npm ci --ignore-scripts
npm run fmt:check
npm run build
npm test
npm run build:identity
npm run test:deployment
```

`npm run build:identity` reports the local compiler/build/ABI/runtime identity without a network request. `npm run test:deployment` validates the deployment-script guards, strict manifest tooling, and controlled read-only RPC verification responses; it does not contact an RPC endpoint. See [`../docs/PHASE1_3_1_ARBITRUM_REGISTRY_DEPLOYMENT_READINESS.md`](../docs/PHASE1_3_1_ARBITRUM_REGISTRY_DEPLOYMENT_READINESS.md) for the later operator procedure and approval gates.

To apply Foundry formatting locally:

```bash
npm run fmt
```

The successful deployment tests set the simulated EVM chain ID to `421614` with Foundry's `vm.chainId` cheatcode before construction. The negative network test sets another local test-chain ID and confirms that construction reverts. This does not change or bypass the constructor's immutable Arbitrum Sepolia restriction.

## Contract boundary

The registry is an append-only attestation registry for **simulated route-decision commitments**. It is non-payable, has no token or asset handling, makes no external contract calls, has no upgradeability mechanism, and stores no invoice, supplier, customer, wallet, payment-reference, salt, or quote-preimage data.

See `../docs/PHASE0_1_ROUTE_DECISION_EVIDENCE_REGISTRY.md` for the frozen product, commitment, privacy, and operational specification.
