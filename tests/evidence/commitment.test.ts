import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  keccak256,
  solidityPackedKeccak256,
  toUtf8Bytes,
} from "ethers";
import type { RouteCandidate } from "../../src/lib/models";
import { quote } from "../../src/lib/quotes";
import {
  buildRouteDecisionCommitment,
  DOMAIN_HASHES,
  EvidenceCommitmentValidationError,
  payloadHash,
  routeHash,
  type CanonicalRouteId,
  type RouteDecisionCommitmentInput,
} from "../../src/server/evidence/commitment";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const ZERO = `0x${"00".repeat(32)}`;
const VECTOR_1_PAYLOAD =
  "0x2869f332484338b67f38eec00bf504f2b20333100d78054bfad729133cb51c1c";

type Vector = {
  name: string;
  fundingMinor: string;
  expiresAtUnixMs: string;
  evidenceId: string;
  sequence: string;
  selectedRouteId: CanonicalRouteId;
  previousPayloadHash: string;
  salt: string;
  routes: readonly RouteCandidate[];
  routeHashes: {
    direct: string;
    split: string;
    multi: string;
  };
  routesHash: string;
  quoteSnapshotHash: string;
  payloadHash: string;
};

function route(
  id: CanonicalRouteId,
  feeBps: number,
  slippageBps: number,
  feeMinor: string,
  outputMinor: string,
  minimumOutputMinor: string,
): RouteCandidate {
  return {
    id,
    name: id,
    feeBps,
    slippageBps,
    toleranceBps: 50,
    feeMinor,
    outputMinor,
    minimumOutputMinor,
  };
}

const VECTOR_1: Vector = {
  name: "vector 1",
  fundingMinor: "2500000",
  expiresAtUnixMs: "1803859140000",
  evidenceId: `0x${"00".repeat(31)}01`,
  sequence: "1",
  selectedRouteId: "direct",
  previousPayloadHash: ZERO,
  salt: `0x${"aa".repeat(32)}`,
  routes: [
    route("direct", 35, 5, "1667", "474523", "472150"),
    route("split", 48, 8, "2286", "473904", "471534"),
    route("multi", 65, 12, "3095", "473095", "470729"),
  ],
  routeHashes: {
    direct:
      "0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5",
    split: "0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8",
    multi: "0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee",
  },
  routesHash:
    "0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c",
  quoteSnapshotHash:
    "0xb693b1782cabfe3e00a58212fc4ce0a2e16908c8739c095824b68e3a7c463d74",
  payloadHash: VECTOR_1_PAYLOAD,
};

const VECTOR_2: Vector = {
  name: "vector 2",
  fundingMinor: "2500001",
  expiresAtUnixMs: "1803859200123",
  evidenceId: `0x${"22".repeat(32)}`,
  sequence: "1",
  selectedRouteId: "split",
  previousPayloadHash: ZERO,
  salt: `0x${"bb".repeat(32)}`,
  routes: [
    route("direct", 35, 5, "1667", "474523", "472150"),
    route("split", 48, 8, "2286", "473904", "471534"),
    route("multi", 65, 12, "3095", "473095", "470729"),
  ],
  routeHashes: {
    direct:
      "0xe85d2a8ca64bc1f3ad17af15cdbf9ecbafd6b6e0dbcc0204c88dff4c053c49c5",
    split: "0x14cc28efa0b0a5ef475291933e00fd4df57799b4df4e17f8e708d30cf39b85a8",
    multi: "0x3228aca2f7a5eff947fbb4f3eb26ba1c10040af08fc55334e0d0e79d746988ee",
  },
  routesHash:
    "0x572b1d298236efd97ab0458241c3f4c7b578adfe82f2da378b95af510a92fc2c",
  quoteSnapshotHash:
    "0x8c41b320380c228d5172f13864bd36d7e61e23b2e9e068d64f2de2623fed8252",
  payloadHash:
    "0x5f0541d836de3041127cb8d933d3d595281528a1c7185127a4680a0cc1339700",
};

