// Production (non-local) evidence preparation dependency resolution.
//
// Phase 2D.2.1: a fail-closed composition seam only. It does NOT activate
// production KMS, does NOT create cloud resources, and does NOT deliver
// evidence. It selects the already-implemented `GcpKmsDekProvider` through
// the narrowest service-level dependency-selection point, and fails closed
// with the existing fixed `PROVIDER_FAILURE` boundary whenever the required
// server-controlled configuration is missing, malformed or unsupported.
//
// ## Server-controlled configuration
//
// The KMS key resource is read from the `PONTE_KMS_CRYPTO_KEY_VERSION`
// environment variable. Environment variables are deployment configuration,
// not request data: no request body, user identity, URL parameter or
// client-provided value can choose a KMS resource. The value must be the
// exact immutable `CryptoKeyVersion` resource form validated by the adapter
// (`parseGcpCryptoKeyVersion`), including the approved `africa-south1`
// location restriction.
//
// The Registry address is required from the single server-controlled
// deployment configuration source, `resolveTrustedReaderConfig()`. That
// function takes no input and reports `CONFIG_MISSING` until a genuinely
// reviewed deployment manifest exists. No Registry address is invented, no
// placeholder manifest is accepted, and no environment variable is treated
// as proof of a deployment. Until the manifest exists, production
// resolution fails closed — that limitation is preserved explicitly.
//
// ## Test-only boundary
//
// The production-facing functions take **no arguments**: they accept no
// caller-injected Registry configuration and no caller-injected KMS client
// factory. The production path accepts only the operator-scoped trusted
// Registry configuration; `assertOperatorScopedReaderConfig()` rejects a
// test-scoped brand, so a test configuration can never be production
// deployment authority.
//
// Mock injection lives behind `resolveProductionRoutingEvidencePreparationDependenciesForTest()`,
// which throws unless `NODE_ENV === "test"`. It is never reachable from
// production code: the service calls `resolveEvidencePreparationDependencies()`
// with no arguments, and in development/test the selector never reaches this
// module at all, so a KMS environment setting can never cause an ADC lookup
// or a Google Cloud contact in local execution.
//
// ## Lazy process-scoped KMS client reuse
//
// This module constructs no KMS client at import time. The official
// `KeyManagementServiceClient` is created lazily on the first valid
// production dependency resolution and reused for later resolutions in the
// same process that resolve with the same key version. If the effective
// KMS configuration changes within a running process, the cached client is
// replaced (the previous SDK client is closed best effort) rather than
// silently reused for stale configuration. No cloud call is made until a
// prepared evidence candidate actually needs a DEK (the provider's
// `createAndWrapDek`).
import "server-only";

import { KeyManagementServiceClient } from "@google-cloud/kms";
import {
  GcpKmsDekProvider,
  parseGcpCryptoKeyVersion,
  wrapKeyManagementServiceClient,
  type GcpKmsClient,
} from "./gcp-kms-provider";
import { EvidenceCandidatePreparationError } from "./errors";
import { resolveLocalRoutingEvidencePreparationDependencies } from "./local-routing-config";
import type { RoutingPreparationDependencies } from "./routing-orchestration";
import {
  isBrandedReaderConfig,
  resolveTrustedReaderConfig,
  type OperatorTrustedReaderConfig,
  type TrustedReaderConfigResult,
} from "./trusted-reader-config";

/**
 * The exact immutable `CryptoKeyVersion` resource supplied by the
 * deployment. It is server-controlled configuration, never request data.
 */
export const PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV = "PONTE_KMS_CRYPTO_KEY_VERSION";

/** Stable message for the test-only seam's production rejection. */
export const PRODUCTION_RESOLVER_TEST_SEAM_ERROR =
  "production resolver test seam is unavailable outside the test environment";

/** Canonical lowercase 20-byte hex Registry address form. */
const REGISTRY_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * True only for the explicitly opted-in local development/test runtime.
 * The local synthetic provider is reachable exclusively through this gate,
 * and production never falls back to it.
 */
export function isLocalEvidenceRuntime(): boolean {
  return (
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
  );
}

/**
 * Fails with the existing fixed provider boundary. The reason (missing
 * configuration, malformed resource, absent manifest) is deliberately not
 * disclosed, matching the provider-failure behavior of the adapter.
 */
function failClosed(): never {
  throw new EvidenceCandidatePreparationError("PROVIDER_FAILURE");
}

/**
 * The production path accepts only an operator-scoped trusted Registry
 * configuration. A test-scoped brand is never production deployment
 * authority and is rejected here even though the production configuration
 * source cannot currently produce one.
 */
export function assertOperatorScopedReaderConfig(
  config: OperatorTrustedReaderConfig,
): void {
  if (config.testOnly) failClosed();
}

/**
 * Reads and validates the pinned KMS key resource before any provider or
 * client is constructed. Missing configuration fails closed; every malformed
 * form — CryptoKey parent, alias, wrong region, malformed version segment —
 * is rejected by the adapter's own exact-resource validation, which also
 * fails closed with the same fixed provider error.
 */
function readConfiguredCryptoKeyVersion(): string {
  const raw = process.env[PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV];
  if (typeof raw !== "string" || raw.length === 0) return failClosed();
  return parseGcpCryptoKeyVersion(raw).cryptoKeyVersion;
}

/** One KMS client pair: the narrow adapter boundary plus the official SDK
 * client it wraps. Injected test factories provide only the narrow client. */
