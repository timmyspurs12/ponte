# Phase 2C.2A — Trusted Arbitrum Sepolia Reader and Finality Foundation

Status: **read-only implementation, no live anchoring available.**
The Registry is **not deployed**. No production reader is active. No RPC endpoint is
contacted by this repository's code or tests. No wallet, key, signature, transaction,
USDG integration or settlement change exists in this phase.

This document records what was built, what it genuinely guarantees, and — more
importantly — what it does not.

---

## 1. The defect this phase closes

Phase 2C.1 could mint a `confirmation-authorizing` proof from a **caller-supplied**
`ChainObservation`. The evaluator checked that observation thoroughly, but nothing
established where it came from. A caller who fabricated an observation, and declared
`registryIdentity: "verified"`, could obtain a proof. That was documented honestly in
Phase 2C.1 as a limitation, and it was the single largest security gap in the evidence
pipeline.

Phase 2C.2A separates three concerns that were previously one:

| Concern           | Module                                   | Input                     | Output                      |
| ----------------- | ---------------------------------------- | ------------------------- | --------------------------- |
| **Evaluation**    | `anchor-verification.ts`                 | commitment + observation  | `AnchorEvaluationProof`     |
| **Acquisition**   | `trusted-reader.ts`                      | transaction hash + config | `TrustedReaderResult`       |
| **Authorization** | `trusted-pipeline.ts`, `trusted-seal.ts` | evaluation + acquisition  | `TrustedAnchorVerification` |

A confirmation now requires the third. Synthetic data still reaches the evaluator —
that is what makes the evaluator testable — but it can never become a
`TrustedAnchorVerification`, so it can never confirm.

### Renames that carry the semantics

- `verifyAnchorObservation` → `evaluateAnchorObservation`
- `AnchorVerificationProof` → `AnchorEvaluationProof`
- `AnchorVerificationResult` → `AnchorEvaluationResult`
- `isAnchorVerificationProof` → `isAnchorEvaluationProof`

These are not cosmetic. The old names implied that running the pure function produced
something authoritative. It does not: it produces an _evaluation_. The authoritative
object is `TrustedAnchorVerification`, and only the pipeline can issue it.

---

## 2. Runtime-enforced branding (not types alone)

Two independent brands, both enforced at runtime:

**The evaluation brand.** `AnchorEvaluationProof` carries an ECMAScript private field
(`#brands`) and is registered in a module-private `WeakSet` (`ISSUED_PROOFS`). Only
`AnchorEvaluationProof.create` adds to that set. `isAnchorEvaluationProof` requires
`instanceof`, presence in the set, and `owns(value)` — so a spread copy,
`structuredClone`, JSON round-trip, `Object.create(prototype)` or a hand-built object
with the right shape are all rejected.

**The provenance seal.** `TrustedObservedAnchor` is a class instance with a private
`#token` compared against a module-private symbol, registered in a separate
`SEALED` WeakSet, and the instance is frozen. `isTrustedObservedAnchor` requires
`instanceof`, WeakSet membership and token equality.

**The combined result.** `TrustedAnchorVerification` is an ordinary frozen object
registered in `TRUSTED_RESULTS`. `isTrustedAnchorVerification` checks that registry
membership _and_ re-validates both the proof and the seal. Forging it requires
producing a genuine evaluation proof and a genuine seal, which requires the pipeline.

TypeScript types are a developer aid here, not the security boundary. Every check
above survives `as never` casts and is exercised that way in the test suite.

---

## 3. How the reader obtains observations

`TrustedEvidenceChainReader` is constructed only from a validated
`TrustedReaderConfig`. It performs, in order:

1. **`eth_chainId`** must decode to exactly `421614`. No other chain is accepted.
2. **`eth_getCode`** at the **`finalized`** tag must be non-empty, must be valid hex,
   and must **not** begin with `0xef0100` (the EIP-7702 delegation designator — such an
   account delegates every call elsewhere and is not our Registry).
3. **Keccak-256** of that bytecode must equal the operator-pinned
   `runtimeBytecodeHash`. This hash is computed locally by `ethers`; it never comes
   from the RPC.
