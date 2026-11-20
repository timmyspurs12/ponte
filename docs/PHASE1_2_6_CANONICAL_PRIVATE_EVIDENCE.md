# PONTE Phase 1.2.6 — Canonical private evidence plaintext and AAD

**Status:** server-only serialization primitives and synthetic test vectors only.
This phase does not create or contact a KMS, add an SDK or credential, generate
or persist evidence, change a migration, enter the Routing/service/API/worker
flow, expose a public payload, perform a wallet/RPC action, or change a
registry/Solidity/Foundry/deployment artifact.

The implementation is deliberately split into two pure server-only modules:

- `src/server/evidence/aad.ts` defines the AES-GCM record binding and the
  separate KMS wrapping context; and
- `src/server/evidence/private-payload.ts` defines the one allowed private V1
  UTF-8 plaintext representation.

Neither module logs input, plaintext, raw AAD, wrapping-context bytes, salts,
keys, or derived preimages. Both are marked `server-only`.

## 1. Canonical AES-GCM AAD V1

`buildCanonicalPrivateEvidenceAad` returns the exact `Buffer` represented by
this pinned `ethers` `AbiCoder.defaultAbiCoder()` expression. It does **not**
use JSON, concatenation, delimiters, a string encoding, or PII/free-form invoice
content.

```text
abi.encode(
  bytes32 domainHash("PONTE_PRIVATE_ROUTE_EVIDENCE_V1"),
  uint16  1,
  bytes16 evidenceRecordId,
  bytes16 businessId,
  bytes16 invoiceId,
  bytes16 quoteId,
  bytes32 publicEvidenceId,
  uint16  1,
  uint256 421614,
  address registryAddress
)
```

The field order above is immutable for V1. The domain hash is:

```text
0x436d7077df329e5122318408d5ed7aa7e667e8e28093cc933a9e63f6097f25df
```

All fields are static ABI words, so V1 AAD is exactly 320 bytes. UUIDs are
supplied as canonical hyphenated UUID text and encode as their 16 hexadecimal
bytes (without hyphens). The helper accepts uppercase hex in UUID/`bytes32`
inputs only to normalize it; emitted UUIDs and `bytes32` values are lowercase.
It rejects malformed UUID text, all-zero UUIDs, an all-zero public evidence ID,
wrong byte widths, wrong AAD/evidence-schema versions, any chain other than
Arbitrum Sepolia `421614`, zero/invalid registry addresses, and unknown AAD
input keys.

The one address representation used outside ABI is lowercase, `0x`-prefixed,
40-hex-character text. The helper validates with `ethers.getAddress` first and
then lowercases it. This has the same ABI address value as the frozen commitment
helper's checksum representation; it changes no commitment preimage.

## 2. Separate KMS wrapping context V1

`buildKmsWrappingContext(canonicalAad)` only accepts a validated, canonical
320-byte AAD V1 `Buffer`. It returns this exact 96-byte ABI encoding:

```text
abi.encode(
  bytes32 domainHash("PONTE_KMS_DEK_WRAP_CONTEXT_V1"),
  uint16  1,
  bytes32 keccak256(canonicalAad)
)
```

Its domain hash is:

```text
0xc993df0de465310923dc7d254e80cc9baedf8429461ac1cb3dfe5f224d5a4e37
```

The result is directly compatible with the existing
`DekWrappingContext.canonicalContext: Buffer` contract. It contains neither raw
AAD/UUID/address fields nor private plaintext/salt. It also performs no provider
operation.

A future provider adapter, which this phase does not implement, must map only
this binding's version and digest:

- **GCP Cloud KMS:** pass these canonical-context bytes as
  `additionalAuthenticatedData`. The dynamic information in those bytes is the
  V1 context version and `keccak256(canonicalAad)`; the domain word is the fixed
  protocol discriminator.
- **AWS KMS:** use an `EncryptionContext` with exactly a version string and a
  lowercase `0x` AAD-digest string, for example
  `PONTE_KMS_CONTEXT_VERSION = "1"` and
  `PONTE_CANONICAL_AAD_KECCAK256 = "0x…"`.

