# Phase 1.3.1 — Reproducible Arbitrum Sepolia Registry Deployment Readiness

> **Tooling only; no deployment approval.** This phase adds reproducible local deployment, manifest, and read-only verification tooling for the existing Solidity registry. It does not create a wallet or key, read a credential, call a public RPC, fund an address, deploy a contract, activate an attestor, or change normal Routing.

## 1. Scope and current status

The target remains the existing append-only simulated route-decision registry:

- source: `contracts/src/PonteRouteDecisionEvidenceRegistry.sol`;
- contract name/version for manifest purposes: `PonteRouteDecisionEvidenceRegistry` / `1.0.0`;
- target chain ID: **Arbitrum Sepolia `421614`**;
- ABI version: `1`;
- frozen product/commitment specification: `docs/PHASE0_1_ROUTE_DECISION_EVIDENCE_REGISTRY.md`.

There is intentionally **no deployment manifest in the repository**. A deployment manifest is evidence of one specific public deployment and may be created only after an authorized transaction has a real address, transaction hash, receipt, and block number. `contracts/ponte-registry-deployment-manifest.schema.json` is a schema, not a deployment record. The Node tests use only in-memory, clearly non-public fixtures.

This phase does not modify the registry ABI, Solidity behavior, commitment format, golden vectors, evidence persistence schema, application service, or Routing activation.

## 2. Pinned reproducible build

`contracts/foundry.toml` and the locked `contracts/package-lock.json` establish the build:

| Input                          |                         Required value |
| ------------------------------ | -------------------------------------: |
| Foundry Forge package          |                                `1.7.1` |
| Solidity package/source pragma |                               `0.8.28` |
| Compiler metadata version      |               `0.8.28+commit.7893614a` |
| Optimizer                      |                  enabled, `runs = 200` |
| EVM version                    |                               `prague` |
| `viaIR`                        |                                `false` |
| Compiler resolution            | local `solc` wrapper; `offline = true` |

Run, from `contracts/`:

```sh
npm ci --ignore-scripts
npm run fmt:check
npm run build
npm test
npm run build:identity
npm run test:deployment
```

`npm run build:identity` reads only the local Foundry artifact at:

```text
out/PonteRouteDecisionEvidenceRegistry.sol/PonteRouteDecisionEvidenceRegistry.json
```

It prints canonical build identity JSON. For the reviewed V1 source and pinned build inputs, it reports:

| Derived value                | Value                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| Creation bytecode Keccak-256 | `0x940b3099535852d50430c006678e4d35aafd493e6659bda1250e5f6ea9d56573` |
| Runtime bytecode Keccak-256  | `0x4ee5b039c8cc55805c1b22d97eab5f3165693c3baa8bffb11d540c7fc0483345` |
| Runtime bytecode length      | `2131` bytes                                                         |
| Canonical ABI SHA-256        | `0x57b13e4d181c4ccdd584a71cf26fe8277fb34cc991b5d59b591ba630cc82e88a` |

These are artifact-derived build identities, not an address, deployment receipt, or proof of public availability. Operators must rerun the command from the exact approved revision rather than copy values from this document after any compiler, source, or build-setting change.

## 3. Constructor and role requirements

The registry constructor is:

```solidity
constructor(address initialAdmin, address initialAttestor)
```

The immutable contract itself rejects:

1. `block.chainid != 421614`;
2. a zero administrator or attestor; and
3. an administrator equal to the initial attestor.

The deployment script adds the same pre-broadcast safeguards in:

```text
contracts/script/DeployPonteRouteDecisionEvidenceRegistry.s.sol
```

It requires exactly these operator environment values:

```text
PONTE_REGISTRY_ADMIN
PONTE_REGISTRY_INITIAL_ATTESTOR
```

Both must parse as valid EVM addresses. Missing variables become `address(0)` only so the script can return an explicit configuration error; there is no fallback address, test-registry address, RPC URL, private key, credential, or contract address in source. Malformed address text is rejected by Foundry environment parsing. Zero values and role overlap are rejected by the script before `startBroadcast()`.

The script calls parameterless `vm.startBroadcast()`. It does not read a private key. A later approved operator chooses a broadcaster outside the repository, such as a managed Foundry account or an approved hardware-backed process.

## 4. Deployment script behavior

`DeployPonteRouteDecisionEvidenceRegistry.run()` follows this fixed order:

1. load administrator and initial-attestor addresses from the two named environment variables;
2. require the current EVM chain ID is exactly `421614`;
3. require both roles are nonzero and distinct;
4. begin broadcast only after every guard passes;
5. deploy the existing registry with those exact constructor arguments;
6. stop broadcast.

The script performs no role grants, revocations, admin handovers, evidence anchoring, application configuration, or verification submission. The contract constructor initializes the one supplied attestor and emits the established `AdminTransferred` and `AttestorSet` events.

A later operator-run command has this shape only after all approval gates below are complete:

```sh
cd contracts
export PONTE_REGISTRY_ADMIN='0x…'
export PONTE_REGISTRY_INITIAL_ATTESTOR='0x…'
npm run forge -- script/DeployPonteRouteDecisionEvidenceRegistry.s.sol:DeployPonteRouteDecisionEvidenceRegistry \
  --sig 'run()' \
  --rpc-url "$PONTE_SEPOLIA_RPC_URL" \
  --account "$PONTE_OPERATOR_ACCOUNT" \
  --broadcast
```

