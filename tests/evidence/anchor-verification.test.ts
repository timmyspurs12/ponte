import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, id as keccakId, zeroPadValue, toBeHex } from "ethers";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  EVIDENCE_ANCHORED_TOPIC,
  NOT_VERIFIED_ANCHORING,
  AnchorVerificationProof,
  anchoringStatusFor,
  commitmentDigest,
  decodeEvidenceAnchored,
  isAnchorVerificationProof,
  verifyAnchorObservation,
  type ChainObservation,
  type ExpectedAnchorCommitment,
  type ObservedAnchorEvent,
} from "../../src/server/evidence/anchor-verification";

/**
 * Everything in this file is synthetic. No RPC endpoint is contacted, no wallet
 * exists, and no transaction is broadcast. The "chain reader" fixtures are plain
 * object literals.
 */

const REGISTRY = "0x1111111111111111111111111111111111111111";
const OTHER_REGISTRY = "0x2222222222222222222222222222222222222222";
const ATTESTOR = "0x3333333333333333333333333333333333333333";
const STRANGER = "0x4444444444444444444444444444444444444444";

const EVIDENCE_ID = `0x${"aa".repeat(32)}`;
const PAYLOAD_HASH = `0x${"bb".repeat(32)}`;
const PREVIOUS_HASH = `0x${"00".repeat(32)}`;
const NEXT_PREVIOUS = `0x${"bb".repeat(32)}`;
const TX_HASH = `0x${"cc".repeat(32)}`;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;

/** ABI-encodes one `EvidenceAnchored` log exactly as the Registry would emit. */
function anchorLog(options: {
  registry?: string;
  evidenceId?: string;
  payloadHash?: string;
  attestor?: string;
  sequence?: bigint;
  kind?: number;
  previousPayloadHash?: string;
}): ObservedAnchorEvent {
  const {
    registry = REGISTRY,
    evidenceId = EVIDENCE_ID,
    payloadHash = PAYLOAD_HASH,
    attestor = ATTESTOR,
    sequence = 1n,
    kind = 1,
    previousPayloadHash = PREVIOUS_HASH,
  } = options;
  return {
    address: registry,
    topics: [
      EVIDENCE_ANCHORED_TOPIC,
      evidenceId,
      payloadHash,
      zeroPadValue(getAddress(attestor), 32),
    ],
    data: `0x${toBeHex(sequence, 32).slice(2)}${toBeHex(kind, 32).slice(2)}${previousPayloadHash.slice(2)}`,
  };
}

const EXPECTED: ExpectedAnchorCommitment = {
  chainId: "421614",
  registryAddress: REGISTRY,
  evidenceId: EVIDENCE_ID,
  payloadHash: PAYLOAD_HASH,
  evidenceKind: 1,
  sequence: "1",
  previousPayloadHash: PREVIOUS_HASH,
};

function observation(
  overrides: Partial<ChainObservation> = {},
  logOverrides: Parameters<typeof anchorLog>[0] = {},
  receiptOverrides: Record<string, unknown> = {},
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
      blockNumber: "12345678",
      blockHash: BLOCK_HASH,
      logs: [anchorLog(logOverrides)],
      ...receiptOverrides,
    } as ChainObservation["receipt"],
    ...overrides,
  };
}

function failure(result: ReturnType<typeof verifyAnchorObservation>): string {
  assert.equal(result.verified, false, "expected an unverified result");
  return (result as { failure: string }).failure;
}

test("accepts a fully matching observation", () => {
  const result = verifyAnchorObservation(EXPECTED, observation());
  assert.ok(isAnchorVerificationProof(result));
  assert.equal(result.facts.transactionHash, TX_HASH);
  assert.equal(result.facts.blockNumber, "12345678");
  assert.equal(result.facts.attestor, ATTESTOR.toLowerCase());
  assert.equal(result.facts.chainId, "421614");
});

test("rejects a missing observation", () => {
  assert.equal(
    failure(verifyAnchorObservation(EXPECTED, null)),
    "NO_OBSERVATION",
  );
});

test("rejects a missing receipt", () => {
  assert.equal(
    failure(verifyAnchorObservation(EXPECTED, observation({ receipt: null }))),
    "RECEIPT_MISSING",
  );
});

test("rejects a reverted transaction", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, {}, { status: "reverted" }),
      ),
    ),
    "TRANSACTION_REVERTED",
  );
});