Neither mapping may contain a raw UUID, address, evidence ID, raw AAD, payload,
salt, or other private field. This is documentation of a future adapter boundary
only; it does not select AWS or GCP or add either SDK/call.

## 3. Canonical private plaintext V1

`buildCanonicalPrivateEvidencePayload` returns deterministic UTF-8 bytes for
schema `ponte-private-route-decision-evidence/v1`. JavaScript property insertion
order is intentional and fixed. The root order is:

```text
schema
aadVersion
record
invoice
quote
decision
privateCommitmentInputs
derivedCommitments
```

Nested property order is likewise part of V1:

```text
record:
  evidenceRecordId, businessId, invoiceId, quoteId, publicEvidenceId,
  evidenceSchemaVersion, quoteSchemaVersion, chainId, registryAddress,
  sequence, evidenceKind, previousPayloadHash
invoice:
  fundingCurrency, fundingMinor
quote:
  source, persistedSimulated, expiresAtUnixMs, data
data:
  simulated, asset, demoAssetDecimals, fundingMinor, rate,
  executionCostMinor, routes
rate:
  numerator, denominator
route (each, exactly direct / split / multi):
  id, code, feeBps, slippageBps, toleranceBps, feeMinor, outputMinor,
  minimumOutputMinor
decision:
  selectedRouteId, selectedRouteCode
privateCommitmentInputs:
  salt
derivedCommitments:
  routeHashes, routesHash, quoteSnapshotHash, payloadHash
routeHashes:
  direct, split, multi
```

Every integer in the plaintext is a canonical unsigned base-10 string, including
versions, chain ID, sequence, kind, route code, BPS, minor amounts, and expiry
milliseconds. Hashes are lowercase `0x` exact-`bytes32` strings. UUIDs and the
registry address use the normalized forms above. The two required simulation
markers are JSON literal `true`, not strings.

### Inputs, validation, and derivation

The builder accepts only its documented top-level fields and takes individually
selected nested fields only; it never stringifies an application/database object
wholesale. It validates all of the following before serializing:

- AAD binding: four nonzero UUIDs, public evidence ID, evidence schema, chain,
  registry, and AAD version; plus payload schema V1 and quote schema V1.
- Genesis-only V1 evidence: `sequence == "1"`, `evidenceKind == "1"`, and
  `previousPayloadHash` exactly zero. V1 does not reinterpret or extend the
  frozen evidence-chain sequence semantics.
- Invoice and persisted quote sources: BRL funding amount; exact equality with
  `quoteRow.data.fundingMinor`; row `source == "simulation-fixed-525"`; row
  `simulated == true`; persisted `expires_at` represented exactly as a uint64
  Unix-millisecond value; and quote-data `simulated == true`, asset `USDG`,
  demo decimals `2`, rate `525/100`, and execution cost `2`.
- Routes: exactly three candidates in `direct`, `split`, `multi` order with
  route codes `1`, `2`, `3`, respectively; bounded unsigned route fields; and a
  selected route ID whose emitted code is the frozen code for that ID.
- Private commitment input: a nonzero exact-`bytes32` salt.

`PaymentQuote` intentionally has no `source` property. The builder reads source,
persisted simulation status, and expiry only from `PersistedQuoteRow`; quote
fields only from `PersistedQuoteRow.data`. It does not invent, coerce, round, or
replace a mismatched bound value.

The builder passes the normalized values to the existing
`buildRouteDecisionCommitment()` helper and serializes its recomputed direct,
split, multi, routes, quote-snapshot, and payload hashes. It does not reproduce
or alter the frozen Solidity ABI encoding. An optional supplied expected hash
set is merely compared against the recomputation and is never trusted as a
source of derived values.

### Deliberate exclusions