const VECTOR_3: Vector = {
  name: "vector 3",
  fundingMinor: "5000000",
  expiresAtUnixMs: "1803945600456",
  evidenceId: `0x${"00".repeat(31)}01`,
  sequence: "2",
  selectedRouteId: "multi",
  previousPayloadHash: VECTOR_1_PAYLOAD,
  salt: `0x${"cc".repeat(32)}`,
  routes: [
    route("direct", 35, 5, "3333", "949047", "944301"),
    route("split", 48, 8, "4571", "947809", "943069"),
    route("multi", 65, 12, "6190", "946190", "941459"),
  ],
  routeHashes: {
    direct:
      "0x93c38546f39e37643579eeb4bea6696304e51afd603dcd30c02683cf9299e31c",
    split: "0x96517268d767325dae3a17bc3c64b9abc818d659dd927f23e604d02a28a17544",
    multi: "0x837ee60fa02a13f7f993699443908818d270e94adb32309d1a894991d0db8fab",
  },
  routesHash:
    "0x5e5dfc0a0e07390bbdb27f48ea7d19ba202df8bb153d9882a9cbb9da2a7bad20",
  quoteSnapshotHash:
    "0x5dd4937b035ce91a24c6d484b708f2755a8378953b84630dcf3c36cc5a11be8f",
  payloadHash:
    "0xb234a077908740c190f26a2af9f83a47f832fe4008daef1ed8a9749a59eb05c7",
};

function inputFor(vector: Vector): RouteDecisionCommitmentInput {
  return {
    invoice: {
      fundingCurrency: "BRL",
      fundingMinor: vector.fundingMinor,
    },
    quoteRow: {
      source: "simulation-fixed-525",
      simulated: true,
      expires_at: vector.expiresAtUnixMs,
      data: {
        fundingMinor: vector.fundingMinor,
        asset: "USDG",
        demoAssetDecimals: 2,
        rate: { numerator: "525", denominator: "100" },
        executionCostMinor: "2",
        simulated: true,
        routes: vector.routes.map((candidate) => ({ ...candidate })),
      },
    },
    registry: REGISTRY,
    evidenceId: vector.evidenceId,
    sequence: vector.sequence,
    selectedRouteId: vector.selectedRouteId,
    previousPayloadHash: vector.previousPayloadHash,
    salt: vector.salt,
  };
}

function validationError(error: unknown): boolean {
  return error instanceof EvidenceCommitmentValidationError;
}

test("derives every frozen domain and label hash from exact UTF-8 literals", () => {
  const expected = {
    route: [
      "PONTE_SIMULATED_ROUTE_V1",
      "0xfc0c08e07f015619f760ffd85ef8f672e611ba6e80af7148cf14f8b5058db94d",
    ],
    routes: [
      "PONTE_SIMULATED_ROUTES_V1",
      "0xc7f109716592d2a66ecf48b3fa7705a566b35e83cc67b77dc3644bf479304fdf",
    ],
    quote: [
      "PONTE_SIMULATED_QUOTE_SNAPSHOT_V1",
      "0x263723f595ee5d8bf1972157c8b23eae390b79ed6db3c7b6906a2761c7df081c",
    ],
    payload: [
      "PONTE_ROUTE_DECISION_EVIDENCE_V1",
      "0x70b55455e73e74fc79b7486d850ac0e524ac3212aaaa85b19b7dbd3291642287",
    ],
    simulationSource: [
      "simulation-fixed-525",
      "0xd123a8bb572dbb96623878447f6dea644243cc9d6a3d8c8838371a712bd150f1",
    ],
    fundingCurrency: [
      "BRL",
      "0x7bfbac288a9bfb4b6175ad0a3f7a03f7790c6f9b3637924a40742a6a5c41c62b",
    ],
    demoOutputAsset: [
      "USDG",
      "0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea",
    ],
  } as const;

  for (const [key, [literal, hash]] of Object.entries(expected)) {
    assert.equal(keccak256(toUtf8Bytes(literal)), hash);
    assert.equal(DOMAIN_HASHES[key as keyof typeof DOMAIN_HASHES], hash);
  }
});

for (const vector of [VECTOR_1, VECTOR_2, VECTOR_3]) {
  test(`${vector.name} reproduces every frozen route, quote, and payload hash`, () => {
    const input = inputFor(vector);
    const result = buildRouteDecisionCommitment(input);

    assert.deepEqual(result.routeHashes, vector.routeHashes);
    assert.equal(result.routesHash, vector.routesHash);
    assert.equal(result.quoteSnapshotHash, vector.quoteSnapshotHash);
    assert.equal(result.payloadHash, vector.payloadHash);
    assert.equal(
      result.selectedRouteCode,
      { direct: 1, split: 2, multi: 3 }[vector.selectedRouteId],
    );
    assert.equal(input.quoteRow.expires_at, vector.expiresAtUnixMs);
    assert.equal(input.registry, REGISTRY);
    assert.equal(input.evidenceId, vector.evidenceId);
    assert.equal(input.salt, vector.salt);
    assert.equal(input.sequence, vector.sequence);
    assert.equal(input.previousPayloadHash, vector.previousPayloadHash);
  });
}

