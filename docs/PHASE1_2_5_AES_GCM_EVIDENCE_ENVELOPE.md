# PONTE Phase 1.2.5 — AES-256-GCM evidence envelope primitive

**Status:** application-side cryptographic primitive only. This phase adds no
KMS client, provider implementation, credential, account, cloud resource,
evidence-generation path, Routing integration, database write, or API surface.

## Fixed interface

`src/server/evidence/envelope.ts` is server-only and uses only Node's built-in
`node:crypto` APIs. Its fixed identifiers match the existing evidence schema:

```ts
const EVIDENCE_ENVELOPE_VERSION = 1;
const EVIDENCE_CONTENT_ALGORITHM = "AES-256-GCM";

function encryptEvidenceEnvelope(input: {
  plaintext: Buffer;
  dek: Buffer;
  canonicalAad: Buffer;
}): {
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  envelopeVersion: 1;
  contentAlgorithm: "AES-256-GCM";
};

function decryptEvidenceEnvelope(input: {
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  envelopeVersion: 1;
  contentAlgorithm: "AES-256-GCM";
  dek: Buffer;
  canonicalAad: Buffer;
}): Buffer;
```

Encryption accepts a caller-supplied, exactly 32-byte plaintext DEK and creates
a fresh 12-byte nonce with Node's cryptographically secure random generator on
every call. It returns a 16-byte GCM authentication tag. Ciphertext, nonce, and
tag are opaque `Buffer` values. The returned persistence object deliberately
contains no plaintext DEK.

The caller supplies the canonical, non-secret AAD as a non-empty `Buffer`.
This phase neither defines nor changes the frozen AAD format. A future
application boundary must construct and validate the canonical record identity
and chain-context AAD required by the frozen evidence specification before
calling this primitive.

## Validation and authenticated decryption

Before cryptographic work, encryption/decryption reject non-`Buffer` values and
unsupported/malformed inputs. The primitive requires:

- a 32-byte DEK;
- non-empty plaintext and ciphertext, matching the persistence schema's
  non-empty ciphertext requirement;
- a 12-byte nonce;
- a 16-byte authentication tag;
- envelope version `1` and content algorithm `AES-256-GCM`; and
- non-empty canonical AAD.

It never pads, truncates, coerces, or repairs an input. Decryption buffers any
intermediate bytes internally and returns plaintext only after GCM
authentication completes. A wrong DEK, modified ciphertext/tag/nonce, or
mismatched AAD produces the generic `EvidenceEnvelopeAuthenticationError`.
Validation and authentication error messages contain field names or fixed text,
not plaintext, DEKs, raw AAD, ciphertext, tags, salts, or preimages. The module
does not log.

## DEK lifecycle ownership

The primitive does **not** generate, wrap, cache, persist, or clear a DEK. The
caller owns the plaintext DEK supplied to encrypt/decrypt, and encryption does
not mutate that caller-owned buffer. After all required cryptographic work, the
caller is responsible for calling the existing best-effort clearing helper on
its temporary buffer. Decryption callers have the same responsibility.

Best-effort `Buffer.fill(0)` is not a promise of guaranteed Node.js secure
zeroization: JavaScript copies, garbage collection, native crypto buffers, and
runtime internals remain outside that guarantee. No plaintext or locally stored
production-key fallback is introduced.

## Provider/result consistency

`assertCreatedAndWrappedDek` remains the pure result validator in
`src/server/evidence/kms.ts`. Phase 1.2.5 adds
`assertDekProviderResult(provider, result)` for the provider boundary. It first
validates the result metadata tuple and then requires
`provider.provider === result.kmsProvider`. The explicit
`createAndValidateWrappedDek(provider, context)` boundary helper invokes the
narrow provider operation and applies that comparison. A provider declaring GCP
therefore cannot return an otherwise valid AWS result, and vice versa.

This check is only a contract guard. There is still no provider implementation,
SDK dependency, KMS request, or credential in this repository.

## Frozen transaction boundary

The future evidence generator must perform provider interaction and this
application-side encryption outside the final Routing transaction. Any provider
or encryption failure must fail closed before Routing, settlement, evidence,
outbox, lifecycle-event, or idempotency writes. This phase does not call either
primitive from `src/server/service.ts` and does not enable normal-flow evidence
creation.