4. **Positive control**: `eth_call` of `admin()` (selector `0xf851a440`) at the same
   `finalized` block must return exactly 32 bytes decoding to a valid, nonzero address,
   and that address must equal the manifest's pinned `administrator`. A revert, empty
   return or truncated return is rejected.
5. The **persisted commitment's** Registry address must equal the configured one. A
   reader cannot be redirected at another contract by its caller; this check happens
   before any network call.
6. **`eth_getTransactionByHash`**: hash must match, sender and destination must parse,
   destination must be the pinned Registry.
7. **`eth_getTransactionReceipt`**: hash must match the request, `to` must be the pinned
   Registry, `status` must be `0x0`/`0x1` (anything else is malformed), logs must be an
   array, and every log address/topic must be canonical.
8. **`eth_getBlockByNumber(receipt.blockNumber)`** must return a block whose `number`
   and `hash` match the receipt's block metadata exactly.
9. **`eth_getBlockByNumber("finalized")`** yields the finalized head; the receipt block
   number must be **≤** it.
10. The receipt block is **re-read after** the finality query and its canonical hash
    must be unchanged.
11. `registryIdentity: "verified"` is set **by the reader**, from the checks above. It
    is not a parameter of any function in the reader.

Every numeric value is a canonical decimal string or a `bigint`. No block number,
sequence or timeout is ever held in a JavaScript `number` on the verification path.

### Why the reader is not "trustless"

The reader trusts the endpoint to answer honestly. It does **not** verify receipt
inclusion, a Merkle path, a state root, or any chain-level commitment, and it is not a
light client. "Finalized" is the endpoint's assertion about Arbitrum's parent-chain
finality. Pinning the bytecode hash and the Registry address removes the _caller_ from
the trust path; it does not remove the _endpoint_. A compromised RPC that answers
consistently can still lie, and this design cannot detect that.

---

## 4. Registry identity

Identity is established from **four independent sources** that must agree:

| Fact             | Source                                      |
| ---------------- | ------------------------------------------- |
| Chain            | `eth_chainId` (RPC) vs. pinned constant     |
| Address          | Operator manifest only                      |
| Runtime bytecode | Keccak of `eth_getCode` vs. pinned manifest |
| Administrator    | `admin()` result vs. pinned manifest        |

The expected runtime hash comes **only** from the operator-pinned manifest, which is
derived from a reviewed build artifact. It is never taken from a hash the same RPC
returned — that would make the comparison circular and worthless.

`admin()` as a positive control catches a contract whose bytecode hashes correctly but
which is not answering as our Registry (for example, code replaced at the same address
in a way that preserves the hash is impossible, but a self-destructed or
not-yet-deployed account returning empty data is not).

### Manifest handling: a deliberate, documented duplication

`contracts/tools/registry-deployment-manifest.mjs` is the authoritative manifest
validator. **This phase does not import it into the runtime**, because that module:

- imports `node:fs` and `node:path` at module scope;
- ends with a `if (import.meta.url === ...) main()` CLI entry point;
- transitively pulls in `registry-build-identity.mjs`, which reads foundry artefacts
  from disk.

Importing it from `src/` would drag build-only tooling and a CLI into the Next.js
server bundle and make module loading depend on filesystem layout.

Instead, `trusted-reader-config.ts` revalidates the **same fields with the same
constants**, imported from `registry-deployment-constants.mjs` — 19 lines of pure
frozen values, safe for runtime. The canonical manifest remains the artefact of record
and is still validated by the existing tooling. To prevent silent drift,
`tests/evidence/trusted-reader-config.test.ts` **cross-checks both validators on the
same inputs**, asserting that they agree on valid manifests and both reject the same
tampered ones (compiler mismatch, runtime-hash inconsistency, chain mismatch).

This is a duplication of assertions, not of format, and it is the only acceptable
option short of refactoring the build tooling — which would exceed this phase's scope.

---

## 5. Finality

Arbitrum exposes three block tags. This phase uses exactly one of them for
confirmation eligibility:

| Tag         | Meaning                | Sufficient? |
| ----------- | ---------------------- | ----------- |
| `latest`    | Soft confirmation (L2) | **No**      |
| `safe`      | Parent-chain safe head | **No**      |
| `finalized` | Parent-chain finalized | **Yes**     |