test("rejects the wrong chain, including mainnet", () => {
  for (const chainId of ["42161", "1", "11155111", "421613"]) {
    assert.equal(
      failure(verifyAnchorObservation(EXPECTED, observation({ chainId }))),
      "WRONG_CHAIN",
      `chain ${chainId} must be rejected`,
    );
  }
});

test("rejects a receipt for a different transaction", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, {}, { transactionHash: `0x${"ee".repeat(32)}` }),
      ),
    ),
    "RECEIPT_TRANSACTION_MISMATCH",
  );
});

test("rejects the wrong Registry destination in receipt and transaction", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({ transactionTo: OTHER_REGISTRY }),
      ),
    ),
    "WRONG_REGISTRY_ADDRESS",
  );
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, {}, { to: OTHER_REGISTRY }),
      ),
    ),
    "WRONG_REGISTRY_ADDRESS",
  );
});

test("rejects an unprobed or failed Registry identity check", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({ registryIdentity: null }),
      ),
    ),
    "REGISTRY_IDENTITY_UNVERIFIED",
  );
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({ registryIdentity: "unverified" }),
      ),
    ),
    "REGISTRY_IDENTITY_UNVERIFIED",
  );
});

test("rejects a missing event", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(EXPECTED, observation({}, {}, { logs: [] })),
    ),
    "EVENT_MISSING",
  );
});

test("rejects an event emitted by a different contract", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, { registry: OTHER_REGISTRY }),
      ),
    ),
    "EVENT_MISSING",
  );
});

test("rejects two matching events in one receipt", () => {
  const log = anchorLog({});
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, {}, { logs: [log, log] }),
      ),
    ),
    "EVENT_AMBIGUOUS",
  );
});

test("rejects every mismatched commitment field", () => {
  const cases: Array<[Parameters<typeof anchorLog>[0], string]> = [
    [{ evidenceId: `0x${"ff".repeat(32)}` }, "WRONG_EVIDENCE_ID"],
    [{ payloadHash: `0x${"ff".repeat(32)}` }, "WRONG_PAYLOAD_HASH"],
    [{ sequence: 2n }, "WRONG_SEQUENCE"],
    [{ previousPayloadHash: NEXT_PREVIOUS }, "WRONG_PREVIOUS_PAYLOAD_HASH"],
    [{ kind: 0 }, "WRONG_EVIDENCE_KIND"],
    [{ kind: 2 }, "WRONG_EVIDENCE_KIND"],
  ];
  for (const [logOverrides, expected] of cases) {
    assert.equal(
      failure(verifyAnchorObservation(EXPECTED, observation({}, logOverrides))),
      expected,
    );
  }
});

test("rejects an attestor that did not send the transaction", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({ transactionFrom: STRANGER }, {}, { from: STRANGER }),
      ),
    ),
    "ATTESTOR_NOT_EVENT_SENDER",
  );
});

test("rejects a receipt sender that disagrees with the transaction sender", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, {}, { from: STRANGER }),
      ),
    ),
    "ATTESTOR_NOT_EVENT_SENDER",
  );
});

test("rejects malformed block metadata", () => {
  assert.equal(
    failure(
      verifyAnchorObservation(
        EXPECTED,
        observation({}, {}, { blockHash: "0x00" }),
      ),
    ),
    "BLOCK_METADATA_INCONSISTENT",
  );
});

test("accepts an attestor revoked after the fact, because authorship is historical", () => {
  // `registryIdentity: "verified"` means the Registry implementation was proven;
  // it says nothing about current attestor authority, which must not matter here.
  const result = verifyAnchorObservation(EXPECTED, observation());
  assert.equal(result.verified, true);
});

test("normalises address case in both the commitment and the observation", () => {
  const checksummed = getAddress(REGISTRY.toUpperCase().replace("0X", "0x"));
  const result = verifyAnchorObservation(
    { ...EXPECTED, registryAddress: checksummed },
    observation(),
  );
  assert.equal(result.verified, true);
});

test("rejects a non-canonical expected sequence instead of coercing it", () => {
  for (const sequence of ["01", "1.0", "1e0", "-1", "", " 1", "0x1"]) {
    assert.equal(
      failure(
        verifyAnchorObservation({ ...EXPECTED, sequence }, observation()),
      ),
      "EVENT_MALFORMED",
      `sequence ${JSON.stringify(sequence)} must be rejected`,
    );
  }
});

