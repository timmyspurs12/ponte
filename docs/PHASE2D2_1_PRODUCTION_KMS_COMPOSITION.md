# PONTE Phase 2D.2.1 — Fail-closed production KMS composition root

**Status:** composition seam only. This phase does **not** activate
production KMS, does not create cloud resources, and does not deliver
evidence. It establishes the narrowest service-level dependency-selection
point that selects the already-implemented `GcpKmsDekProvider` in
production, and fails closed whenever required server-controlled
configuration is missing, malformed, or unsupported.

## What is wired

- **`src/server/evidence/production-routing-config.ts`** (new):
  - `resolveProductionRoutingEvidencePreparationDependencies()` — validates
    the pinned KMS key resource and the Registry deployment configuration,
    then constructs the existing `GcpKmsDekProvider` from a lazily created,
    process-scoped official Google Cloud KMS client (Application Default
    Credentials). No new encryption implementation, no credential JSON, no
    private key material in environment variables, no custom authentication
    bypass.
  - `resolveEvidencePreparationDependencies()` — the single service-level
    evidence dependency-selection point. Development/test runtimes resolve
    the unchanged guarded local synthetic provider (all existing guards
    still apply). Every other runtime — including an unset `NODE_ENV` —
    selects the production resolver and never falls back to the synthetic
    provider.
  - `resolveProductionRoutingEvidencePreparationDependenciesForTest()` —
    the explicitly test-only seam for exercising the production composition
    function with a mocked Registry configuration and an injected mocked KMS
    client. See the test-only boundary below.
- **`src/server/evidence/gcp-kms-provider.ts`** — the client wrapping was
  extracted into `wrapKeyManagementServiceClient()`, a pure adaptation of an
  already-constructed official client into the narrow `GcpKmsClient`
  adapter boundary. It performs no credential discovery and no cloud call.
- **`src/server/service.ts`** — the normal Routing entrypoint now defaults
  its `resolvePreparationDependencies` to `resolveEvidencePreparationDependencies`
  instead of the local-only resolver. Explicit test injection through
  `__testOnlyExecute` is unchanged.

## Server-controlled configuration

- **KMS key resource:** `PONTE_KMS_CRYPTO_KEY_VERSION` — the exact
  immutable `CryptoKeyVersion` resource form validated by the adapter,
  including the approved `africa-south1` location restriction. A
  `CryptoKey` parent, alias, wrong region, or malformed version segment is
  rejected. No request body, user identity, URL parameter, or client-provided
  value can choose a KMS resource.
- **Registry address:** required from the single server-controlled
  deployment configuration source, `resolveTrustedReaderConfig()`. That
  function takes no input. No Registry address is invented, no placeholder
  deployment manifest is accepted, and no environment variable is treated as
  proof of a deployment.

## Test-only configuration boundary (runtime-enforced)

The production-facing functions take **no arguments**: they accept no
caller-injected Registry configuration and no caller-injected KMS client
factory. The production path accepts only the operator-scoped trusted
Registry configuration from the single deployment configuration source, and
`assertOperatorScopedReaderConfig()` rejects a test-scoped brand — a
test-scoped branded config can never be accepted as production deployment
authority.

Mock injection lives exclusively behind
`resolveProductionRoutingEvidencePreparationDependenciesForTest()`, which
throws unless `NODE_ENV === "test"`. It is never reachable from production
code: the service calls the selector with no arguments, and in
development/test the selector never reaches the production module at all,
so a KMS environment setting can never cause an ADC lookup or a Google
Cloud contact in local execution. KMS validation still flows through the
adapter's exact `CryptoKeyVersion` parser, the Registry address still comes
only from `resolveTrustedReaderConfig()`, and missing or malformed
configuration still fails closed with `PROVIDER_FAILURE` — no placeholder
or environment-variable Registry override, no synthetic fallback in
production.

## Lazy process-scoped KMS client reuse