Reference: `https://developer.arbitrum.io/how-arbitrum-works/reference/finality-and-reorgs`

The reader queries `finalized` and requires `receiptBlockNumber <= finalizedBlockNumber`.
It records `level: "finalized"`, `finalizedBlockNumber`, `finalizedBlockHash`,
`receiptBlockNumber` and `receiptBlockHash` in the `FinalityEvidence` carried by the
seal, so a logged or persisted result can never be retroactively mistaken for a
weaker observation.

**No substitution is permitted.** A fixed L2 confirmation count is not equivalent to
parent-chain finality and is not accepted. The reader never queries `latest` or `safe`
for a bounded decision, and the test suite asserts that neither tag appears in the
issued call sequence.

### If finality is unavailable

If the endpoint errors on the `finalized` tag (the common case for providers without
Arbitrum support), returns malformed data, or returns `null`, the result is
`FINALITY_UNAVAILABLE` / `FINALITY_MALFORMED`. There is **no fallback** to `latest`,
`safe`, or a confirmation count. Evidence becomes ineligible, which is the intended
fail-closed behaviour.

---

## 6. Reorganisation handling

Two independent checks bracket the finality query:

1. **Before**: the receipt's `blockHash` and `blockNumber` must match the block
   fetched by number. A receipt referring to a block the node does not have is
   rejected.
2. **After**: the same block is re-read and its canonical hash must be **unchanged**.
   A hash change means the block was reorged out between the two reads
   (`RECEIPT_BLOCK_CHANGED_DURING_FINALITY_CHECK`), and a missing block is treated the
   same way.

This catches an inconsistent node that serves a stale receipt and a reorged block, and
it catches an RPC that answers differently to the same query inside one verification.

### Residual risk, stated honestly

**An exceptionally deep reorganisation that reverts an already-finalized Arbitrum
block is not prevented by this design, and cannot be.** "Finalized" substantially
reduces the probability of reversal; it does not make it mathematically impossible. A
parent-chain reorganisation deeper than the finality boundary would invalidate a
confirmation performed on a now-orphaned block, and this code would not detect it
after the fact because nothing re-checks persisted confirmations.

This is a monitoring and reconciliation problem, not something a single verification
can solve. Any future claim that a confirmed record is irreversible would be false.

---

## 7. Read-only transport

`rpc-read-only-transport.ts` is the only network client in the evidence path.

**Method allowlist** — six methods, with fixed arity:

```
eth_chainId                (0 args)
eth_getTransactionByHash   (1)
eth_getTransactionReceipt  (1)
eth_getBlockByNumber       (2)
eth_getCode                (2)
eth_call                   (2)
```

Everything else is rejected **locally, before a socket is opened**: `eth_sendTransaction`,
`eth_sendRawTransaction`, `eth_sign`, `personal_sign`, `eth_accounts`,
`wallet_switchEthereumChain`, `eth_estimateGas`, `debug_*`, `admin_*`, and unknown
methods. The rejection is by exact lookup in a frozen object, so `__proto__` and
`constructor` do not resolve to a handler.

**Envelope validation** — HTTP status, content type, JSON parse, `jsonrpc === "2.0"`,
`id` echo equality, absence of an `error` member, and presence of `result`. A mismatched
id is an error, never a silent accept.

**Other properties** — bounded `AbortSignal` timeout (100 ms–30 s, validated at
construction), `redirect: "error"` so a 3xx cannot forward the request elsewhere,
`credentials: "omit"` so ambient cookies are never attached, and URL validation that
rejects non-HTTP(S) schemes and embedded credentials.

---

## 8. Why no production reader is active

`resolveEvidenceChainReader()` returns **`null`**, and `resolveTrustedEvidenceReader()`
returns `null` when no pinned configuration is supplied.

No real Registry deployment manifest exists. Enabling the reader would require
inventing a Registry address and a runtime bytecode hash — and a reader built from
placeholders would cheerfully "verify" whatever an operator pointed it at while
appearing configured. That is strictly worse than being disabled.

There is **no** environment variable, feature flag or test hook that can enable it.
The tests assert this directly, including that setting plausible
`PONTE_*RPC*`/`PONTE_*REGISTRY*` variables leaves the resolver `null`. Fakes live only
under `tests/` and construct the production class against a loopback mock endpoint.