test("frozen route fields match the existing integer quote fixture", () => {
  for (const vector of [VECTOR_1, VECTOR_2, VECTOR_3]) {
    const calculated = quote({ fundingMinor: vector.fundingMinor });
    assert.deepEqual(
      calculated.routes.map((candidate) => ({
        id: candidate.id,
        feeBps: candidate.feeBps,
        slippageBps: candidate.slippageBps,
        toleranceBps: candidate.toleranceBps,
        feeMinor: candidate.feeMinor,
        outputMinor: candidate.outputMinor,
        minimumOutputMinor: candidate.minimumOutputMinor,
      })),
      vector.routes.map((candidate) => ({
        id: candidate.id,
        feeBps: candidate.feeBps,
        slippageBps: candidate.slippageBps,
        toleranceBps: candidate.toleranceBps,
        feeMinor: candidate.feeMinor,
        outputMinor: candidate.outputMinor,
        minimumOutputMinor: candidate.minimumOutputMinor,
      })),
    );
  }
});

test("commits the exact persisted expiry rather than generating a replacement", () => {
  const vectorInput = inputFor(VECTOR_1);
  const stringExpiry = buildRouteDecisionCommitment(vectorInput);
  assert.equal(stringExpiry.quoteSnapshotHash, VECTOR_1.quoteSnapshotHash);

  const dateExpiry = inputFor(VECTOR_1);
  dateExpiry.quoteRow.expires_at = new Date(1803859140000);
  assert.equal(
    buildRouteDecisionCommitment(dateExpiry).quoteSnapshotHash,
    VECTOR_1.quoteSnapshotHash,
  );

  const changedExpiry = inputFor(VECTOR_1);
  changedExpiry.quoteRow.expires_at = "1803859140001";
  assert.notEqual(
    buildRouteDecisionCommitment(changedExpiry).quoteSnapshotHash,
    VECTOR_1.quoteSnapshotHash,
  );
});

test("vector 3 is a sequence-2 chain from vector 1's payload", () => {
  assert.equal(VECTOR_1.sequence, "1");
  assert.equal(VECTOR_3.sequence, "2");
  assert.equal(VECTOR_3.previousPayloadHash, VECTOR_1.payloadHash);
  assert.equal(
    buildRouteDecisionCommitment(inputFor(VECTOR_3)).payloadHash,
    VECTOR_3.payloadHash,
  );
});

test("rejects missing, duplicate, unknown, and incorrectly ordered routes", () => {
  const missing = inputFor(VECTOR_1);
  missing.quoteRow.data.routes = missing.quoteRow.data.routes.slice(0, 2);
  assert.throws(() => buildRouteDecisionCommitment(missing), validationError);

  const duplicate = inputFor(VECTOR_1);
  duplicate.quoteRow.data.routes = [
    duplicate.quoteRow.data.routes[0],
    duplicate.quoteRow.data.routes[0],
    duplicate.quoteRow.data.routes[2],
  ];
  assert.throws(() => buildRouteDecisionCommitment(duplicate), validationError);

  const unknown = inputFor(VECTOR_1);
  unknown.quoteRow.data.routes = unknown.quoteRow.data.routes.map(
    (candidate) => ({
      ...candidate,
    }),
  );
  unknown.quoteRow.data.routes[1].id = "unknown";
  assert.throws(() => buildRouteDecisionCommitment(unknown), validationError);

  const wrongOrder = inputFor(VECTOR_1);
  wrongOrder.quoteRow.data.routes = [
    wrongOrder.quoteRow.data.routes[1],
    wrongOrder.quoteRow.data.routes[0],
    wrongOrder.quoteRow.data.routes[2],
  ];
  assert.throws(
    () => buildRouteDecisionCommitment(wrongOrder),
    validationError,
  );
});

