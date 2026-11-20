# Phase 1.2.11 — Non-Public Final Evidence Persistence

## Status and scope

This phase adds the internal, server-only final persistence primitive at
`src/server/evidence/persist-candidate.ts`. It consumes a completed
`PreparedEvidenceCandidate`; it does **not** prepare one and is intentionally
unreachable from the normal Routing path.

The implementation is deliberately limited to local PostgreSQL persistence of
synthetic simulation data. It does not add an API endpoint, service method,
route, UI/import barrel, provider implementation, KMS/cloud SDK call, wallet,
signer, RPC/chain operation, registry deployment, or migration.

The reviewed Phase 1.2.7, 1.2.8, 1.2.9, and Phase 1.2.10 material remains
unchanged. A full workspace search found no separately named Phase 1.2.8.1
document; this phase does not infer or fabricate one.

## Internal contract

`persistPreparedEvidenceCandidate(input, hooks?)` accepts independently
trusted, canonical request context:

- `businessId`
- `actorUserId`
- idempotency key
- lowercase SHA-256 request fingerprint
- an optional prepared candidate

A candidate is optional **only** for an authorized durable replay. A new
mutation requires it. The helper returns either `persisted` or `replay` plus
the existing persisted invoice JSON response contract. It exposes fixed
`EvidencePersistenceError` codes/messages and never includes candidate bytes,
envelope bytes, KMS values, or database/provider error text in that boundary.
The optional hook exists only for local rollback-boundary tests and receives
only a fixed write-step name.

This module begins with `import "server-only"`. Static isolation coverage
checks that `service.ts`, the app route surface, and client services do not
import the helper. The helper itself does not import a `DekProvider`,
a preparation routine, or plaintext-DEK validation.

## Authoritative transaction

`transactionWithCommitOutcome` is an additive evidence-only transaction wrapper
in `src/server/repository.ts`; the pre-existing generic `transaction` remains
unchanged for normal Routing/API behavior. The final persistence sequence is:

1. begin one PostgreSQL transaction;
2. take the existing business/key transaction advisory lock;
3. inspect the durable idempotency row;
4. on an existing matching key/fingerprint, lock and reauthorize the active
   non-viewer membership before disclosing its stored response; a changed
   fingerprint is an idempotency conflict;
5. for a new mutation, lock and reauthorize that membership with `FOR UPDATE`;
6. copy all mutable candidate buffers and nested quote/hash data into
   persistence-owned values, then verify the copied candidate digest;
7. lock the invoice first, then lock the exact quote. The quote helper uses
   `expires_at > clock_timestamp()` in the final `FOR UPDATE` query, so quote
   validity is determined only at that lock query;
8. compare the copied candidate with final authoritative rows, including the
   frozen simulated quote commitment, selected route/code, AAD/wrapping-context
   bindings, envelope structure, and metadata;
9. verify the copied candidate digest again immediately before the first
   insert, then insert settlement, immutable evidence, and pending outbox;
10. save invoice state as `Routing`, append the existing `invoice.Routing`
    event shape, save the idempotency response, and commit once.

The candidate digest is only an in-memory mutation detector. It is never
persisted. The final path does not recreate a private payload or salt and never
decrypts or logs evidence. It builds only public canonical AAD/wrapping-context
bytes to verify their candidate digests, then clears those temporary buffers
best-effort; it never obtains a plaintext DEK.

`assertDekWrappingMetadata` is the narrow metadata-only KMS validator used in
this path. It validates the reviewed provider/algorithm/format tuple and
non-secret key identifiers but accepts no plaintext DEK and makes no provider
call. The older `assertDekProviderResult` remains the preparation-boundary
validator and is not used in final persistence.

## Commit acknowledgement handling

This path distinguishes outcomes after `COMMIT` is issued:

- an acknowledged `COMMIT` returns the persisted result;
- a definitive PostgreSQL rejection (a non-connection SQLSTATE) rolls back and
  propagates to the fixed persistence failure boundary;
- a connection/protocol/transport loss, including a no-SQLSTATE failure, is
  ambiguous. The client is destroyed without a speculative rollback and the
  caller receives `COMMIT_OUTCOME_UNKNOWN`.

A caller must not infer a failed mutation from `COMMIT_OUTCOME_UNKNOWN`.
Recovery is restricted to retrying the same business/key/fingerprint: the
advisory lock and durable idempotency row then produce an authorized replay if
the server committed. A different fingerprint conflicts.

## Local test coverage

The unit and isolated local-PostgreSQL tests cover:

- metadata-only KMS validation without a plaintext DEK;
- acknowledged, definitively rejected, and simulated lost-acknowledgement
  commits, including destruction of the uncertain client;
- copied-candidate integrity rejection and sanitized errors;
- final locked-row revalidation, actual PostgreSQL quote expiry, and the
  frozen synthetic split settlement vector (`473904` expected /
  `471534` minimum) with no transaction hash;
- active-membership locking, revocation/viewer denial, and replay
  reauthorization;
- same-key races, candidate-free replay, and changed-fingerprint conflicts;
- atomic rollback after each write boundary (settlement, evidence, outbox,
  invoice, event, idempotency);
- pending outbox insertion, immutable evidence insertion, `Routing` invoice
  update, event shape, response storage, and absence of a persisted candidate
  digest;
- source/import isolation from normal Routing/API/client code.

Run the local database before the PostgreSQL suite, then use:

```sh
npm run db:local
npm run db:migrate
npm run db:seed
npm run test:evidence
npm run test:backend
```

`test:backend` now uses Node's `react-server` condition because the new
server-only persistence test imports the existing server-only evidence
candidate modules.

## Schema boundary retained

No migration is part of Phase 1.2.11. The database still does **not** globally
require an outbox for every evidence row, does not require evidence/outbox for
every `Routing` invoice, has no settlement-to-evidence foreign key, has no
business-scoped creator-membership foreign key, and does not independently
validate canonical quote economics or the in-memory candidate digest. This
helper establishes its own transactional write sequence and final comparison;
it does not claim those broader database invariants.
