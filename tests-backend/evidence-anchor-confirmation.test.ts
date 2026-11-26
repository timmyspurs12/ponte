import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, id as keccakId, toBeHex, zeroPadValue } from "ethers";
import { pool, transaction } from "../src/server/repository";
import { quote } from "../src/lib/quotes";
import {
  KMS_PROVIDER,
  WRAPPED_DEK_ALGORITHM,
  WRAPPED_DEK_FORMAT,
} from "../src/server/evidence/kms";
import {
  confirmVerifiedAnchor,
  readConfirmableOutboxRow,
  verifyOutboxAgainstChain,
} from "../src/server/evidence/anchor-confirmation";
import {
  isAnchorEvaluationProof,
  evaluateAnchorObservation,
  type AnchorEvaluationProof,
  type AnchorEvaluationResult,
} from "../src/server/evidence/anchor-verification";
import type {
  ChainObservation,
  EvidenceChainReader,
} from "../src/server/evidence/anchor-verification";
import { isTrustedAnchorVerification } from "../src/server/evidence/trusted-authorization";
import {
  startAnchorWorld,
  type AnchorWorld,
} from "./helpers/trusted-verification";
import { hex32 } from "../tests/evidence/helpers/mock-rpc-server";
import { fixtures, fixturesRead } from "./helpers/fixtures";

/**
 * Confirmed-state invariant tests, Phase 2C.2A.
 *
 * These use a real local PostgreSQL database, exactly like the other backend
 * integration tests. The chain side is an in-process mock JSON-RPC endpoint that
 * the **production** reader class talks to over a real socket — no public endpoint
 * is contacted and no transaction is broadcast.
 *
 * The important change from Phase 2C.1: a bare evaluation proof is no longer
 * sufficient to confirm. Every positive case below obtains its result from
 * `runTrustedVerification`, and the negative cases prove that a genuine-looking
 * evaluation proof is refused.
 */

/** Narrows a pipeline result to a proof, failing loudly when it is not one. */
function asProof(result: AnchorEvaluationResult): AnchorEvaluationProof {
  assert.ok(
    isAnchorEvaluationProof(result),
    "expected a real evaluation proof",
  );
  return result;
}