test("rejects an unsupported selected route without changing canonical quote handling", () => {
  const input = inputFor(VECTOR_1);
  input.selectedRouteId = "unknown" as CanonicalRouteId;
  assert.throws(() => buildRouteDecisionCommitment(input), validationError);
});

test("rejects zero evidence IDs, zero salts, and zero quote hashes", () => {
  const zeroEvidence = inputFor(VECTOR_1);
  zeroEvidence.evidenceId = ZERO;
  assert.throws(
    () => buildRouteDecisionCommitment(zeroEvidence),
    validationError,
  );

  const zeroSalt = inputFor(VECTOR_1);
  zeroSalt.salt = ZERO;
  assert.throws(() => buildRouteDecisionCommitment(zeroSalt), validationError);

  assert.throws(
    () =>
      payloadHash({
        registry: REGISTRY,
        evidenceId: VECTOR_1.evidenceId,
        sequence: "1",
        quoteSnapshotHash: ZERO,
        selectedRouteCode: 1,
        previousPayloadHash: ZERO,
        salt: VECTOR_1.salt,
      }),
    validationError,
  );
});

test("rejects invalid byte widths, addresses, and out-of-range integers", () => {
  const invalidAddress = inputFor(VECTOR_1);
  invalidAddress.registry = "0x1234";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidAddress),
    validationError,
  );

  const invalidBytes32 = inputFor(VECTOR_1);
  invalidBytes32.evidenceId = "0x1234";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidBytes32),
    validationError,
  );

  const invalidPreviousHash = inputFor(VECTOR_1);
  invalidPreviousHash.previousPayloadHash = "0x1234";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidPreviousHash),
    validationError,
  );

  const invalidFee = inputFor(VECTOR_1);
  invalidFee.quoteRow.data.routes[0].feeBps = 65536;
  assert.throws(
    () => buildRouteDecisionCommitment(invalidFee),
    validationError,
  );

  assert.throws(
    () =>
      payloadHash({
        registry: REGISTRY,
        evidenceId: VECTOR_1.evidenceId,
        sequence: "18446744073709551616",
        quoteSnapshotHash: VECTOR_1.quoteSnapshotHash,
        selectedRouteCode: 1,
        previousPayloadHash: ZERO,
        salt: VECTOR_1.salt,
      }),
    validationError,
  );

  assert.throws(
    () =>
      payloadHash({
        registry: REGISTRY,
        evidenceId: VECTOR_1.evidenceId,
        sequence: -1n,
        quoteSnapshotHash: VECTOR_1.quoteSnapshotHash,
        selectedRouteCode: 1,
        previousPayloadHash: ZERO,
        salt: VECTOR_1.salt,
      }),
    validationError,
  );
});

test("uses deterministic standard ABI encoding rather than packed encoding", () => {
  const direct = VECTOR_1.routes[0];
  const canonical = routeHash(direct);
  const packed = solidityPackedKeccak256(
    [
      "bytes32",
      "uint8",
      "uint16",
      "uint16",
      "uint16",
      "uint256",
      "uint256",
      "uint256",
    ],
    [
      DOMAIN_HASHES.route,
      1,
      direct.feeBps,
      direct.slippageBps,
      direct.toleranceBps,
      direct.feeMinor,
      direct.outputMinor,
      direct.minimumOutputMinor,
    ],
  );

  assert.equal(canonical, VECTOR_1.routeHashes.direct);
  assert.notEqual(canonical, packed);

  const encoded = AbiCoder.defaultAbiCoder().encode(
    [
      "bytes32",
      "uint8",
      "uint16",
      "uint16",
      "uint16",
      "uint256",
      "uint256",
      "uint256",
    ],
    [
      DOMAIN_HASHES.route,
      1,
      direct.feeBps,
      direct.slippageBps,
      direct.toleranceBps,
      direct.feeMinor,
      direct.outputMinor,
      direct.minimumOutputMinor,
    ],
  );
  assert.equal(keccak256(encoded), canonical);
});

