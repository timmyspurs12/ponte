# PONTE Phase 2D.2.2 — KMS key lifecycle: approved historical versions

**Status:** approved historical-version recovery is implemented in the
GCP KMS provider. This phase establishes a fail-closed, server-controlled
configuration contract for the approved versions of the existing GCP
symmetric Cloud KMS key, and the provider recovers DEKs wrapped by any
version in the effective approved set. It does **not** implement DEK
rewrapping, does **not** change the `DekProvider` write contract, and does
**not** activate production KMS or production evidence delivery.

## What this phase adds

`src/server/evidence/approved-kms-key-versions.ts` defines the approved
version configuration for the one GCP symmetric Cloud KMS key used by the
production evidence composition root:

| Field                     | Meaning                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `cryptoKeyReference`      | The stable parent `CryptoKey` resource shared by every approved version. |
| `currentWriteVersion`     | The single current write `CryptoKeyVersion` resource.                    |
| `approvedHistoricalVersions` | Zero or more explicitly approved historical `CryptoKeyVersion` resources. |

`resolveApprovedKmsKeyVersions()` is the production-facing resolver. It
takes **no caller-supplied arguments**: the authority is a
server-controlled, reviewed deployment configuration source — the same
class of source as the Registry deployment manifest used by
`resolveTrustedReaderConfig()`. No request data, database row,
caller-supplied value, or client-controlled value is configuration
authority. No key resource is invented and no version is fabricated.

**No reviewed KMS deployment configuration exists today**, so
`resolveApprovedKmsKeyVersions()` fails closed with the stable
`CONFIG_MISSING` result — exactly like the Registry deployment manifest.
Wiring a real reviewed configuration (and provisioning the production key)
is a deployment prerequisite, not a code task.

## Current write version vs approved historical decrypt versions

- The **current write version** is the only `CryptoKeyVersion` used when
  `GcpKmsDekProvider.createAndWrapDek()` wraps a fresh DEK. The adapter
  pins encryption to the exact immutable `CryptoKeyVersion` resource and
  re-verifies `EncryptResponse.name` against it.
- **Approved historical versions** are the versions the historical unwrap
  path is permitted to recover DEKs under. `GcpKmsDekProvider.unwrapDek()`
  authorizes a stored version by **approved-set membership**: the stored
  `kms_key_version` must belong to the effective approved set
  `{ currentWriteVersion } ∪ approvedHistoricalVersions`. Historical
  versions are **decrypt-only**: they are never used for fresh DEK
  wrapping, and no rewrapping is performed.
- The current write version belongs to the approved set by construction:
  it is validated with the same exact-resource rules as every historical
  version, and the effective approved set is the union
  `{ currentWriteVersion } ∪ approvedHistoricalVersions`.

## Server-controlled trust boundary

- The resolver reads only the reviewed deployment configuration source and
  takes no input. There is no request parameter, database row, environment
  override, or caller value that can select a KMS resource.
- Every approved version must parse as an exact immutable
  `CryptoKeyVersion` resource through the adapter's own parser
  (`parseGcpCryptoKeyVersion` / `parseGcpCryptoKey`), including the
  approved `africa-south1` location restriction.
- **Same-parent restriction:** every approved version must derive to
  exactly the one configured parent `CryptoKey`. A version under a
  different parent, an alias, a `CryptoKey` parent where a version is
  required, a wrong location, an empty entry, a malformed resource, a
  duplicate, or the current version repeated as historical all fail
  closed with `CONFIG_INVALID`. Supporting multiple parent `CryptoKeys`
  is outside this phase; the contract can never authorize cross-key
  decryption.
- The parser validates resource *syntax and policy only*. It never
  contacts Cloud KMS and never determines whether a version is enabled at
  runtime; that is a separate operational concern.

## Consistency with the PR #24 current-version configuration