When a reviewed manifest exists, it is supplied in exactly one place
(`chain-reader-runtime.ts`) and nothing else needs to change.

---

## 9. Database role and provenance gap — **not solved**

Phase 2C.1 established that the schema does not enforce the confirmed-state invariant.
This phase assessed whether the _role model_ constrains it. It does not, in this
environment.

Measured, not assumed (local development database):

| Question                          | Answer                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| Role used by the application      | `ponte` (from `DATABASE_URL`)                                   |
| Is that role a superuser?         | **Yes** — `rolsuper = true`                                     |
| Can it create roles?              | Yes — `rolcreaterole = true`                                    |
| Does it bypass RLS?               | Yes — `rolbypassrls = true`                                     |
| Does it own `evidence_outbox`?    | **Yes** — `tableowner = ponte`                                  |
| Does it own the database?         | Yes                                                             |
| Table privileges                  | `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES` |
| Row-level security                | Disabled (`relrowsecurity = false`)                             |
| Existing `SECURITY DEFINER` funcs | None                                                            |

**Consequence:** the application role can directly set
`submission_state = 'confirmed'` on any row, with or without confirmation metadata, and
can `TRUNCATE` the table. The confirmation boundary is an application-level property
only. Nothing in the database prevents a second writer, a migration, or an operator
with these credentials from doing the same.

### What a fix would require (design recommendation for 2C.2B, not implemented)

Two mechanisms are plausible, and they address different parts of the gap:

1. **Role separation.** Create a `ponte_app` role with `SELECT`/`INSERT` only on
   `evidence_outbox`, and a `ponte_confirmer` role holding `UPDATE (submission_state,
transaction_hash, confirmed_at, confirmed_block_number, confirmed_block_hash,
attestor_address, last_failure_class, last_failure_at)` — column-level grants so a
   confirmer cannot rewrite evidence pointers. The application's ordinary request path
   would use `ponte_app`; only the confirmation code path would hold `ponte_confirmer`
   credentials.
2. **A narrowing `UPDATE` policy plus a write-audit table.** A trigger that records
   `current_user`, the statement and the row state at each transition would at least
   make a divergent write _detectable_, which the current schema cannot do at all.

Even together these do not establish provenance of the _verification_, only of the
_write_. Combined with the seal from §2 they would close the loop: the database would
know that _some_ confirmer wrote the row, and the application would know the write came
from the trusted pipeline.

**Explicitly not done in this phase**, because none of it can be validated here:

- No role separation, no `SECURITY DEFINER` function, no migration was introduced.
- The production privilege model is **unknown**. Establishing it requires a real hosted
  database (Neon production branch or equivalent) where the actual role, ownership and
  grants can be inspected. A local embedded Postgres created by
  `scripts/local-postgres.ts` makes its user a superuser and owner by construction, so
  it tells us nothing about production.
- Therefore the provenance gap **remains open**, and this phase does not claim
  otherwise.

---

## 10. What this phase does not do

- No Registry deployment, activation, or interaction.
- No RPC request to any public endpoint, in code or in tests.
- No wallet, private key, signature or transaction.
- No USDG, transfer, or token integration.
- No KMS change and no plaintext fallback.
- No automatic outbox submitter.
- No change to financial calculation, Pix, routing, or settlement behaviour.
- No migration, schema change, or database role change.
- No claim that PONTE is on-chain integrated or deployed.

---

## 11. Residual limitations

1. **The endpoint is trusted.** Not a light client; no inclusion or commitment proofs.
2. **No reorg monitoring after confirmation.** A deep finalized reorganisation would
   invalidate a confirmation silently.
3. **The database provenance gap is open** (§9). A direct writer can forge `confirmed`.
4. **The runtime re-implements manifest assertions** rather than importing the canonical
   validator (§4), kept honest by a cross-check test but still a second implementation.
5. **No production reader.** Nothing can produce a live anchoring claim.
6. **`registryIdentity` is derived by the reader**, but the reader itself is only as
   trustworthy as its endpoint and its pinned manifest.
7. **No key rotation story** for a future manifest update: rotating the pinned bytecode
   hash requires a reviewed artefact and a code change.
