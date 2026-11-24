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
  isAnchorVerificationProof,
  verifyAnchorObservation,
  type AnchorVerificationProof,
  type AnchorVerificationResult,
} from "../src/server/evidence/anchor-verification";
import type {
  ChainObservation,
  EvidenceChainReader,
} from "../src/server/evidence/anchor-verification";

/**
 * Narrows a pipeline result to a proof, failing loudly when it is not one.
 * Mirrors what production code must do: a result is only usable once it is a
 * proof the verification module actually issued.
 */
function asProof(result: AnchorVerificationResult): AnchorVerificationProof {
  assert.ok(
    isAnchorVerificationProof(result),
    "expected a real verification proof",
  );
  return result;
}

/**
 * Confirmed-state invariant tests.
 *
 * These use a real local PostgreSQL database, exactly like the other backend
 * integration tests, plus a purely in-memory fake chain reader. No RPC endpoint
 * is contacted and no transaction is broadcast.
 */

const REGISTRY = "0x1111111111111111111111111111111111111111";
const ATTESTOR = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"cc".repeat(32)}`;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
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
  // `public_evidence_id` must be 32 non-zero bytes and is unique per record,
  // so each fixture draws its own value.
  const publicEvidenceId = randomBytes(32);
  const payloadHash = bytes32(0xbb);
  const previousPayloadHash = Buffer.alloc(32);
  const registryAddress = Buffer.from(REGISTRY.slice(2), "hex");

  await pool.query("INSERT INTO businesses(id,name) VALUES($1,$2)", [
    businessId,
    "Anchor invariant test business",
  ]);
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    userId,
    `${userId}@example.invalid`,
  ]);
  await pool.query(
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
  await pool.query(
    "INSERT INTO evidence_outbox(id,evidence_record_id,submission_state) VALUES($1,$2,'pending')",
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

async function markSubmitted(outboxId: string) {
  await pool.query(
    "UPDATE evidence_outbox SET submission_state='submitted', transaction_hash=$2, submitted_at=now() WHERE id=$1",
    [outboxId, Buffer.from(TX_HASH.slice(2), "hex")],
  );
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
      blockNumber: "9876543",
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

async function stateOf(outboxId: string) {
  const result = await pool.query<{
    submission_state: string;
    transaction_hash: Buffer | null;
    confirmed_at: Date | null;
    confirmed_block_number: string | null;
    attestor_address: Buffer | null;
  }>(
    "SELECT submission_state,transaction_hash,confirmed_at,confirmed_block_number,attestor_address FROM evidence_outbox WHERE id=$1",
    [outboxId],
  );
  return result.rows[0];
}

after(async () => {
  await pool.end();
});

test("a pending outbox row cannot be confirmed even with a valid receipt", async () => {
  const seeded = await seedOutbox();
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);
  const verification = verifyAnchorObservation(
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
  );
  assert.equal(verification.verified, true);

  // The receipt is genuinely valid, but the row is still `pending`.
  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    asProof(verification),
    new Date(),
  );
  assert.deepEqual(outcome, {
    confirmed: false,
    failure: "OUTBOX_NOT_CONFIRMABLE",
  });
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "pending");
});

test("confirming a submitted row writes the full confirmation metadata exactly once", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);
  const verification = verifyAnchorObservation(
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
  );
  const now = new Date();
  const outcome = await confirmVerifiedAnchor(
    pool as never,
    row,
    asProof(verification),
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
  assert.equal(state.confirmed_block_number, "9876543");
  assert.equal(state.attestor_address?.toString("hex"), ATTESTOR.slice(2));

  // Repeated processing matches zero rows and does not rewrite the timestamp.
  const again = await confirmVerifiedAnchor(
    pool as never,
    row,
    asProof(verification),
    new Date(Date.now() + 60_000),
  );
  assert.deepEqual(again, {
    confirmed: false,
    failure: "OUTBOX_NOT_CONFIRMABLE",
  });
  const after = await stateOf(seeded.outboxId);
  assert.equal(after.confirmed_at?.getTime(), now.getTime());
});

test("an unverified result can never reach the confirmed state", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const brokenReceipts: Array<[string, ChainObservation]> = [
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

  for (const [label, observed] of brokenReceipts) {
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

  // A receipt that is individually valid, but proves the *other* evidence id.
  const verification = verifyAnchorObservation(
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

test("a verified result for a different registry is rejected at the persistence boundary", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const verification = verifyAnchorObservation(
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
  );
  assert.equal(verification.verified, true);
  if (!verification.verified) return;

  // A proof's facts are frozen, so a caller cannot rewrite the registry on a real
  // proof at all. Prove that directly...
  const proof = asProof(verification);
  assert.throws(() => {
    (proof.facts as { registryAddress: string }).registryAddress =
      "0x2222222222222222222222222222222222222222";
  }, /read only|Cannot assign/i);
  assert.equal(proof.facts.registryAddress, REGISTRY);

  // ...and that a hand-built object claiming the same thing confirms nothing.
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
  assert.deepEqual(outcome, { confirmed: false, failure: "PROOF_REQUIRED" });
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("the outbox update is scoped to submitted rows inside a transaction", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);
  const verification = verifyAnchorObservation(
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
  );

  await transaction(async (db) => {
    const outcome = await confirmVerifiedAnchor(
      db,
      row,
      asProof(verification),
      new Date(),
    );
    assert.equal(outcome.confirmed, true);
  });
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "confirmed");
});

test("a forged verified object cannot confirm a submitted row", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  // Derive the genuine facts so the forgery is as convincing as possible: it
  // carries a real transaction hash, a real block, and a real attestor.
  const genuine = asProof(
    verifyAnchorObservation(
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
      { confirmed: false, failure: "PROOF_REQUIRED" },
      "a forged object must never confirm",
    );
  }

  const state = await stateOf(seeded.outboxId);
  assert.equal(state.submission_state, "submitted");
  assert.equal(state.confirmed_at, null);

  // The genuine proof still works, proving the guard is not merely "always no".
  const ok = await confirmVerifiedAnchor(
    pool as never,
    row,
    genuine,
    new Date(),
  );
  assert.equal(ok.confirmed, true);
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "confirmed");
});

test("a valid proof for a different evidence record cannot confirm this row", async () => {
  const target = await seedOutbox();
  const other = await seedOutbox();
  await markSubmitted(target.outboxId);

  const targetRow = await readConfirmableOutboxRow(
    pool as never,
    target.outboxId,
  );
  assert.ok(targetRow);

  // A genuinely verified proof — but for the *other* record's commitment.
  const otherProof = asProof(
    verifyAnchorObservation(
      {
        chainId: targetRow.chainId,
        registryAddress: targetRow.registryAddress,
        evidenceId: `0x${other.publicEvidenceId.toString("hex")}`,
        payloadHash: `0x${other.payloadHash.toString("hex")}`,
        evidenceKind: 1,
        sequence: "1",
        previousPayloadHash: `0x${other.previousPayloadHash.toString("hex")}`,
      },
      observation(other),
    ),
  );

  // The proof is real, but it does not describe the target row. The digest is
  // computed from the row's commitment, so the two cannot agree.
  const outcome = await confirmVerifiedAnchor(
    pool as never,
    targetRow,
    otherProof,
    new Date(),
  );
  assert.deepEqual(outcome, {
    confirmed: false,
    failure: "COMMITMENT_MISMATCH",
  });
  assert.equal((await stateOf(target.outboxId)).submission_state, "submitted");
});

test("each commitment field is enforced by the write itself, not only in memory", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const genuine = asProof(
    verifyAnchorObservation(
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

  // Simulate a stale or wrong in-memory row: the persisted evidence no longer
  // matches, so the `UPDATE ... FROM route_decision_evidence` WHERE clause must
  // refuse the write even though the proof itself is genuine.
  const stale: typeof row = {
    ...row,
    payloadHash: `0x${"ff".repeat(32)}`,
  };
  const outcome = await confirmVerifiedAnchor(
    pool as never,
    stale,
    genuine,
    new Date(),
  );
  // Rejected by the in-memory commitment comparison before any write.
  assert.deepEqual(outcome, {
    confirmed: false,
    failure: "COMMITMENT_MISMATCH",
  });

  // Persisted evidence cannot drift: the table is protected by an append-only
  // trigger, so this tamper attempt is itself refused by the database.
  await assert.rejects(
    pool.query(
      "UPDATE route_decision_evidence SET payload_hash=$2 WHERE id=$1",
      [seeded.evidenceId, Buffer.from("ff".repeat(32), "hex")],
    ),
    /immutable/i,
  );

  // The write-time `WHERE` remains load-bearing anyway. Mint a genuine proof for
  // a commitment whose evidence id differs from what is stored, then hand the
  // boundary a row object that claims the proof's id. The in-memory comparison
  // passes; only the `FROM route_decision_evidence ... WHERE` clause can refuse.
  const foreignEvidenceId = `0x${"ee".repeat(32)}`;
  const foreignLog = {
    ...anchorLog(seeded),
    topics: [
      TOPIC,
      foreignEvidenceId,
      anchorLog(seeded).topics[2],
      anchorLog(seeded).topics[3],
    ],
  };
  const elsewhere = asProof(
    verifyAnchorObservation(
      {
        chainId: row.chainId,
        registryAddress: row.registryAddress,
        evidenceId: foreignEvidenceId,
        payloadHash: row.payloadHash,
        evidenceKind: row.evidenceKind,
        sequence: row.sequence,
        previousPayloadHash: row.previousPayloadHash,
      },
      {
        ...observation(seeded),
        receipt: { ...observation(seeded).receipt!, logs: [foreignLog] },
      },
    ),
  );
  const sqlOnly = await confirmVerifiedAnchor(
    pool as never,
    { ...row, evidenceId: foreignEvidenceId },
    elsewhere,
    new Date(),
  );
  assert.deepEqual(sqlOnly, {
    confirmed: false,
    failure: "OUTBOX_NOT_CONFIRMABLE",
  });
  assert.equal((await stateOf(seeded.outboxId)).submission_state, "submitted");
});

test("a reader returning a different valid transaction cannot verify the requested one", async () => {
  const seeded = await seedOutbox();
  await markSubmitted(seeded.outboxId);
  const row = await readConfirmableOutboxRow(pool as never, seeded.outboxId);
  assert.ok(row);

  const otherTx = `0x${"ee".repeat(32)}`;
  const real = observation(seeded);

  // A reader that answers a request for TX_HASH with a different, internally
  // consistent transaction must not be represented as verifying TX_HASH.
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