const REGISTRY = "0x1111111111111111111111111111111111111111";
const ATTESTOR = "0x3333333333333333333333333333333333333333";
const ADMIN = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"cc".repeat(32)}`;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
const BLOCK_NUMBER = 9876543;
const TOPIC = keccakId(
  "EvidenceAnchored(bytes32,bytes32,address,uint64,uint8,bytes32)",
);

interface Seeded {
  evidenceId: string;
  outboxId: string;
  publicEvidenceId: Buffer;
  payloadHash: Buffer;
  previousPayloadHash: Buffer;
  registryAddress: Buffer;
}

function bytes32(value: number) {
  return Buffer.alloc(32, value);
}

async function seedOutbox(): Promise<Seeded> {
  const businessId = randomUUID();
  const userId = randomUUID();
  const invoiceId = randomUUID();
  const quoteId = randomUUID();
  const evidenceId = randomUUID();
  const outboxId = randomUUID();
  const fundingMinor = "2500001";
  const invoice = {
    id: invoiceId,
    reference: `ANCHOR-${invoiceId}`,
    supplier: "Anchor invariant test supplier",
    wallet: `0x${"b".repeat(40)}`,
    amount: 25000.01,
    fundingMinor,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: "2027-12-20",
    description: "Synthetic anchor invariant test only",
    status: "Funded",
    created: "2026-11-16",
    quote: quote({ fundingMinor }),
  };
  const publicEvidenceId = randomBytes(32);
  const payloadHash = bytes32(0xbb);
  const previousPayloadHash = Buffer.alloc(32);
  const registryAddress = Buffer.from(REGISTRY.slice(2), "hex");

  await fixtures("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Anchor invariant test business",
  ]);
  await fixtures("INSERT INTO users(id,email) VALUES($1,$2)", [
    userId,
    `${userId}@example.invalid`,
  ]);
  await fixtures(
    "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [businessId, userId],
  );
  await pool.query(
    "INSERT INTO invoices(id,business_id,reference,funding_minor,status,data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invoiceId,
      businessId,
      invoice.reference,
      fundingMinor,
      invoice.status,
      JSON.stringify(invoice),
    ],
  );
  await pool.query(
    "INSERT INTO quotes(id,business_id,invoice_id,source,simulated,data,expires_at) VALUES($1,$2,$3,'simulation-fixed-525',true,$4,$5)",
    [
      quoteId,
      businessId,
      invoiceId,
      JSON.stringify(invoice.quote),
      new Date("2027-12-20T00:00:00.123Z"),
    ],
  );
  await pool.query(
    "INSERT INTO route_decision_evidence(id,business_id,invoice_id,quote_id,created_by_user_id,routing_correlation_id,public_evidence_id,evidence_schema_version,quote_schema_version,chain_id,registry_address,sequence,evidence_kind,selected_route_code,quote_snapshot_hash,previous_payload_hash,payload_hash,envelope_version,content_algorithm,ciphertext,nonce,authentication_tag,wrapped_dek,kms_provider,wrapped_dek_algorithm,wrapped_dek_format,kms_key_reference,kms_key_version,aad_version) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,'421614',$8,'1',1,2,$9,$10,$11,1,'AES-256-GCM',$12,$13,$14,$15,$16,$17,$18,'local-test-only/tests/evidence','local-test-only/tests/v1',1)",
    [
      evidenceId,
      businessId,
      invoiceId,
      quoteId,
      userId,
      randomUUID(),
      publicEvidenceId,
      registryAddress,
      bytes32(0x03),
      previousPayloadHash,
      payloadHash,
      Buffer.alloc(24, 5),
      Buffer.alloc(12, 6),
      Buffer.alloc(16, 7),
      Buffer.alloc(48, 8),
      KMS_PROVIDER.LOCAL_TEST_ONLY,
      WRAPPED_DEK_ALGORITHM.LOCAL_TEST_RANDOM_BYTES_V1,
      WRAPPED_DEK_FORMAT.LOCAL_TEST_RANDOM_BYTES_V1,
    ],
  );
  /**
   * Seeding the outbox row is fixture work: the application's grant is
   * `INSERT (id, evidence_record_id)` only and relies on the migration-007
   * `DEFAULT 'pending'`. The production writer is asserted separately by
   * `insertPendingEvidenceOutbox`, which uses exactly the two-column form.
   */
  await fixtures(
    "INSERT INTO evidence_outbox(id,evidence_record_id) VALUES($1,$2)",
    [outboxId, evidenceId],
  );

  return {
    evidenceId,
    outboxId,
    publicEvidenceId,
    payloadHash,
    previousPayloadHash,
    registryAddress,
  };
}

/**
 * Priming `submitted` is administrative: the application holds no `UPDATE` on
 * `evidence_outbox` at all, so this state is unreachable for it by privilege.
 */
async function markSubmitted(outboxId: string) {
  await fixtures(
    "UPDATE evidence_outbox SET submission_state='submitted', transaction_hash=$2, submitted_at=now() WHERE id=$1",
    [outboxId, Buffer.from(TX_HASH.slice(2), "hex")],
  );
}

/**
 * An in-memory chain world matching a seeded record.
 *
 * The commitment values are read from the seeded row so the fixture chain and the
 * database cannot drift apart.
 */
function worldFor(seeded: Seeded): Promise<AnchorWorld> {
  return startAnchorWorld({
    registry: REGISTRY,
    attestor: ATTESTOR,
    administrator: ADMIN,
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: BLOCK_NUMBER,
    finalizedOffset: 100,
    evidenceId: `0x${seeded.publicEvidenceId.toString("hex")}`,
    payloadHash: `0x${seeded.payloadHash.toString("hex")}`,
    previousPayloadHash: `0x${seeded.previousPayloadHash.toString("hex")}`,
    kind: 1n,
    sequence: 1n,
    runtimeCode: "0x6080604052348015600f57600080fd5b50",
  });
}

function anchorLog(seeded: Seeded, overrides: Record<string, unknown> = {}) {
  return {
    address: REGISTRY,
    topics: [
      TOPIC,
      `0x${seeded.publicEvidenceId.toString("hex")}`,
      `0x${seeded.payloadHash.toString("hex")}`,
      zeroPadValue(getAddress(ATTESTOR), 32),
    ],
    data: `0x${toBeHex(1n, 32).slice(2)}${toBeHex(1, 32).slice(2)}${seeded.previousPayloadHash.toString("hex")}`,
    ...overrides,
  };
}

/** A purely synthetic observation, used only to build evaluation proofs. */
function observation(
  seeded: Seeded,
  overrides: Partial<ChainObservation> = {},
): ChainObservation {
  return {
    chainId: "421614",
    transactionHash: TX_HASH,
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    registryIdentity: "verified",
    receipt: {
      transactionHash: TX_HASH,
      status: "success",
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: String(BLOCK_NUMBER),
      blockHash: BLOCK_HASH,
      logs: [anchorLog(seeded)],
    },
    ...overrides,
  };
}

/** In-memory only; performs no network access of any kind. */
class FakeChainReader implements EvidenceChainReader {
  constructor(private readonly value: ChainObservation | null) {}
  async readAnchorObservation(): Promise<ChainObservation> {
    if (!this.value) throw new Error("synthetic chain read failure");
    return this.value;
  }
}

/**
 * Confirmation-state snapshot, read on the administrative identity.
 *
 * Four of the five columns are ungranted for the application: it may read only
 * `submission_state`. Asserting the confirmation columns from the app identity
 * would fail with `42501` rather than returning a state, so this is exactly the
 * "admin helper" case the design assigns to private metadata reads.
 */
async function stateOf(outboxId: string) {
  const result = await fixturesRead(
    "SELECT submission_state,transaction_hash,confirmed_at,confirmed_block_number,attestor_address FROM evidence_outbox WHERE id=$1",
    [outboxId],
  );
  /**
   * Narrowed to the historical non-optional shape: every call site already
   * seeds the row first, and the original `pool.query` was typed the same way.
   */
  return result.rows[0] as {
    submission_state: string;
    transaction_hash: Buffer | null;
    confirmed_at: Date | null;
    confirmed_block_number: string | null;
    attestor_address: Buffer | null;
  };
}

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// The new Phase 2C.2A gate
// ---------------------------------------------------------------------------

/**
 * Why some tests are skipped.
 *
 * Review pass 3 removed test-only operator issuance from production, so no reader the
 * suite can build is operator-scoped, and `runTrustedVerification` refuses all of them
 * with `READER_NOT_TRUSTED`. Any test whose subject is a *genuinely trusted result* —
 * the sealed object, its binding, and the SQL write that a confirmed result performs —
 * therefore cannot run until a real reviewed deployment manifest exists.
 *
 * They are skipped with this reason rather than deleted or faked (minting a fake
 * production authorizing result is precisely the vulnerability this pass closes).
 *
 * Keeping the callbacks in source is **not** coverage and is not equivalent to it. A
 * skipped callback never executes: its body is not run against the database, and the
 * SQL write in `confirmVerifiedAnchor` is never performed by this file. These tests are
 * therefore not evidence that successful confirmation persistence works. No executed
 * test in this repository exercises the success path of `confirmVerifiedAnchor`.
 *
 * What does still run: the rejection paths that do not need a genuine result, including
 * every forged-look-alike test.
 */
const NEEDS_OPERATOR_READER =
  "requires a genuinely operator-pinned reader; no deployment manifest exists";

test("a genuine evaluation proof alone cannot confirm, because provenance is unestablished", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  // This proof is genuinely minted by the evaluation module, for exactly the right
  // commitment. Under Phase 2C.1 it would have confirmed the row.
  const genuine = asProof(
    evaluateAnchorObservation(
      {
        chainId: row.chainId,
        registryAddress: row.registryAddress,
        evidenceId: row.evidenceId,
        payloadHash: row.payloadHash,
        evidenceKind: row.evidenceKind,
        sequence: row.sequence,
        previousPayloadHash: row.previousPayloadHash,
      },
      observation(seeded),
    ),
  );
  assert.equal(isAnchorEvaluationProof(genuine), true);

  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    genuine as never,
    new Date(),
  );
  assert.deepEqual(outcome, {
    confirmed: false,
    failure: "TRUSTED_PROVENANCE_REQUIRED",
  });
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("a trusted verification produced by the real pipeline does confirm", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(
      pool as never,
      seeded.outboxId,
    );
    assert.equal(isTrustedAnchorVerification(trusted), true);
    assert.equal(trusted.seal.finality.level, "finalized");

    const outcome = await confirmVerifiedAnchor(
      pool as never,
      row,
      trusted,
      new Date(),
    );
    assert.equal(outcome.confirmed, true);
    assert.equal(
      (await stateOf(seeded.outboxId)).submission_state,
      "confirmed",
    );
  } finally {
    await world.close();
  }
});

test("the confirmation boundary rejects a result whose binding was altered", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(pool as never, seeded.outboxId);
    assert.equal(isTrustedAnchorVerification(trusted), true);

    // Any attempt to alter a bound field must fail: the result and its binding are
    // deeply frozen, so the boundary can never see a mutated one.
    assert.throws(() => {
      (trusted.binding as { payloadHash: string }).payloadHash = `0x${"ff".repeat(32)}`;
    }, /read only|Cannot assign/i);
    assert.throws(() => {
      (trusted.seal.observation.receipt as { blockHash: string }).blockHash =
        `0x${"ee".repeat(32)}`;
    }, /read only|Cannot assign/i);

    // A hand-built result carrying a genuine proof and seal but a stale binding is not
    // an issued result, so gate 1 refuses it.
    const forged = { ...trusted } as never;
    const rejected = await confirmVerifiedAnchor(pool as never, row, forged, new Date());
    assert.deepEqual(rejected, {
      confirmed: false,
      failure: "TRUSTED_PROVENANCE_REQUIRED",
    });

    assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
  } finally {
    await world.close();
  }
});

test("a trusted verification with a forged seal is refused", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(
      pool as never,
      seeded.outboxId,
    );
    const forgeries: unknown[] = [
      { ...trusted },
      structuredClone(trusted),
      JSON.parse(JSON.stringify({ verified: true })),
      {
        verified: true,
        status: "verified",
        proof: trusted.proof,
        seal: { ...trusted.seal },
      },
      { verified: true, status: "verified", proof: trusted.proof },
    ];
    for (const forged of forgeries) {
      const outcome = await confirmVerifiedAnchor(
        pool as never,
        row,
        forged as never,
        new Date(),
      );
      assert.deepEqual(outcome, {
        confirmed: false,
        failure: "TRUSTED_PROVENANCE_REQUIRED",
      });
    }
    assert.equal(
      (await stateOf(seeded.outboxId)).submission_state,
      "submitted",
    );
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// Existing invariants, now exercised through the trusted path
// ---------------------------------------------------------------------------

test("a pending outbox row cannot be confirmed even with a trusted result", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(
      pool as never,
      seeded.outboxId,
    );
    const outcome = await confirmVerifiedAnchor(
      pool as never,
      row,
      trusted,
      new Date(),
    );
    assert.deepEqual(outcome, {
      confirmed: false,
      failure: "OUTBOX_NOT_CONFIRMABLE",
    });
    assert.equal((await stateOf(seeded.outboxId)).submission_state, "pending");
  } finally {
    await world.close();
  }
});

test("confirming a submitted row writes the full metadata exactly once", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(
      pool as never,
      seeded.outboxId,
    );
    const now = new Date();
    const outcome = await confirmVerifiedAnchor(
      pool as never,
      row,
      trusted,
      now,
    );
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.confirmed && outcome.transactionHash, TX_HASH);
    assert.match(
      String(outcome.confirmed && outcome.commitmentDigest),
      /^[0-9a-f]{64}$/,
    );

    const state = await stateOf(seeded.outboxId);
    assert.equal(state.submission_state, "confirmed");
    assert.ok(state.confirmed_at instanceof Date);
    assert.equal(state.confirmed_block_number, String(BLOCK_NUMBER));
    assert.equal(state.attestor_address?.toString("hex"), ATTESTOR.slice(2));

    // Repeated processing matches zero rows and does not rewrite the timestamp.
    const again = await confirmVerifiedAnchor(
      pool as never,
      row,
      trusted,
      new Date(Date.now() + 60_000),
    );
    assert.deepEqual(again, {
      confirmed: false,
      failure: "OUTBOX_NOT_CONFIRMABLE",
    });
    const after = await stateOf(seeded.outboxId);
    assert.equal(after.confirmed_at?.getTime(), now.getTime());
  } finally {
    await world.close();
  }
});

test("an unverified evaluation can never reach the confirmed state", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const broken: Array<[string, ChainObservation]> = [
    [
      "reverted",
      observation(seeded, {
        receipt: { ...observation(seeded).receipt!, status: "reverted" },
      }),
    ],
    ["wrong chain", observation(seeded, { chainId: "42161" })],
    [
      "wrong registry",
      observation(seeded, {
        transactionTo: "0x2222222222222222222222222222222222222222",
      }),
    ],
    [
      "no event",
      observation(seeded, {
        receipt: { ...observation(seeded).receipt!, logs: [] },
      }),
    ],
    ["unknown identity", observation(seeded, { registryIdentity: null })],
  ];

  for (const [label, observed] of broken) {
    const verification = await verifyOutboxAgainstChain(
      new FakeChainReader(observed),
      row,
      TX_HASH,
    );
    assert.equal(verification.verified, false, `${label} must not verify`);
    const outcome = await confirmVerifiedAnchor(
      pool as never,
      row,
      verification as never,
      new Date(),
    );
    assert.equal(outcome.confirmed, false, `${label} must not confirm`);
  }

  const state = await stateOf(seeded.outboxId);
  assert.equal(state.submission_state, "submitted");
  assert.equal(state.confirmed_at, null);
});

test("a chain-reader failure is treated as unverified, not as success", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const verification = await verifyOutboxAgainstChain(
    new FakeChainReader(null),
    row,
    TX_HASH,
  );
  assert.deepEqual(verification, {
    verified: false,
    status: "not_verified",
    failure: "NO_OBSERVATION",
  });
  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    verification as never,
    new Date(),
  );
  assert.equal(outcome.confirmed, false);
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("a stale commitment cannot be confirmed against a receipt for another record", async () => {
  const seeded = await seedOutbox();
  const other = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const verification = evaluateAnchorObservation(
    {
      chainId: row.chainId,
      registryAddress: row.registryAddress,
      evidenceId: row.evidenceId,
      payloadHash: row.payloadHash,
      evidenceKind: row.evidenceKind,
      sequence: row.sequence,
      previousPayloadHash: row.previousPayloadHash,
    },
    observation(other),
  );
  assert.equal(verification.verified, false);
  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    verification as never,
    new Date(),
  );
  assert.equal(outcome.confirmed, false);
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("a proof's facts are frozen and a hand-built look-alike confirms nothing", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const proof = asProof(
    evaluateAnchorObservation(
      {
        chainId: row.chainId,
        registryAddress: row.registryAddress,
        evidenceId: row.evidenceId,
        payloadHash: row.payloadHash,
        evidenceKind: row.evidenceKind,
        sequence: row.sequence,
        previousPayloadHash: row.previousPayloadHash,
      },
      observation(seeded),
    ),
  );
  assert.throws(() => {
    (proof.facts as { registryAddress: string }).registryAddress =
      "0x2222222222222222222222222222222222222222";
  }, /read only|Cannot assign/i);
  assert.equal(proof.facts.registryAddress, REGISTRY);

  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    {
      verified: true,
      status: "verified",
      facts: {
        ...proof.facts,
        registryAddress: "0x2222222222222222222222222222222222222222",
      },
    } as never,
    new Date(),
  );
  assert.deepEqual(outcome, {
    confirmed: false,
    failure: "TRUSTED_PROVENANCE_REQUIRED",
  });
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("the outbox update is scoped to submitted rows inside a transaction", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(
      pool as never,
      seeded.outboxId,
    );
    await transaction(async (db) => {
      const outcome = await confirmVerifiedAnchor(db, row, trusted, new Date());
      assert.equal(outcome.confirmed, true);
    });
    assert.equal(
      (await stateOf(seeded.outboxId)).submission_state,
      "confirmed",
    );
  } finally {
    await world.close();
  }
});

test("a forged verified object cannot confirm a submitted row", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const genuine = asProof(
    evaluateAnchorObservation(
      {
        chainId: row.chainId,
        registryAddress: row.registryAddress,
        evidenceId: row.evidenceId,
        payloadHash: row.payloadHash,
        evidenceKind: row.evidenceKind,
        sequence: row.sequence,
        previousPayloadHash: row.previousPayloadHash,
      },
      observation(seeded),
    ),
  );

  const forgeries: unknown[] = [
    { verified: true, status: "verified" },
    { verified: true, status: "verified", facts: genuine.facts },
    JSON.parse(
      JSON.stringify({
        verified: true,
        status: "verified",
        facts: genuine.facts,
      }),
    ),
    { ...genuine },
    structuredClone(genuine),
    Object.create(Object.getPrototypeOf(genuine)),
  ];

  for (const forged of forgeries) {
    const outcome = await confirmVerifiedAnchor(
      pool as never,
      row,
      forged as never,
      new Date(),
    );
    assert.deepEqual(
      outcome,
      { confirmed: false, failure: "TRUSTED_PROVENANCE_REQUIRED" },
      "a forged object must never confirm",
    );
  }

  const state = await stateOf(seeded.outboxId);
  assert.equal(state.submission_state, "submitted");
  assert.equal(state.confirmed_at, null);
});

test("a trusted result for a different evidence record cannot confirm this row", { skip: NEEDS_OPERATOR_READER }, async () => {
  const target = await seedOutbox();
  const other = await seedOutbox();
  await markSubmitted(target.outboxId);

  const targetRow = await readConfirmableOutboxRow(
    pool as never,
    target.outboxId,
  );
  assert.ok(targetRow);

  // A genuinely trusted verification — but it describes the *other* record.
  const otherWorld = await worldFor(other);
  try {
    const { trusted } = await otherWorld.confirmable(
      pool as never,
      other.outboxId,
    );
    const outcome = await confirmVerifiedAnchor(
      pool as never,
      targetRow,
      trusted,
      new Date(),
    );
    assert.deepEqual(outcome, {
      confirmed: false,
      failure: "COMMITMENT_MISMATCH",
    });
    assert.equal(
      (await stateOf(target.outboxId)).submission_state,
      "submitted",
    );
  } finally {
    await otherWorld.close();
  }
});

test("each commitment field is enforced by the write itself, not only in memory", { skip: NEEDS_OPERATOR_READER }, async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const { row, trusted } = await world.confirmable(
      pool as never,
      seeded.outboxId,
    );

    // Simulate a stale in-memory row: the persisted evidence no longer matches.
    const stale: typeof row = { ...row, payloadHash: `0x${"ff".repeat(32)}` };
    const outcome = await confirmVerifiedAnchor(
      pool as never,
      stale,
      trusted,
      new Date(),
    );
    assert.deepEqual(outcome, {
      confirmed: false,
      failure: "COMMITMENT_MISMATCH",
    });

    // Persisted evidence cannot drift: append-only trigger.
    await assert.rejects(
      fixtures(
        "UPDATE route_decision_evidence SET payload_hash=$2 WHERE id=$1",
        [seeded.evidenceId, Buffer.from("ff".repeat(32), "hex")],
      ),
      /immutable/i,
    );

    // The write-time WHERE remains load-bearing. Build a *trusted* verification
    // whose event carries a different evidence id, then hand the boundary a row
    // object that claims that same id. The in-memory commitment comparison now
    // passes, so only `FROM route_decision_evidence ... WHERE` can refuse.
    const foreignEvidenceId = `0x${"ee".repeat(32)}`;
    const foreignWorld = await startAnchorWorld({
      ...world.options,
      evidenceId: foreignEvidenceId,
      transactionHash: TX_HASH,
      blockHash: BLOCK_HASH,
    });
    try {
      const foreign = await foreignWorld.verify({
        chainId: row.chainId,
        registryAddress: row.registryAddress,
        evidenceId: foreignEvidenceId,
        payloadHash: row.payloadHash,
        evidenceKind: row.evidenceKind,
        sequence: row.sequence,
        previousPayloadHash: row.previousPayloadHash,
      });
      assert.equal(foreign.ok, true, JSON.stringify(foreign));
      if (!foreign.ok) return;
      // Sanity: the in-memory comparison accepts this pairing.
      assert.equal(
        foreign.result.proof.facts.commitment.evidenceId,
        foreignEvidenceId,
      );

      const sqlOnly = await confirmVerifiedAnchor(
        pool as never,
        { ...row, evidenceId: foreignEvidenceId },
        foreign.result,
        new Date(),
      );
      assert.deepEqual(sqlOnly, {
        confirmed: false,
        failure: "OUTBOX_NOT_CONFIRMABLE",
      });
    } finally {
      await foreignWorld.close();
    }
    assert.equal(
      (await stateOf(seeded.outboxId)).submission_state,
      "submitted",
    );
  } finally {
    await world.close();
  }
});

test("a reader returning a different valid transaction cannot verify the requested one", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const otherTx = `0x${"ee".repeat(32)}`;
  const real = observation(seeded);
  const swappedReader: EvidenceChainReader = {
    async readAnchorObservation() {
      return {
        ...real,
        transactionHash: otherTx,
        receipt: { ...real.receipt!, transactionHash: otherTx },
      };
    },
  };

  const verification = await verifyOutboxAgainstChain(
    swappedReader,
    row,
    TX_HASH,
  );
  assert.deepEqual(verification, {
    verified: false,
    status: "not_verified",
    failure: "RECEIPT_TRANSACTION_MISMATCH",
  });

  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    verification as never,
    new Date(),
  );
  assert.equal(outcome.confirmed, false);
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("a trusted verification for a non-finalized receipt cannot be produced", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const world = await worldFor(seeded);
  try {
    const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
    assert.ok(row);
    // Move the finalized head below the receipt block.
    world.setOverride(
      "eth_getBlockByNumber",
      (call: { params: readonly unknown[] }) =>
        call.params[0] === "finalized"
          ? {
              number: `0x${(BLOCK_NUMBER - 1).toString(16)}`,
              hash: hex32("low"),
            }
          : { number: `0x${BLOCK_NUMBER.toString(16)}`, hash: BLOCK_HASH },
    );
    const outcome = await world.verify({
      chainId: row.chainId,
      registryAddress: row.registryAddress,
      evidenceId: row.evidenceId,
      payloadHash: row.payloadHash,
      evidenceKind: row.evidenceKind,
      sequence: row.sequence,
      previousPayloadHash: row.previousPayloadHash,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // Since review pass 3 the provenance gate refuses this test-scoped reader before
    // the reader ever reaches finality, so the observed code is `READER_NOT_TRUSTED`.
    // The property under test — a non-finalized receipt never yields a proof — still
    // holds, and the reader-level equivalent (asserting the finality code directly)
    // runs in `tests/evidence/trusted-pipeline.test.ts`.
    assert.equal(outcome.failure, "READER_NOT_TRUSTED");

    const confirmed = await confirmVerifiedAnchor(
      pool as never,
      row,
      outcome as never,
      new Date(),
    );
    assert.equal(confirmed.confirmed, false);
    assert.equal(
      (await stateOf(seeded.outboxId)).submission_state,
      "submitted",
    );
  } finally {
    await world.close();
  }
});
