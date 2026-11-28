// This resolves the guarded local synthetic provider only. The service-level
// evidence dependency-selection point is resolveEvidencePreparationDependencies()
// in production-routing-config.ts, which dispatches here for development/test
// runtimes and to the fail-closed production resolver everywhere else. This
// module intentionally has no cloud SDK, credentials, production KMS, or
// plaintext fallback. Its synthetic provider is available only for an
// explicitly opted-in loopback database in local development or automated
// tests.
import "server-only";

import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { EvidenceCandidatePreparationError } from "./errors";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
  type CreatedAndWrappedDek,
  type DekProvider,
  type DekWrappingContext,
} from "./kms";
import type { RoutingPreparationDependencies } from "./routing-orchestration";

const LOCAL_TEST_PROVIDER_FLAG = "1";
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function unavailable(): never {
  // This intentionally has the same safe category as an unavailable production
  // provider. Do not disclose whether an opt-in, address, or database guard
  // was the reason local evidence preparation was denied.
  throw new EvidenceCandidatePreparationError("PROVIDER_FAILURE");
}

function hasLoopbackDatabase(): boolean {
  try {
    return LOOPBACK_DATABASE_HOSTS.has(
      new URL(process.env.DATABASE_URL ?? "").hostname,
    );
  } catch {
    return false;
  }
}

function localRuntimeIsAllowed(): boolean {
  return (
    (process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test") &&
    process.env.PONTE_DEV_AUTH === "1" &&
    hasLoopbackDatabase()
  );
}

function explicitLocalRegistryAddress(): string {
  try {
    const address = getAddress(
      process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS ?? "",
    ).toLowerCase();
    if (address === `0x${"00".repeat(20)}`) unavailable();
    return address;
  } catch (error) {
    if (error instanceof EvidenceCandidatePreparationError) throw error;
    return unavailable();
  }
}

/**
 * Deliberately non-production synthetic provider for local integration tests.
 * It uses fresh random data for both buffers: neither is a configured secret,
 * a plaintext fallback, a provider credential, nor a decryptable KMS envelope.
 * Its metadata is visibly local-test-only and must never be accepted as proof
 * of KMS-backed or on-chain evidence outside the guarded local runtime.
 */
class LocalTestDekProvider implements DekProvider {
  readonly provider = KMS_PROVIDER.LOCAL_TEST_ONLY;

  async createAndWrapDek(
    _context: DekWrappingContext,
  ): Promise<CreatedAndWrappedDek> {
    return {
      plaintextDek: randomBytes(32),
      // This is not KMS ciphertext and cannot be used to recover the DEK. Its
      // explicit format marks the record as synthetic local test data only.
      wrappedDek: randomBytes(48),
      kmsProvider: KMS_PROVIDER.LOCAL_TEST_ONLY,
      kmsKeyReference: "local-test-only/ephemeral/evidence",
      kmsKeyVersion: "local-test-only/ephemeral/v1",
      wrappedDekAlgorithm: WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      wrappedDekFormat: WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
    };
  }
}

/**
 * Returns local integration-only preparation dependencies only after every
 * explicit guard has passed. It is disabled by default and always fails closed:
 * unset, production, preview, or staging runtimes; non-loopback databases;
 * missing dev auth; absent opt-in; and an absent/invalid registry address never
 * receive a test provider.
 */
export function resolveLocalRoutingEvidencePreparationDependencies(): RoutingPreparationDependencies {
  if (
    !localRuntimeIsAllowed() ||
    process.env.PONTE_LOCAL_EVIDENCE_TEST_PROVIDER !== LOCAL_TEST_PROVIDER_FLAG
  ) {
    return unavailable();
  }
  return {
    provider: new LocalTestDekProvider(),
    registryAddress: explicitLocalRegistryAddress(),
  };
}