No KMS client is constructed at import time. The official
`KeyManagementServiceClient` is created lazily on the first valid
production dependency resolution — and only after KMS configuration and
Registry configuration have both been validated — then reused for later
resolutions in the same process that resolve with the same key version.
No fresh client is constructed per Routing request. The cache is keyed by
the configured key version (the identity of the effective KMS
configuration): if the effective KMS configuration changes within a
running process, the cached pair is replaced — the previous official SDK
client is closed best effort — instead of silently reusing a client bound
to stale configuration. No cloud call occurs until a prepared evidence
candidate actually needs a DEK (the provider's `createAndWrapDek`).

## What remains blocked (preserved limitations)

- **No Registry deployment manifest exists.** `resolveTrustedReaderConfig()`
  reports `CONFIG_MISSING`, so `resolveProductionRoutingEvidencePreparationDependencies()`
  fails closed in production **today** — even with a valid pinned
  `CryptoKeyVersion`. Safe production composition requires a reviewed,
  operator-pinned deployment manifest (address, runtime bytecode hash, build
  identity, RPC endpoint). That is a prerequisite not present in the
  repository; it is deliberately not bypassed to make a test pass.
- **No real KMS calls in CI.** The GCP adapter is exercised only through
  injected mocked clients.
- **No key rotation or DEK rewrapping.** `unwrapDek()` requires the stored
  key version to match the configured provider version; multi-version
  historical decryption is not supported by a single current-version
  provider. Future rotation work must include a trusted resolver for
  previously approved versions.
- **No outbox worker, submission, confirmation, or chain-reader activation.**
  Outbox rows remain `pending`; anchoring stays unverified.

## Mocked tests and what they prove

`tests/evidence/production-routing-config.test.ts` and the additions to
`tests-backend/normal-routing-evidence.test.ts` prove:

1. Missing KMS configuration fails closed with `PROVIDER_FAILURE`.
2. Malformed key resources, CryptoKey parents, aliases, wrong region, and
   malformed versions fail closed.
3. Missing Registry deployment configuration fails closed even with valid
   KMS configuration.
4. The production-facing functions are option-free (zero declared
   parameters): no caller-injected Registry configuration or KMS client
   factory can reach the production path.
5. The test-only seam rejects use outside `NODE_ENV === "test"`.
6. A test-scoped Registry brand is rejected as production deployment
   authority.
7. Production configuration selects the existing `GcpKmsDekProvider` through
   the actual service dependency-selection path (selector + resolver).
8. The selected GCP provider executes the real preparation contract
   (`createAndWrapDek`) through an injected mocked KMS client.
9. Two valid dependency resolutions reuse one KMS client (one construction
   for both); a changed key version constructs a fresh pair and never
   silently reuses stale configuration; a repeat resolution of the same key
   version reuses the cached client.
10. Missing or invalid KMS configuration, and missing Registry
    configuration, construct no client at all (validation completes before
    any construction).
11. That mocked output is the deterministic test fixture — explicitly
    mocked test-only ciphertext, never represented as real Cloud KMS
    ciphertext, and never local-test provenance.
12. Local synthetic provider behavior is unchanged; development/test
    execution does not instantiate ADC or contact Google Cloud merely
    because a KMS environment setting exists (the selector never reaches the
    production resolver, and the injected client factory is never invoked).
13. The `__testOnlyExecute` dependency-injection path is unchanged.
14. No KMS client or ADC lookup occurs at module-import time (subprocess
    test with client-construction instrumentation, even with a valid KMS
    environment setting present).
15. Existing replay, idempotency, authorization, and routing preflight
    behavior is unchanged (full backend suite on PostgreSQL 16 and 18).

## Scope

No cloud resource creation or IAM provisioning, no real KMS calls in CI, no
key rotation or rewrapping, no outbox worker or scheduler, no transaction
signing or submission, no confirmation or chain-reader activation, no
Registry deployment, no blockchain RPC writes, no database migrations or
privilege changes, no Rust or Solidity changes, no payment provider
integration, Pix or USDG custody, no UI changes, no production deployment.
