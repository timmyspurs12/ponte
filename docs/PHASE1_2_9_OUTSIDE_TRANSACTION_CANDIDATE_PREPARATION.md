# Phase 1.2.9 — Outside-Transaction Evidence Candidate Preparation

**Status:** implemented as an isolated, non-persisting server-side preparation boundary.

This phase introduces `src/server/evidence/prepare-candidate.ts`. It can turn an
already-read, valid persisted snapshot into a fresh encrypted **candidate** using
an injected `DekProvider`. It does not make normal Routing evidence-ready.

The Phase 1.2.7 audit and Phase 1.2.8 persisted read-model contract remain
unchanged.

## Purpose and boundary

Candidate preparation is deliberately outside any future final evidence
transaction:

1. A caller first obtains a completed `EvidencePreparationSnapshot` through the
   existing Phase 1.2.8 non-locking, read-only snapshot operation. That read has
   ended and released its connection before this module begins.
2. The caller gives this module only a `kind: "ready"` snapshot, a canonical
   selected route ID, an explicit nonzero registry address, an authenticated
   actor UUID, an existing request-fingerprint value, and an injected
   `DekProvider`.
3. The module validates the persisted bindings and freshness shape before the
   provider is invoked, derives V1 commitments/AAD/context/payload, requests a
   fresh wrapped DEK through the narrow injected contract, encrypts the private
   payload, and returns a non-persisted candidate.
4. A later, deliberately out-of-scope final transaction must lock and
   revalidate authoritative rows, decide whether it is authorized to persist
   the candidate, insert evidence/outbox rows atomically, and handle normal
   lifecycle integration.

The module has only a **type-only** dependency on `repository.ts`. It does not
import or call the repository at runtime, `service.ts`, Routing, database or
transaction APIs, write helpers, outbox helpers, an external SDK, a cloud API,
or a concrete KMS client. It acquires no connection, lock, transaction, or
write capability.

There is no environment- or configuration-derived registry fallback. A caller
must provide a valid nonzero EVM address every time.

## Accepted input and pre-provider validation

`PrepareEvidenceCandidateInput` is typed to accept only
`ReadyEvidencePreparationSnapshot`, the `kind: "ready"` arm of
`EvidencePreparationSnapshot`. Runtime defense rejects other snapshot forms,
including missing/expired quote results. It also rejects, before calling the
provider:

- a non-`Funded` invoice, non-BRL generated currency projection, missing or
  mismatched JSON compatibility amount, or incompatible invoice/quote identity;
- a quote that is expired at preparation time, non-simulated, from a non-frozen
  source, inconsistent with the persisted funding amount, malformed, or does
  not contain the selected canonical route;
- an unknown selected route, malformed/noncanonical actor UUID, malformed
  request fingerprint, zero/invalid registry, or malformed provider shape.

The existing frozen commitment and private-payload builders perform the deeper
canonical quote, route, integer, and cross-binding validation before the
provider call. Their failures are converted to the non-sensitive
`INVALID_INPUT` boundary error. A snapshot may still become stale after this
outside-transaction preparation; that is why final locked-row revalidation
remains mandatory.

Callers cannot supply economics, commitments, evidence IDs, salts, private
payload bytes, ciphertext, a plaintext DEK, or provider-result metadata. The
module creates fresh UUIDs for the evidence record, routing correlation, and
outbox identifiers, and fresh nonzero 32-byte public evidence ID and salt
values. It fixes V1 sequence to `"1"` and previous payload hash to zero.

## Construction sequence

For a valid snapshot, preparation uses existing frozen components in this
order:

1. Canonicalize persisted identity fields and create the fresh record/public
   identifiers and salt.
2. Call `buildRouteDecisionCommitment()` using the authoritative persisted
   amount and fixed quote record. The caller selected route is the only
   selection input.
3. Build canonical V1 AAD with `buildCanonicalPrivateEvidenceAad()`, then bind
   its digest with `buildKmsWrappingContext()`.
4. Build the canonical private payload with
   `buildCanonicalPrivateEvidencePayload()` and an explicitly narrowed
   expected-commitment object. This prevents the private-payload builder from
   accepting a different derived commitment.
5. Await `provider.createAndWrapDek({ canonicalContext })` directly, capture
   the raw plaintext-DEK value, and validate the result through
   `assertDekProviderResult()`.
6. Encrypt the private payload with `encryptEvidenceEnvelope()` and return only
   copied non-secret envelope/provider fields.

The provider remains a narrow injected interface. This phase supplies no
provider implementation, key resource, credential configuration, SDK, local
key, or cloud request.

## Candidate contents and exclusions

`PreparedEvidenceCandidate` contains the complete information a future final
transaction will need to re-check and map into evidence/outbox inserts:

- normalized request fingerprint and authenticated actor ID;
- fresh routing-correlation, evidence-record, and outbox IDs;
- persisted business/invoice/quote identities, `Funded` snapshot state,
  authoritative funding minor amount, generated BRL currency projection,
  fixed quote source/simulation metadata, expiry milliseconds, canonical quote
  economics/routes, and selected route ID/code;
- public evidence ID; AAD/evidence/quote schema versions; chain ID; explicit
  canonical registry; sequence; evidence kind; and previous payload hash;
- route hashes, routes hash, quote snapshot hash, payload hash, canonical-AAD
  digest, and wrapping-context digest;
- envelope version/algorithm/ciphertext/nonce/authentication tag; and validated
  wrapped DEK, provider identifier, wrapping algorithm/format, key reference,
  and key version;
- `preparedCandidateDigest`, described below.

The candidate never carries plaintext DEK bytes, the salt, private plaintext
payload, raw canonical AAD, raw KMS wrapping context, unvalidated provider
metadata, provider clients, or credentials. The public ID, wrapped DEK,
commitments, and envelope are intentionally non-plaintext candidate material;
they are not substitutes for a durable evidence row.

## Integrity digest and mutability

A candidate object and its ordinary nested objects are frozen. Node.js
`Buffer`s, however, remain mutable even when their containing object is frozen.
The module therefore exposes `verifyPreparedEvidenceCandidateIntegrity()`.

`preparedCandidateDigest` is lower-case, unprefixed SHA-256 hex over a
versioned deterministic encoding:

- the fixed domain string `PONTE_PREPARED_EVIDENCE_CANDIDATE_V1` is first;
- every remaining candidate field is emitted in a fixed documented module
  order, including quote-route array order;
- each entry is encoded as big-endian `uint32(label byte length)`, UTF-8 label,
  big-endian `uint32(value byte length)`, and exact UTF-8 or Buffer value bytes;
- `preparedCandidateDigest` itself is excluded.

This makes labels, boundaries, binary fields, and variable lengths
unambiguous. It detects in-memory Buffer mutation or ordinary candidate-field
mutation before a future consumer uses it. It is a local integrity check, not
an on-chain commitment, authorization decision, or replacement for final
locked-row validation.

## Failure and secret-handling behavior

Errors cross this module through the fixed
`EvidenceCandidatePreparationError` taxonomy only:

- `INVALID_INPUT`
- `PROVIDER_FAILURE`
- `PROVIDER_RESULT_INVALID`
- `ENCRYPTION_FAILED`
- `PREPARATION_FAILED`

Raw provider exceptions, raw result data, encryption exceptions, private
payloads, salts, AAD/context bytes, and DEK bytes are neither logged nor placed
in the error messages.

A `finally` block best-effort overwrites the captured raw provider plaintext
DEK even when provider-result validation rejects it, plus the private payload,
salt, raw canonical AAD, and raw KMS context. Cleanup cannot replace the
original outcome. The implementation uses `Buffer.fill(0)` through the
existing best-effort DEK helper; Node.js cannot guarantee secure zeroization of
copies made by the runtime, garbage collector, native crypto implementation,
or a provider.

## Focused coverage

`tests/evidence/candidate-preparation.test.ts` uses an explicitly labelled
synthetic fake provider only. It exercises:

- valid candidate construction, frozen output, existing builder/hash agreement,
  reconstructed-AAD decryption with a synthetic DEK, and non-secret output;
- success-path cleanup and raw-DEK cleanup for every tested invalid
  provider-result shape;
- sanitized provider exceptions and provider-result failures, with captured
  console methods proving the module emits no raw exception, metadata, or
  sensitive input values;
- table-driven pre-provider rejection of adverse invoice/quote currencies and
  amounts, quote source/simulation/expiry/routes/economics, actor, registry,
  fingerprint, and malformed provider shapes, with a zero fake-provider call
  count for every case; and
- candidate-digest verification for each mutable binary field, malformed or
  incomplete candidate-like values, forged quote content, and independently
  inspected Buffer copies.

The existing evidence suite continues to execute the frozen commitment, AAD,
private-payload, KMS-context, and envelope golden vectors unchanged.

## Explicit non-goals and readiness

Phase 1.2.9 does **not** configure or contact a real KMS, authorize candidate
persistence, call this module from Routing or a normal request flow, insert an
evidence/outbox row, lock/revalidate final rows, change migrations, change
service/API/UI behavior, retry jobs, or submit anything to a chain.

A passing phase can only prepare a non-persisted encrypted candidate through
the injected provider contract. Evidence creation in the normal flow remains
not ready until a separately designed final transactional integration supplies
authorized locking, revalidation, persistence, and lifecycle behavior.