test("handles the uint64 sequence boundary without precision loss", () => {
  const max = 18446744073709551615n;
  const atMax = verifyAnchorObservation(
    { ...EXPECTED, sequence: max.toString() },
    observation({}, { sequence: max }),
  );
  assert.equal(atMax.verified, true);
  if (isAnchorVerificationProof(atMax))
    assert.equal(atMax.facts.blockNumber, "12345678");

  // Beyond uint64 the commitment is invalid rather than silently truncated.
  assert.equal(
    failure(
      verifyAnchorObservation(
        { ...EXPECTED, sequence: (max + 1n).toString() },
        observation({}, { sequence: max }),
      ),
    ),
    "EVENT_MALFORMED",
  );

  // A sequence that would lose precision as a float still compares exactly.
  const large = 9007199254740993n; // 2^53 + 1
  const exact = verifyAnchorObservation(
    { ...EXPECTED, sequence: large.toString() },
    observation({}, { sequence: large }),
  );
  assert.equal(exact.verified, true);
  const offByOne = verifyAnchorObservation(
    { ...EXPECTED, sequence: (large + 1n).toString() },
    observation({}, { sequence: large }),
  );
  assert.equal(offByOne.verified, false);
});

test("decodes the event strictly", () => {
  assert.ok(decodeEvidenceAnchored(anchorLog({})));
  // Wrong topic count.
  const log = anchorLog({});
  assert.equal(
    decodeEvidenceAnchored({ ...log, topics: log.topics.slice(0, 3) }),
    null,
  );
  assert.equal(
    decodeEvidenceAnchored({ ...log, topics: [...log.topics, log.topics[1]] }),
    null,
  );
  // Wrong signature.
  assert.equal(
    decodeEvidenceAnchored({
      ...log,
      topics: [keccakId("Other()"), ...log.topics.slice(1)],
    }),
    null,
  );
  // Truncated / oversized data.
  assert.equal(decodeEvidenceAnchored({ ...log, data: "0x" }), null);
  assert.equal(decodeEvidenceAnchored({ ...log, data: `${log.data}00` }), null);
  // A dirty high word in the uint64 slot is malformed, never truncated.
  const dirtySequence = `0x${"11".repeat(8)}${log.data.slice(18)}`;
  assert.equal(decodeEvidenceAnchored({ ...log, data: dirtySequence }), null);
  // An attestor topic with a dirty high word is not an address.
  assert.equal(
    decodeEvidenceAnchored({
      ...log,
      topics: [
        log.topics[0],
        log.topics[1],
        log.topics[2],
        `0x${"11".repeat(12)}${"3".repeat(40)}`,
      ],
    }),
    null,
  );
});

test("the presentation guard never upgrades anything but a real proof", () => {
  assert.deepEqual(anchoringStatusFor(null), NOT_VERIFIED_ANCHORING);
  assert.deepEqual(anchoringStatusFor(undefined), NOT_VERIFIED_ANCHORING);
  assert.deepEqual(
    anchoringStatusFor({
      verified: false,
      status: "not_verified",
      failure: "EVENT_MISSING",
    }),
    NOT_VERIFIED_ANCHORING,
  );

  // Every imitation of a verified claim is refused.
  const forgeries: unknown[] = [
    { verified: true, status: "verified", chainId: "421614" },
    { verified: true, status: "verified", transactionHash: TX_HASH },
    { facts: { transactionHash: TX_HASH }, verified: true, status: "verified" },
    JSON.parse(JSON.stringify({ verified: true, status: "verified" })),
  ];
  for (const forged of forgeries)
    assert.deepEqual(anchoringStatusFor(forged), NOT_VERIFIED_ANCHORING);

  // A cloned real proof loses its private brand.
  const real = verifyAnchorObservation(EXPECTED, observation());
  assert.deepEqual(
    anchoringStatusFor(structuredClone(real)),
    NOT_VERIFIED_ANCHORING,
  );
  assert.deepEqual(anchoringStatusFor({ ...real }), NOT_VERIFIED_ANCHORING);

  const claim = anchoringStatusFor(real);
  assert.equal(claim.verified, true);
  if (claim.verified) assert.equal(claim.transactionHash, TX_HASH);
});

test("the chain id constant is Arbitrum Sepolia", () => {
  assert.equal(ARBITRUM_SEPOLIA_CHAIN_ID, 421614n);
  // The topic is derived, so a signature change breaks this test rather than
  // silently decoding the wrong event.
  assert.equal(
    EVIDENCE_ANCHORED_TOPIC,
    keccakId("EvidenceAnchored(bytes32,bytes32,address,uint64,uint8,bytes32)"),
  );
});