test("is deterministic and preserves integers above JavaScript's safe-number range", () => {
  const first = buildRouteDecisionCommitment(inputFor(VECTOR_2));
  const second = buildRouteDecisionCommitment(inputFor(VECTOR_2));
  assert.deepEqual(first, second);
  assert.equal("salt" in first, false);
  assert.equal("previousPayloadHash" in first, false);

  const largeSequence = "9007199254740993";
  const nextLargeSequence = "9007199254740994";
  const firstLargeHash = payloadHash({
    registry: REGISTRY,
    evidenceId: VECTOR_1.evidenceId,
    sequence: largeSequence,
    quoteSnapshotHash: VECTOR_1.quoteSnapshotHash,
    selectedRouteCode: 1,
    previousPayloadHash: ZERO,
    salt: VECTOR_1.salt,
  });
  const sameBigintHash = payloadHash({
    registry: REGISTRY,
    evidenceId: VECTOR_1.evidenceId,
    sequence: BigInt(largeSequence),
    quoteSnapshotHash: VECTOR_1.quoteSnapshotHash,
    selectedRouteCode: 1,
    previousPayloadHash: ZERO,
    salt: VECTOR_1.salt,
  });
  const nextLargeHash = payloadHash({
    registry: REGISTRY,
    evidenceId: VECTOR_1.evidenceId,
    sequence: nextLargeSequence,
    quoteSnapshotHash: VECTOR_1.quoteSnapshotHash,
    selectedRouteCode: 1,
    previousPayloadHash: ZERO,
    salt: VECTOR_1.salt,
  });

  assert.equal(firstLargeHash, sameBigintHash);
  assert.notEqual(firstLargeHash, nextLargeHash);
});

test("validates persisted quote-row metadata without expecting quote.source", () => {
  const invalidSource = inputFor(VECTOR_1);
  invalidSource.quoteRow.source = "other-source";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidSource),
    validationError,
  );

  const mismatchedFunding = inputFor(VECTOR_1);
  mismatchedFunding.invoice.fundingMinor = "2500001";
  assert.throws(
    () => buildRouteDecisionCommitment(mismatchedFunding),
    validationError,
  );

  const invalidPersistedSimulation = inputFor(VECTOR_1);
  invalidPersistedSimulation.quoteRow.simulated = false;
  assert.throws(
    () => buildRouteDecisionCommitment(invalidPersistedSimulation),
    validationError,
  );

  const truthyPersistedSimulation = inputFor(VECTOR_1);
  (
    truthyPersistedSimulation.quoteRow as unknown as { simulated: unknown }
  ).simulated = "true";
  assert.throws(
    () => buildRouteDecisionCommitment(truthyPersistedSimulation),
    validationError,
  );

  const invalidQuoteDataSimulation = inputFor(VECTOR_1);
  (
    invalidQuoteDataSimulation.quoteRow.data as unknown as {
      simulated: boolean;
    }
  ).simulated = false;
  assert.throws(
    () => buildRouteDecisionCommitment(invalidQuoteDataSimulation),
    validationError,
  );

  const truthyQuoteDataSimulation = inputFor(VECTOR_1);
  (
    truthyQuoteDataSimulation.quoteRow.data as unknown as {
      simulated: unknown;
    }
  ).simulated = 1;
  assert.throws(
    () => buildRouteDecisionCommitment(truthyQuoteDataSimulation),
    validationError,
  );

  const invalidAsset = inputFor(VECTOR_1);
  (invalidAsset.quoteRow.data as unknown as { asset: string }).asset =
    "NOT_USDG";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidAsset),
    validationError,
  );

  const invalidDemoDecimals = inputFor(VECTOR_1);
  (
    invalidDemoDecimals.quoteRow.data as unknown as {
      demoAssetDecimals: number;
    }
  ).demoAssetDecimals = 3;
  assert.throws(
    () => buildRouteDecisionCommitment(invalidDemoDecimals),
    validationError,
  );

  const invalidRateNumerator = inputFor(VECTOR_1);
  invalidRateNumerator.quoteRow.data.rate.numerator = "524";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidRateNumerator),
    validationError,
  );

  const invalidRateDenominator = inputFor(VECTOR_1);
  invalidRateDenominator.quoteRow.data.rate.denominator = "101";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidRateDenominator),
    validationError,
  );

  const invalidExecutionCost = inputFor(VECTOR_1);
  invalidExecutionCost.quoteRow.data.executionCostMinor = "3";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidExecutionCost),
    validationError,
  );

  const invalidExpiry = inputFor(VECTOR_1);
  invalidExpiry.quoteRow.expires_at = "18446744073709551616";
  assert.throws(
    () => buildRouteDecisionCommitment(invalidExpiry),
    validationError,
  );
});
