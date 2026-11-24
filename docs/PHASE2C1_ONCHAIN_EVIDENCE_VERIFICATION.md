# Phase 2C.1 — Offline on-chain evidence verification

Status: **foundation only.** PONTE is **not** on-chain integrated, not deployed,
and holds no wallet. Nothing in this phase performs a network request, signs a
transaction, or claims that any evidence is anchored.

## 1. Why this boundary exists

The application must never present evidence as anchored merely because it was
prepared, persisted, or submitted. Before Phase 2C.1 there was no way to express
that distinction in code: the evidence status projection returned a hardcoded
`{ verified: false, status: "not_verified" }` and nothing could produce any other
value. That was honest but unenforceable — a future change could have started
reporting `confirmed` from an outbox row.

Phase 2C.1 makes the honest answer the _only_ answer the type system permits, and
makes the verified answer reachable only through a receipt that satisfies every
check below.

## 2. Verification pipeline

`src/server/evidence/anchor-verification.ts` is a pure module. It has no network
access, no database access, no clock, and no randomness. Given an
`ExpectedAnchorCommitment` (the persisted commitment) and a `ChainObservation`
(what a trusted reader saw), it returns either a verified result or a specific
failure.

Checks, in the order they are applied:

| #   | Check                                                               | Failure                             |
| --- | ------------------------------------------------------------------- | ----------------------------------- |
| 1   | An observation exists                                               | `NO_OBSERVATION`                    |
| 2   | Reader chain is exactly `421614` and equals the persisted chain     | `WRONG_CHAIN`                       |
| 3   | Registry identity probe succeeded                                   | `REGISTRY_IDENTITY_UNVERIFIED`      |
| 4   | A receipt exists                                                    | `RECEIPT_MISSING`                   |
| 5   | Receipt describes the requested transaction hash                    | `RECEIPT_TRANSACTION_MISMATCH`      |
| 6   | `receipt.status === success`                                        | `TRANSACTION_REVERTED`              |
| 7   | Receipt `to` **and** transaction `to` equal the configured Registry | `WRONG_REGISTRY_ADDRESS`            |
| 8   | Exactly one `EvidenceAnchored` log from the Registry                | `EVENT_MISSING` / `EVENT_AMBIGUOUS` |
| 9   | Log decodes cleanly                                                 | `EVENT_MALFORMED`                   |
| 10  | `evidenceId` matches                                                | `WRONG_EVIDENCE_ID`                 |
| 11  | `payloadHash` matches                                               | `WRONG_PAYLOAD_HASH`                |
| 12  | `kind` is `SimulatedRouteDecision` (1) and matches                  | `WRONG_EVIDENCE_KIND`               |
| 13  | `sequence` matches exactly                                          | `WRONG_SEQUENCE`                    |
| 14  | `previousPayloadHash` matches                                       | `WRONG_PREVIOUS_PAYLOAD_HASH`       |
| 15  | Event attestor equals transaction sender and receipt sender         | `ATTESTOR_NOT_EVENT_SENDER`         |
| 16  | Block number and block hash are well formed                         | `BLOCK_METADATA_INCONSISTENT`       |

Every field comparison is exact. Sequence and block number are compared as
canonical decimal **strings** parsed to `BigInt`, never as JavaScript numbers, so
`2^53 + 1` and the `uint64` maximum round-trip without loss. A non-canonical
input such as `"01"` or `"1e0"` is rejected rather than coerced.

### Attestor history

Check 15 compares the event's attestor to the account that actually sent the
transaction. It deliberately does **not** consult `isAttestor(address)`: an
attestor revoked after a valid historical transaction must not invalidate that
transaction, and a currently-authorized attestor must not be able to validate a
transaction it did not send.

Registry _identity_ is a separate concern, carried on the observation as
`registryIdentity`. It records that the configured address really is the expected
contract implementation. A `null` value means the probe did not run, and
verification then refuses to confirm — it never assumes identity.

