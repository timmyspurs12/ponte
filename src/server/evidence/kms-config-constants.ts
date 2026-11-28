// Shared, dependency-free KMS configuration constants.
//
// This module exists so that configuration-policy modules (such as the
// approved KMS key-version configuration) do not depend on the production
// composition root that will eventually consume them. It deliberately
// contains no imports, no provider logic, and no cloud access.
import "server-only";

/**
 * The exact immutable `CryptoKeyVersion` resource supplied by the
 * deployment. It is server-controlled configuration, never request data.
 */
export const PRODUCTION_KMS_CRYPTO_KEY_VERSION_ENV = "PONTE_KMS_CRYPTO_KEY_VERSION";