The plaintext contains no invoice reference, supplier/customer identity, wallet,
description, payment/settlement receipt, route display name, email, free-form
metadata, key material, DEK, nonce, tag, wrapped-DEK bytes, KMS key reference,
or raw AAD. Such object properties are neither relied on nor serialized. JSON
is a private transport plaintext only: its bytes **never** become a Solidity
commitment hash input.

## 4. Synthetic golden vector

All values below are synthetic test-only values. In particular the `aa…aa` salt
is not generated, persisted, operational, or a production secret. The complete
byte-for-byte assertions live in
`tests/evidence/private-evidence.test.ts` as `GOLDEN_AAD_HEX`,
`GOLDEN_KMS_CONTEXT_HEX`, and `GOLDEN_PAYLOAD_JSON`.

| Input                 | Synthetic value                                                      |
| --------------------- | -------------------------------------------------------------------- |
| evidence record UUID  | `11111111-1111-4111-8111-111111111111`                               |
| business UUID         | `22222222-2222-4222-8222-222222222222`                               |
| invoice UUID          | `33333333-3333-4333-8333-333333333333`                               |
| quote UUID            | `44444444-4444-4444-8444-444444444444`                               |
| public evidence ID    | `0x` + 31 zero bytes + `01`                                          |
| registry              | `0x1111111111111111111111111111111111111111`                         |
| funding minor         | `2500000`                                                            |
| persisted expiry (ms) | `1803859140000`                                                      |
| selected route        | `direct`                                                             |
| predecessor           | zero `bytes32`                                                       |
| salt                  | `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |

Exact output bytes and digests:

```text
AAD hex:
0x436d7077df329e5122318408d5ed7aa7e667e8e28093cc933a9e63f6097f25df00000000000000000000000000000000000000000000000000000000000000011111111111114111811111111111111100000000000000000000000000000000222222222222422282222222222222220000000000000000000000000000000033333333333343338333333333333333000000000000000000000000000000004444444444444444844444444444444400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000066eee0000000000000000000000001111111111111111111111111111111111111111
AAD keccak256:
0xc137351e5142bbda198ae132f7114877bcb8e3429d406736f076f7adc942e7a0

KMS context hex:
0xc993df0de465310923dc7d254e80cc9baedf8429461ac1cb3dfe5f224d5a4e370000000000000000000000000000000000000000000000000000000000000001c137351e5142bbda198ae132f7114877bcb8e3429d406736f076f7adc942e7a0
KMS context keccak256:
0x6537d2ce395619e3697262d7bf54c54bda33985a2fdad660ff0ae3bea8f9b7af

Payload bytes: exact UTF-8 bytes of GOLDEN_PAYLOAD_JSON (2,117 bytes)
Payload keccak256:
0x890933213ea0022af3e0f0135c1f65ff20963926535ccad3f745ac869c8611ce
```

The golden test also asserts the complete JSON byte string and the frozen
commitment values:

```text
direct route hash: 0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5
split route hash:  0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8
multi route hash:  0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee
routes hash:       0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c
quote snapshot:    0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74
payload hash:      0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c
```

## 5. Future verifier and caller requirements

A future verifier must require exact V1 schema/property order and UTF-8 bytes,
reject duplicate/unknown/missing fields before interpreting JSON, rebuild AAD
from the normalized record binding, check the wrapping-context digest if KMS
wrapping is used, validate every fixed quote/genesis value, and recompute the
frozen commitment hashes through their ABI definitions. It must not treat a JSON
digest as an onchain commitment.

A future caller owns production evidence IDs, salts, plaintext buffers, and
DEKs. These helpers generate none of them and keep no module/global copies.
Callers must perform the existing AES-256-GCM content encryption with a 32-byte
DEK, fresh 12-byte nonce, 16-byte tag, and the canonical AAD. After their work,
callers are responsible for best-effort clearing temporary caller-owned buffers.
`Buffer.fill(0)` is not a guaranteed Node.js secure-zeroization promise: copies,
GC, runtime, and native crypto memory are outside that guarantee.

No frozen commitment domain, commitment preimage, registry ABI, chain target,
evidence kind, or evidence sequence semantics changes in this phase.
