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
// ## No import-time or eager cloud work
//
// This module imports no KMS client and constructs nothing at import time.
// The official client factory is invoked only when a production dependency
// set is actually resolved, and no cloud call is made until a prepared
// evidence candidate needs a DEK (the provider's `createAndWrapDek`).
//
// ## Test seam
//
// `ProductionPreparationResolverTestOptions` exists so tests can exercise
// the composition function with a mocked KMS client and a test-scoped
// Registry configuration. It is never supplied by production code: the
// service calls `resolveEvidencePreparationDependencies()` with no
// arguments, and in development/test the selector never reaches this
// module at all, so a KMS environment setting can never cause an ADC
// lookup or a Google Cloud contact in local execution.
import "server-only";

import {
  GcpKmsDekProvider,
  createGcpKmsDekProviderWithApplicationDefaultCredentials,
  parseGcpCryptoKeyVersion,
  type GcpKmsClient,
} from "./gcp-kms-provider";
import { EvidenceCandidatePreparationError } from "./errors";
import { resolveLocalRoutingEvidencePreparationDependencies } from "./local-routing-config";
import type { RoutingPreparationDependencies } from "./routing-orchestration";
import {
  isBrandedReaderConfig,
  resolveTrustedReaderConfig,
  type TrustedReaderConfigResult,
} from "./trusted-reader-config";

/**
 * The exact immutable `CryptoKeyVersion` resource supplied by the
 * deployment. It is server-controlled configuration, never request data.
 */
export const PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV = "PONTE_KMS_CRYPTO_KEY_VERSION";

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
 * Test-only seam for exercising the production composition function without
 * real cloud access. Production code never supplies these options:
 *
 * - `readerConfig` replaces the server-controlled Registry configuration
 *   source with a branded test-scoped configuration. It is a mocked test
 *   fixture, never a real Registry deployment.
 * - `clientFactory` replaces the official ADC client factory with an
 *   injected mocked KMS client. Its output is mocked test-only ciphertext,
 *   never real Cloud KMS ciphertext.
 */
export interface ProductionPreparationResolverTestOptions {
  readonly readerConfig?: TrustedReaderConfigResult;
  readonly clientFactory?: () => GcpKmsClient;
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

/**
 * Resolves the production evidence preparation dependencies: the existing
 * `GcpKmsDekProvider` built from the official Google Cloud KMS client
 * factory and Application Default Credentials, plus the Registry address from
 * the operator-pinned deployment configuration.
 *
 * Both configuration sources are required. Missing KMS configuration,
 * malformed or unsupported key resources, and a missing Registry deployment
 * configuration all fail closed with `PROVIDER_FAILURE`. There is no
 * plaintext fallback and no synthetic provider fallback.
 */
export function resolveProductionRoutingEvidencePreparationDependencies(
  options?: ProductionPreparationResolverTestOptions,
): RoutingPreparationDependencies {
  const cryptoKeyVersion = readConfiguredCryptoKeyVersion();

  // The Registry address comes only from the operator-pinned deployment
  // configuration. In production this is `resolveTrustedReaderConfig()`,
  // which takes no input and reports CONFIG_MISSING until a reviewed
  // deployment manifest exists; until then production fails closed.
  const readerConfig = options?.readerConfig ?? resolveTrustedReaderConfig();
  if (!readerConfig.ok || !isBrandedReaderConfig(readerConfig.config))
    return failClosed();

  const registryAddress = readerConfig.config.registryAddress;
  if (!REGISTRY_ADDRESS_PATTERN.test(registryAddress)) return failClosed();

  const provider =
    options?.clientFactory
      ? new GcpKmsDekProvider({
          cryptoKeyVersion,
          client: options.clientFactory(),
        })
      : createGcpKmsDekProviderWithApplicationDefaultCredentials(
          cryptoKeyVersion,
        );

  return { provider, registryAddress };
}

/**
 * The single service-level evidence dependency-selection point used by the
 * normal Routing entrypoint.
 *
 * Development/test runtimes keep the unchanged guarded local synthetic
 * provider (all existing guards still apply, and KMS environment settings are
 * ignored — no ADC lookup or Google Cloud contact occurs merely because a KMS
 * setting exists). Every other runtime — including an unset `NODE_ENV` —
 * selects the fail-closed production resolver and never falls back to the
 * synthetic provider.
 */
export function resolveEvidencePreparationDependencies(
  options?: ProductionPreparationResolverTestOptions,
): RoutingPreparationDependencies {
  if (isLocalEvidenceRuntime())
    return resolveLocalRoutingEvidencePreparationDependencies();
  return resolveProductionRoutingEvidencePreparationDependencies(options);
}