interface KmsClientCreation {
  readonly narrow: GcpKmsClient;
  readonly official: KeyManagementServiceClient | undefined;
}

type KmsClientFactory = () => KmsClientCreation;

interface KmsClientCacheEntry {
  readonly keyVersion: string;
  readonly narrow: GcpKmsClient;
  readonly official: KeyManagementServiceClient | undefined;
}

/**
 * Process-scoped lazy client cache. The cache is keyed by the configured
 * key version — the identity of the effective KMS configuration: a
 * resolution with a different key version always constructs a fresh pair
 * instead of silently reusing a client bound to stale configuration. The
 * replaced SDK client is closed best effort.
 */
let kmsClientCache: KmsClientCacheEntry | undefined;

/** Production factory: one official SDK client, wrapped once. */
function createProductionKmsClient(): KmsClientCreation {
  const official = new KeyManagementServiceClient();
  return { official, narrow: wrapKeyManagementServiceClient(official) };
}

function acquireKmsClient(
  keyVersion: string,
  factory: KmsClientFactory,
): GcpKmsClient {
  if (kmsClientCache?.keyVersion === keyVersion) {
    return kmsClientCache.narrow;
  }
  if (kmsClientCache?.official) {
    try {
      kmsClientCache.official.close();
    } catch {
      // Best effort only: cleanup must never replace the resolution outcome.
    }
  }
  const created = factory();
  kmsClientCache = {
    keyVersion,
    narrow: created.narrow,
    official: created.official,
  };
  return created.narrow;
}

/**
 * Shared production dependency construction. Configuration is fully
 * validated before any client is constructed: a missing Registry
 * manifest, a malformed Registry address, or a rejected configuration never
 * reaches `acquireKmsClient`.
 */
function buildProductionDependencies(
  cryptoKeyVersion: string,
  readerConfig: TrustedReaderConfigResult,
  clientFactory: KmsClientFactory,
  enforceOperatorScope: boolean,
): RoutingPreparationDependencies {
  if (!readerConfig.ok || !isBrandedReaderConfig(readerConfig.config))
    return failClosed();
  if (enforceOperatorScope)
    assertOperatorScopedReaderConfig(readerConfig.config);

  const registryAddress = readerConfig.config.registryAddress;
  if (!REGISTRY_ADDRESS_PATTERN.test(registryAddress)) return failClosed();

  const client = acquireKmsClient(cryptoKeyVersion, clientFactory);
  return {
    provider: new GcpKmsDekProvider({ cryptoKeyVersion, client }),
    registryAddress,
  };
}

/**
 * Resolves the production evidence preparation dependencies: the existing
 * `GcpKmsDekProvider` built from the official Google Cloud KMS client and
 * Application Default Credentials, plus the Registry address from the
 * operator-pinned deployment configuration.
 *
 * This production-facing function takes no arguments. The Registry
 * configuration comes only from `resolveTrustedReaderConfig()` and the KMS
 * client is created and reused internally. Missing KMS configuration,
 * malformed or unsupported key resources, and a missing Registry deployment
 * configuration all fail closed with `PROVIDER_FAILURE`. There is no
 * plaintext fallback and no synthetic provider fallback.
 */
export function resolveProductionRoutingEvidencePreparationDependencies(): RoutingPreparationDependencies {
  const cryptoKeyVersion = readConfiguredCryptoKeyVersion();
  return buildProductionDependencies(
    cryptoKeyVersion,
    resolveTrustedReaderConfig(),
    createProductionKmsClient,
    true,
  );
}

/**
 * Test-only seam for exercising the production composition function without
 * real cloud access. It throws unless `NODE_ENV === "test"`, and is never
 * supplied by production code.
 *
 * - `readerConfig` replaces the server-controlled Registry configuration
 *   source with a branded test-scoped configuration. It is a mocked test
 *   fixture, never a real Registry deployment, and is explicitly not
 *   production deployment authority.
 * - `clientFactory` replaces the production client factory with an injected
 *   mocked KMS client. Its output is mocked test-only ciphertext, never
 *   real Cloud KMS ciphertext.
 */
export function resolveProductionRoutingEvidencePreparationDependenciesForTest(options: {
  readonly readerConfig: TrustedReaderConfigResult;
  readonly clientFactory: () => GcpKmsClient;
}): RoutingPreparationDependencies {
  if (process.env.NODE_ENV !== "test")
    throw new Error(PRODUCTION_RESOLVER_TEST_SEAM_ERROR);
  const cryptoKeyVersion = readConfiguredCryptoKeyVersion();
  return buildProductionDependencies(
    cryptoKeyVersion,
    options.readerConfig,
    () => ({ narrow: options.clientFactory(), official: undefined }),
    false,
  );
}

/**
 * The single service-level evidence dependency-selection point used by the
 * normal Routing entrypoint. This production-facing function takes no
 * arguments.
 *
 * Development/test runtimes keep the unchanged guarded local synthetic
 * provider (all existing guards still apply, and KMS environment settings are
 * ignored — no ADC lookup or Google Cloud contact occurs merely because a KMS
 * setting exists). Every other runtime — including an unset `NODE_ENV` —
 * selects the fail-closed production resolver and never falls back to the
 * synthetic provider.
 */
export function resolveEvidencePreparationDependencies(): RoutingPreparationDependencies {
  if (isLocalEvidenceRuntime())
    return resolveLocalRoutingEvidencePreparationDependencies();
  return resolveProductionRoutingEvidencePreparationDependencies();
}