The ellipsis is deliberate: it is not an address, credential, or deployment instruction for this phase. The operator must first validate the RPC chain ID independently and must not use an unreviewed broadcaster, plaintext private-key shell argument, or shared admin/attestor identity.

## 5. Deployment manifest V1

A post-deployment JSON record must conform to:

```text
contracts/ponte-registry-deployment-manifest.schema.json
```

The executable strict validator is:

```text
contracts/tools/registry-deployment-manifest.mjs
```

Its required V1 fields are:

| Area                | Required fields                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Top level           | `manifestVersion: 1`, `chainId: "421614"`                                                                                   |
| Contract            | exact V1 contract name and version                                                                                          |
| Deployment          | lowercase nonzero registry address, deployment transaction hash, positive decimal block number, runtime bytecode Keccak-256 |
| Roles               | lowercase nonzero administrator and initial attestor, which must differ                                                     |
| Build               | exact compiler/optimizer/EVM/IR configuration and the same runtime-bytecode hash as deployment                              |
| ABI                 | ABI version `1`, SHA-256 algorithm, and canonical ABI hash                                                                  |
| Source verification | `not_submitted`, `verified`, or `failed`; a verification URL is required only for `verified` and must be HTTPS              |

Addresses and hashes are canonical lowercase `0x` hex. Block number is stored as a decimal string to prevent JSON number ambiguity. The validator rejects unknown fields, missing fields, zero addresses/hashes, malformed transaction details, a non-Sepolia chain ID, role overlap, unexpected compiler settings, inconsistent deployment/build runtime hashes, and malformed verification metadata.

After an operator records a real manifest, validate it against a fresh local artifact without network access:

```sh
npm run manifest:check -- \
  --manifest path/to/authorized-deployment-manifest.json
```

The command proves manifest/build identity agreement; it does not prove that the chain contains the registry.

## 6. Independent read-only deployment verification

`contracts/tools/verify-registry-deployment.mjs` exports an injectable:

```text
verifyRegistryDeployment(manifest, rpcCall)
```

The production command accepts a later-selected endpoint, but no endpoint is configured or contacted by this phase:

```sh
npm run verify:deployment -- \
  --manifest path/to/authorized-deployment-manifest.json \
  --rpc-url "$PONTE_SEPOLIA_RPC_URL"
```

Before it performs any contract call, it validates the manifest against the freshly rebuilt local artifact. It then executes only these read-only JSON-RPC requests:

1. `eth_chainId`, requiring `421614`;
2. `eth_getCode` for the manifest registry address, hashing returned runtime bytecode with Keccak-256 and comparing it to the manifest;
3. `eth_call` to `admin()`;
4. `eth_call` to `isAttestor(administrator)`, requiring `false`;
5. `eth_call` to `isAttestor(initialAttestor)`, requiring `true`;
6. `eth_call` to `evidenceHead(bytes32(0))`, expecting the empty initial head.

A wrong chain stops before bytecode access. A bytecode mismatch stops before role/interface calls. No request can sign, broadcast, deploy, fund, mutate roles, or anchor evidence.

The command emits only a fixed JSON result shape with a status of `verified`, `failed`, `rpc_error`, `invalid_manifest`, or `invalid_arguments`. It reports machine-readable check outcomes and fixed error categories rather than RPC URLs, credentials, or provider error text.

## 7. Local tests versus public deployment

The Foundry contract suite uses `vm.chainId(421614)` to exercise the constructor locally. The new deployment-script suite tests the script's guard with both `421614` and `31337`; it never calls `run()` and never starts a broadcast. The Node suite injects controlled RPC responses and does not create a fetch client or contact an endpoint.

Passing those tests establishes only local behavior:

- bytecode reproducibility under the pinned local compiler;
- configuration guard correctness;
- strict manifest validation; and
- deterministic read-only verification behavior against fake responses.

It does **not** establish an approved account, funded address, live RPC behavior, public deployment, block-explorer source verification, testnet confirmation, or attestor authorization on any public chain.

## 8. Mandatory approval gates before public deployment

All of the following must be approved and evidenced before an operator may broadcast:

1. an Arbitrum Sepolia RPC endpoint, chain-ID check, rate-limit/failure policy, and public-read verification path;
2. separate named administrator and attestor custody/rotation/revocation owners;
3. an approved broadcaster custody method and minimum testnet gas funding plan;
4. the exact deployment revision, clean worktree, pinned dependency lockfile, successful formatter/build/test/build-identity output, and reviewed bytecode/ABI hashes;
5. the real deployment manifest storage/review procedure;
6. public source-verification venue and any account/API approval it needs;
7. post-deployment receipt, block number, runtime-bytecode, role, and interface verification through the independent verifier; and
8. an explicit decision about later app configuration, outbox worker, signer, KMS, confirmation/reorganization, and judge-verification flows.

Deployment remains separate from application Routing activation. A deployed registry alone is not payment, settlement, custody, evidence-worker, KMS, or hosted-demo readiness.
