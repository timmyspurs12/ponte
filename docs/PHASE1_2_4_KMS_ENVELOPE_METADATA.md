# PONTE Phase 1.2.4 — KMS envelope metadata and DEK-provider contract

**Status:** schema and TypeScript contract only. No Cloud KMS, AWS KMS, HSM,
credential, client library, account, key, request, evidence-generation path, or
Routing integration is created by this phase.

## Why this amendment exists

`route_decision_evidence` already stores opaque `wrapped_dek` bytes together
with `kms_key_reference` and `kms_key_version`. Those fields were insufficient
to interpret provider ciphertext safely because they did not state the provider,
the wrapping operation/algorithm, or the opaque ciphertext serialization.

Migration `004_kms_envelope_metadata.sql` adds three required fields:

| Column                  | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `kms_provider`          | Reviewed provider identifier for the opaque wrapped-DEK bytes.          |
| `wrapped_dek_algorithm` | Provider operation/algorithm identifier used to produce those bytes.    |
| `wrapped_dek_format`    | Non-secret, versioned serialization discriminator for the opaque bytes. |

The existing columns retain, and now have explicit, meanings:

| Column              | Meaning                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms_key_reference` | The stable provider key resource/reference used for wrapping. It is not a display label and is not the per-operation version/material value.                            |
| `kms_key_version`   | The exact provider version or key-material identifier recorded for the wrapping operation. A provider path that cannot supply this metadata must fail before insertion. |
| `wrapped_dek`       | Provider-opaque bytes. PostgreSQL never parses or decodes them.                                                                                                         |

The migration permits only the reviewed initial tuples below. This is an
allowlist, not a claim that PONTE has selected or implemented either provider.

| `kms_provider`  | `wrapped_dek_algorithm`             | `wrapped_dek_format`                           |
| --------------- | ----------------------------------- | ---------------------------------------------- |
| `gcp-cloud-kms` | `GOOGLE_SYMMETRIC_ENCRYPTION`       | `gcp-kms-encrypt-ciphertext-v1`                |
| `aws-kms`       | `AWS_KMS_GENERATE_DATA_KEY_AES_256` | `aws-kms-generate-data-key-ciphertext-blob-v1` |

`AWS_KMS_GENERATE_DATA_KEY_AES_256` is a PONTE identifier for the documented
operation (`GenerateDataKey` with an AES-256 data key) and opaque
`CiphertextBlob` representation. It is not a claim that the AWS ciphertext has
a portable, application-decodable wire algorithm.

All identifiers are bounded and character constrained. There are no nullable
metadata fields, defaults, generic provider values, or metadata backfills.

### Forward-only safety rule

Metadata for a historic row cannot be inferred from opaque ciphertext. Before
adding the non-null columns, migration 004 aborts if any
`route_decision_evidence` row exists. The operator must perform a separately
approved export/reconciliation path with explicit metadata; this migration will
not fabricate it. Normal test/reset workflows remain compatible because they
start from a clean schema or truncate rows after the migration is applied.

## Provider-neutral contract

`src/server/evidence/kms.ts` defines a narrow `DekProvider` boundary:

```ts
interface DekProvider {
  readonly provider: KmsProviderIdentifier;
  createAndWrapDek(context: DekWrappingContext): Promise<CreatedAndWrappedDek>;
}
```

There is deliberately no `wrapDek(dek)` method. The provider operation creates
one fresh DEK and returns it with its wrapped representation and complete
metadata. That operation can cover both legitimate workflows:

1. a provider implementation creates a fresh DEK locally with Node CSPRNG, then
   asks its KMS to wrap it; or
2. a provider asks its KMS to create the fresh DEK and returns the provider's
   plaintext and wrapped forms.

`CreatedAndWrappedDek` always contains exactly one 32-byte `plaintextDek`,
non-empty opaque `wrappedDek`, provider/key/version/algorithm/format metadata.
`assertCreatedAndWrappedDek` enforces those properties without generating a
key, encrypting content, calling a network, or logging any bytes. The contract
exposes neither a generic cloud SDK client nor key administration.

The input context is application-built canonical, non-secret wrapping context.
It is derived from the approved AAD version and digest; it does not contain
private evidence plaintext, salts, or commitment preimages.

The content-encryption owner remains PONTE application code, not the provider:

- construct and validate canonical application AAD;
- create/validate a fresh 12-byte content nonce;
- AES-256-GCM encrypt/decrypt evidence using the 32-byte DEK;
- store and verify the 16-byte GCM authentication tag;
- verify decrypted content before use; and
- best-effort overwrite temporary caller-owned DEK `Buffer`s after use.

`clearDekBestEffort` only calls `Buffer.fill(0)`. It does **not** promise secure
zeroization: JavaScript copies, garbage collection, native/provider buffers,
and runtime internals are outside its guarantee.

Never log plaintext DEKs, private evidence, raw AAD, salts, preimages, or
decrypted content.

## Conditional GCP mapping — documentation only

This is the conditionally preferred future provider path; it does not create a
GCP dependency or select/provision a GCP resource.

1. Generate a fresh 32-byte DEK with Node's cryptographic CSPRNG.
2. Create the canonical non-secret KMS wrapping context from the approved AAD
   version and AAD digest.
3. Call Cloud KMS `cryptoKeys.encrypt` against an explicitly selected
   `CryptoKeyVersion` resource, passing the DEK as `plaintext` and exactly that
   context as `additionalAuthenticatedData`.
4. Verify the returned `EncryptResponse.name` is the intended
   `CryptoKeyVersion`; the Cloud KMS API documents this response field as the
   version used for encryption.
5. Persist the parent `CryptoKey` resource as `kms_key_reference`, the returned
   exact `CryptoKeyVersion` resource as `kms_key_version`, returned ciphertext
   unchanged as opaque `wrapped_dek`, and:

   ```text
   kms_provider             = gcp-cloud-kms
   wrapped_dek_algorithm    = GOOGLE_SYMMETRIC_ENCRYPTION
   wrapped_dek_format       = gcp-kms-encrypt-ciphertext-v1
   ```

Cloud KMS permits `encrypt` at either a `CryptoKey` or a `CryptoKeyVersion`
resource; using a version explicitly plus checking the response prevents an
unexpected primary-version selection. `GOOGLE_SYMMETRIC_ENCRYPTION` is the
Cloud KMS REST algorithm identifier for its standard symmetric AES-256-GCM
algorithm with Cloud KMS internal metadata.

During decryption, call `cryptoKeys.decrypt` with the **parent CryptoKey**,
wrapped ciphertext, and the same wrapping context. Cloud KMS documents that the
server chooses the appropriate version when decrypting through that parent
CryptoKey. The stored `kms_key_version` remains immutable audit/verification
metadata; it is not substituted into the decrypt endpoint path.

References: [Cloud KMS envelope encryption](https://cloud.google.com/kms/docs/envelope-encryption),
[`cryptoKeys.encrypt`](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt),
[`cryptoKeys.decrypt`](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/decrypt),
and [Cloud KMS key algorithms](https://cloud.google.com/kms/docs/algorithms).

## AWS future compatibility — documentation only

AWS KMS `GenerateDataKey` is not equivalent to a caller-supplied
`wrapDek(dek)`: it generates a fresh symmetric data key and returns both a
plaintext form and the KMS-encrypted `CiphertextBlob`. Its response can include
`KeyId` and `KeyMaterialId`. A future AWS provider can implement
`createAndWrapDek` by requesting `KeySpec = AES_256`, returning the plaintext
as the contract's 32-byte DEK and `CiphertextBlob` unchanged as `wrappedDek`.
It must record the returned stable key reference and exact key-material
identifier, and must fail rather than insert an incomplete record if the needed
metadata is unavailable.

No AWS SDK, dependency, KMS call, or AWS selection is introduced here. See
[AWS `GenerateDataKey`](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html).

## Frozen transaction and security invariants

- KMS interaction and evidence encryption occur **outside** the final Routing
  PostgreSQL transaction.
- The final transaction re-locks and revalidates the invoice, quote, route, and
  idempotency state; it compares the prepared candidate with currently valid
  persisted state.
- A KMS/encryption failure means no Routing, settlement, evidence, outbox,
  lifecycle-event, or idempotency write occurs.
- There is no plaintext or locally stored production-key fallback.
- No KMS call occurs inside the final database transaction.
- The final insertion cannot omit provider, algorithm, format, key reference,
  key version, wrapped DEK, nonce, tag, or other existing required envelope
  fields.

## Production IAM permissions

A production service account used by the composition root must hold exactly
the KMS permissions the adapter actually performs. The adapter issues
`Encrypt` (to wrap a fresh DEK) and `Decrypt` (to unwrap a DEK), so the
required permission identifiers are:

- `cloudkms.cryptoKeyVersions.useToEncrypt`
- `cloudkms.cryptoKeyVersions.useToDecrypt`

Do not grant `cloudkms.cryptoKeys.encryptTo`-style or broadly named
`decrypt` permissions that do not exist in the Cloud KMS IAM reference; the
identifiers above are the actual ones. The account must not hold key
administration permissions (`cloudkms.cryptoKeys.*` management roles) — the
adapter has no key-creation, rotation, listing, or deletion surface.

## Version pinning and the unwrap boundary

The adapter pins one exact immutable `CryptoKeyVersion` resource for wrapping.
`unwrapDek()` requires the **stored** key version recorded in the persisted
metadata to match the **configured** provider version: a row wrapped under a
different version is rejected, not silently re-decrypted. A single
current-version provider therefore does **not** support multi-version
historical decryption. Future rotation and DEK-rewrapping work must include a
trusted resolver for previously approved key versions; until that work
exists, rotation is not available and must not be claimed.

## Composition status

Phase 2D.2.1 added the fail-closed production composition root
(`src/server/evidence/production-routing-config.ts`) selected by the service.
Production resolution requires both a valid pinned `CryptoKeyVersion` and a
server-controlled Registry deployment configuration; until the reviewed
deployment manifest exists, production resolution fails closed. This phase
does not perform real KMS calls in CI and does not activate production
evidence delivery — see
[`PHASE2D2_1_PRODUCTION_KMS_COMPOSITION.md`](PHASE2D2_1_PRODUCTION_KMS_COMPOSITION.md).