## 3. Confirmed-state invariant

`evidence_outbox.submission_state = 'confirmed'` can only be written by
`confirmVerifiedAnchor` in `src/server/evidence/anchor-confirmation.ts`, which:

1. accepts a **verification result**, not a transaction hash and not a receipt;
2. refuses unless the result is `verified: true`;
3. refuses unless the row is currently `submitted` (so `pending → confirmed` and
   `retryable → confirmed` are both impossible);
4. refuses unless the persisted chain is `421614` and the verified chain and
   Registry address still match the persisted row;
5. writes `transaction_hash`, `confirmed_at`, `confirmed_block_number`,
   `confirmed_block_hash` and `attestor_address` in the _same_ `UPDATE`;
6. includes `AND submission_state = 'submitted'` and `AND transaction_hash = $2`
   in the `UPDATE` itself, so the state machine is enforced by the database and
   not only by the preceding `SELECT`. Repeated processing matches zero rows.

A pending or submitted row therefore cannot become confirmed because a caller
supplied a transaction hash. `verifyOutboxAgainstChain` also converts a reader
exception into an unverified outcome, so a transient RPC failure can never be
mistaken for success.

## 4. Presentation

`src/lib/models.ts` defines `EvidenceAnchoringStatus` as a discriminated union:
the `verified: false` branch has **no** transaction hash, block, or attestor
field at all. A non-verified record is structurally incapable of rendering
anchoring details. `invoiceEvidenceStatus` defaults to `NOT_VERIFIED` and never
reads the outbox state when deciding anchoring, so an operational `confirmed`
row does not by itself produce an anchored claim.

## 5. Runtime selection

`src/server/evidence/chain-reader-runtime.ts` resolves the reader. In this phase
it always returns `null`, because no implementation with network access exists.
There is no environment variable, feature flag, or test hook that can install a
fake reader into the running application. Fakes are constructed directly inside
tests and passed as arguments.

## 6. What this phase does not do

- No RPC endpoint is contacted.
- No wallet, key, or signature exists.
- No transaction is broadcast, and no contract is deployed or activated.
- No migration was added; the existing `evidence_outbox` columns were already
  sufficient.
- No financial calculation or simulated settlement behaviour changed.

## 7. Future wallet architecture (not implemented)

```
Operator                      Browser wallet                 Backend
   |                                |                            |
   |-- owns admin address           |                            |
   |   (Registry admin)             |                            |
   |                                |-- owns attestor address    |
   |                                |   signs anchor(...)        |
   |                                |---------------------------->| tx hash
   |                                |                            |
   |                                |            trusted chain reader
   |                                |            (receipt + tx + logs)
   |                                |                            |
   |                                |            verifyAnchorObservation
   |                                |                            |
   |                                |            confirmVerifiedAnchor
```

- The **administrator** address is operator-controlled and is used only for
  `setAttestor`, `proposeAdmin`, and `acceptAdmin`.
- The **attestor** address is controlled by a browser wallet. The Registry
  requires that admin and attestor differ, which the constructor enforces.
- The browser signs the Registry transaction. **No private key is ever sent to or
  held by the server.**
- The backend verifies the resulting transaction independently. It must never
  submit a transaction on its own initiative, and must never accept a
  client-supplied receipt as proof.

## 8. Phase 2C.2 prerequisites

1. Decide the settlement blocker recorded in the Phase 2C assessment: the
   `Routing` transition requires an evidence provider that is currently gated to
   development/test.
2. Implement `EvidenceChainReader` against a real Arbitrum Sepolia RPC, including
   the Registry identity probe, and add it to `resolveEvidenceChainReader` behind
   an explicit, reviewed configuration.
3. Deploy the Registry and record its address per environment; verification
   refuses to confirm when the address does not match.
4. Build the operator wallet flow and the browser signing path.
5. Add end-to-end evidence tests against a local Nitro devnet, not a public
   network.