The existing `PONTE_KMS_CRYPTO_KEY_VERSION` environment variable is the
PR #24 authority for the write version selected by the production
composition root (`src/server/evidence/production-routing-config.ts`). It
is not a second, independent source of the current version. Every
successful resolution enforces **exact consistency** between the reviewed
configuration's `currentWriteVersion` and the validated
`PONTE_KMS_CRYPTO_KEY_VERSION`: absence, malformation, or mismatch fails
closed with `CONFIG_INVALID`. The two sources may not disagree.

## Process restart requirement

The approved set, the parent reference, and the current write version are
one configuration unit. Following the immutable process-configuration
principle introduced in PR #24:

- The first successful resolution initializes the process-scoped
  configuration and records the unit.
- Later resolutions with the same unit reuse it.
- A later resolution yielding a different unit (different parent, write
  version, or approved set) **fails closed with `CONFIG_CHANGED`** and
  requires a **process restart**. The configuration is never silently
  reloaded or replaced while requests may be using it.
- A failed change never corrupts the initialized configuration.

This phase does not alter or weaken the existing KMS client lifecycle:
the process-scoped `KeyManagementServiceClient` introduced in PR #24
remains lazy, immutable, and restart-gated exactly as before.

## Historical unwrap authorization contract

`GcpKmsDekProvider.unwrapDek()` validates one persisted unwrapping input
against the immutable approved configuration and fails closed with the
existing fixed `PROVIDER_FAILURE` boundary — **before any Cloud KMS
request** — when any of the following does not hold:

- The stored provider, algorithm, and format match the supported GCP
  combination (`GCP_CLOUD_KMS`, `GOOGLE_SYMMETRIC_ENCRYPTION`,
  `GCP_KMS_ENCRYPT_CIPHERTEXT_V1`).
- The stored `kms_key_reference` equals the configured parent `CryptoKey`
  exactly.
- The stored `kms_key_version` parses as an exact immutable
  `CryptoKeyVersion` resource and derives to that same parent.
- The stored `kms_key_version` belongs to the effective approved set
  (`currentWriteVersion ∪ approvedHistoricalVersions`).

No arbitrary key reference or version list is accepted from request data,
database metadata, or caller configuration. The provider re-validates the
approved-version configuration at construction (defense in depth) and
never uses a historical version for `createAndWrapDek()`: fresh wrapping
remains pinned to the exact `currentWriteVersion` resource, with the
`EncryptResponse.name` equality, CRC32C, and size-budget checks intact.

## Stored `kms_key_version` is application provenance

Cloud KMS `Decrypt` is invoked against the parent `CryptoKey`; the server
selects the version identified by the ciphertext. The `DecryptResponse`
schema carries no version-identifying field (only `plaintext`,
`plaintextCrc32c`, `usedPrimary`, and `protectionLevel`). Therefore the
`kms_key_version` stored in `route_decision_evidence` is **trusted
application provenance, not independently verified by the Decrypt
response**. The approved-version contract is a policy control on top of
that provenance; the wrapping context AAD and CRC32C checks remain the
cryptographic integrity guarantees.

## What remains blocked (preserved limitations)

- **No DEK rewrapping.** No `DekRewrapper` capability exists, and no
  rewrap audit table or persisted rewrap operation is defined here.
  Historical versions are decrypt-only; existing wrapped DEK values are
  never rewritten.
- **No reviewed KMS deployment configuration and no provisioned
  production key.** The resolver fails closed until a reviewed
  configuration exists; no real KMS call is made in CI, and no cloud
  resource, IAM, or credential is provisioned.
- **No production evidence delivery.** The Registry deployment manifest
  is still missing, so the production composition root still fails
  closed.

## Related documentation

- [`PHASE1_2_4_KMS_ENVELOPE_METADATA.md`](PHASE1_2_4_KMS_ENVELOPE_METADATA.md)
  — persisted envelope metadata, provider contract, and the version-pinning
  boundary.
- [`PHASE2D2_1_PRODUCTION_KMS_COMPOSITION.md`](PHASE2D2_1_PRODUCTION_KMS_COMPOSITION.md)
  — the fail-closed production composition root and the immutable
  process-scoped KMS client.