test("the production runtime exposes no chain reader and no test hook", async () => {
  const runtime =
    await import("../../src/server/evidence/chain-reader-runtime");
  // A fake reader is only ever constructed inside tests; the shipped resolver
  // returns null, so anchoring cannot be silently verified by configuration.
  assert.equal(runtime.resolveEvidenceChainReader(), null);
  assert.match(runtime.evidenceChainReaderUnavailableReason(), /not verified/);
});

test("a forged verified result is rejected by the proof check", () => {
  const real = verifyAnchorObservation(EXPECTED, observation());
  assert.ok(isAnchorVerificationProof(real));

  // Every one of these is what a caller could hand-build to try to look verified.
  const forgeries: unknown[] = [
    { verified: true, status: "verified" },
    {
      verified: true,
      status: "verified",
      chainId: "421614",
      registryAddress: REGISTRY,
      transactionHash: TX_HASH,
      blockNumber: "12345678",
      blockHash: BLOCK_HASH,
      attestor: ATTESTOR,
    },
    { facts: real.facts, verified: true, status: "verified" },
    JSON.parse(
      JSON.stringify({ facts: real.facts, verified: true, status: "verified" }),
    ),
    { ...real },
    structuredClone(real),
    // Prototype imitation: has the class in its chain but no private field.
    Object.create(AnchorVerificationProof.prototype),
  ];

  for (const forged of forgeries) {
    assert.equal(
      isAnchorVerificationProof(forged),
      false,
      `forgery must be rejected: ${Object.prototype.toString.call(forged)}`,
    );
    // And it cannot produce a verified presentation claim either.
    assert.deepEqual(anchoringStatusFor(forged), NOT_VERIFIED_ANCHORING);
  }

  // The genuine article is still accepted, so the guard is not simply "always no".
  assert.equal(isAnchorVerificationProof(real), true);
  assert.equal(anchoringStatusFor(real).verified, true);
});

test("the commitment digest binds the full commitment and block metadata", () => {
  const proofOf = (obs: Parameters<typeof verifyAnchorObservation>[1]) => {
    const proof = verifyAnchorObservation(EXPECTED, obs);
    assert.ok(isAnchorVerificationProof(proof), "expected a proof");
    return proof;
  };

  const base = commitmentDigest(proofOf(observation()).facts);
  assert.match(base, /^[0-9a-f]{64}$/);

  // Different transaction hash, same commitment.
  const otherTx = `0x${"ee".repeat(32)}`;
  assert.notEqual(
    commitmentDigest(
      proofOf(
        observation(
          { transactionHash: otherTx },
          {},
          { transactionHash: otherTx },
        ),
      ).facts,
    ),
    base,
    "transaction hash must be bound",
  );

  // Different block metadata, same commitment.
  assert.notEqual(
    commitmentDigest(
      proofOf(observation({}, {}, { blockNumber: "99999999" })).facts,
    ),
    base,
    "block number must be bound",
  );
  assert.notEqual(
    commitmentDigest(
      proofOf(observation({}, {}, { blockHash: `0x${"ff".repeat(32)}` })).facts,
    ),
    base,
    "block hash must be bound",
  );
});

test("the proof carries its own commitment, so it cannot be re-pointed", () => {
  const proof = verifyAnchorObservation(EXPECTED, observation());
  assert.ok(isAnchorVerificationProof(proof));

  // The commitment captured at verification time is exactly what was expected.
  assert.deepEqual(proof.facts.commitment, {
    chainId: EXPECTED.chainId,
    registryAddress: EXPECTED.registryAddress.toLowerCase(),
    evidenceId: EXPECTED.evidenceId.toLowerCase(),
    payloadHash: EXPECTED.payloadHash.toLowerCase(),
    evidenceKind: EXPECTED.evidenceKind,
    sequence: EXPECTED.sequence,
    previousPayloadHash: EXPECTED.previousPayloadHash.toLowerCase(),
  });

  // And it is frozen, so a caller cannot rewrite it to point at another record.
  assert.throws(() => {
    (proof.facts.commitment as { evidenceId: string }).evidenceId =
      `0x${"ff".repeat(32)}`;
  }, /read only|Cannot assign/i);
  assert.equal(
    proof.facts.commitment.evidenceId,
    EXPECTED.evidenceId.toLowerCase(),
  );
});
