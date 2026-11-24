/**
 * Provider-neutral verification of a Registry anchoring claim.
 *
 * This module is deliberately pure: it performs no network request, database
 * query, clock read, random draw, or environment lookup. It takes a chain-reader
 * observation and the persisted evidence commitment, and decides whether that
 * observation proves the specific commitment was anchored.
 *
 * Nothing here is a submission mechanism. Preparing or submitting evidence is a
 * different concern, and a caller-supplied transaction hash is never accepted as
 * proof: the receipt must come from a chain reader the caller did not author.
 */
import { getAddress, id as keccakId } from "ethers";
import type { EvidenceAnchoringStatus } from "../../lib/models";

/** Arbitrum Sepolia. The Registry constructor rejects every other chain. */
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;

/** `EvidenceKind.SimulatedRouteDecision` in the deployed Registry enum. */
export const SIMULATED_ROUTE_DECISION_KIND = 1;

/**
 * Event signature of `PonteRouteDecisionEvidenceRegistry.EvidenceAnchored`.
 * Derived from the contract source rather than copied as a literal so a source
 * change cannot silently desynchronise the decoder.
 */
export const EVIDENCE_ANCHORED_SIGNATURE =
  "EvidenceAnchored(bytes32,bytes32,address,uint64,uint8,bytes32)";

export const EVIDENCE_ANCHORED_TOPIC = keccakId(EVIDENCE_ANCHORED_SIGNATURE);

export type AnchorVerificationFailure =
  | "NO_OBSERVATION"
  | "RECEIPT_MISSING"
  | "TRANSACTION_NOT_FOUND"
  | "RECEIPT_TRANSACTION_MISMATCH"
  | "WRONG_CHAIN"
  | "TRANSACTION_REVERTED"
  | "WRONG_REGISTRY_ADDRESS"
  | "REGISTRY_IDENTITY_UNVERIFIED"
  | "EVENT_MISSING"
  | "EVENT_AMBIGUOUS"
  | "EVENT_MALFORMED"
  | "WRONG_EVIDENCE_ID"
  | "WRONG_PAYLOAD_HASH"
  | "WRONG_EVIDENCE_KIND"
  | "WRONG_SEQUENCE"
  | "WRONG_PREVIOUS_PAYLOAD_HASH"
  | "ATTESTOR_NOT_EVENT_SENDER"
  | "ATTESTOR_MISMATCH"
  | "BLOCK_METADATA_INCONSISTENT";

/**
 * The commitment a verified receipt must reproduce exactly. Every field is a
 * canonical decimal string or 0x-hex string; no value is ever widened to a
 * JavaScript `number`, because `uint64` sequence values and `bytes32` hashes do
 * not survive that conversion.
 */
export interface ExpectedAnchorCommitment {
  /** Persisted `route_decision_evidence.chain_id`. */
  readonly chainId: string;
  /** Configured Registry address for this environment. */
  readonly registryAddress: string;
  /** Persisted `public_evidence_id`. */
  readonly evidenceId: string;
  /** Persisted `payload_hash`. */
  readonly payloadHash: string;
  /** Persisted `evidence_kind`. */
  readonly evidenceKind: number;
  /** Persisted `sequence`, as a decimal string. */
  readonly sequence: string;
  /** Persisted `previous_payload_hash`. */
  readonly previousPayloadHash: string;
}

/** One decoded `EvidenceAnchored` log. */
export interface ObservedAnchorEvent {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/**
 * The chain state a trusted reader observed. A receipt alone is insufficient:
 * the transaction sender is read from the transaction, because `tx.origin` is
 * not in a receipt and the attestor must be proven to have sent the call.
 */
export interface ChainObservation {
  /** Chain the reader is connected to, as a decimal string. */
  readonly chainId: string;
  readonly transactionHash: string;
  readonly transactionFrom: string;
  readonly transactionTo: string | null;
  readonly receipt: {
    readonly transactionHash: string;
    readonly status: "success" | "reverted";
    readonly from: string;
    readonly to: string | null;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly logs: readonly ObservedAnchorEvent[];
  } | null;
  /**
   * Result of the Registry-identity probe (for example `admin()` succeeding and
   * `isAttestor(deployer)` returning false). `null` means the probe was not
   * performed, and verification then refuses to confirm.
   */
  readonly registryIdentity: "verified" | "unverified" | null;
}

/**
 * A trusted chain reader. The eventual production implementation resolves a
 * transaction and its receipt from a real JSON-RPC endpoint. No implementation
 * with network access exists in this phase.
 */
export interface EvidenceChainReader {
  readAnchorObservation(input: {
    readonly transactionHash: string;
    readonly registryAddress: string;
  }): Promise<ChainObservation>;
}

export type AnchorVerificationResult =
  | {
      readonly verified: true;
      readonly status: "verified";
      readonly chainId: string;
      readonly registryAddress: string;
      readonly transactionHash: string;
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly attestor: string;
    }
  | {
      readonly verified: false;
      readonly status: "not_verified";
      readonly failure: AnchorVerificationFailure;
    };

function notVerified(
  failure: AnchorVerificationFailure,
): AnchorVerificationResult {
  return { verified: false, status: "not_verified", failure };
}

/** Canonical lowercase 0x-address, or `null` when the input is not an address. */
function canonicalAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    return null;
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

/** Lowercase 0x-hex bytes32, or `null`. */
function canonicalBytes32(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    return null;
  return value.toLowerCase();
}

/**
 * Canonical non-negative integer decimal, or `null`. Leading zeros, a sign, an
 * exponent, a decimal point, empty input, and anything beyond `max` are all
 * rejected, so two equal quantities cannot compare unequal.
 */
function canonicalDecimal(value: unknown, max?: bigint): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  const parsed = BigInt(value);
  if (max !== undefined && parsed > max) return null;
  return parsed.toString();
}

const UINT64_MAX = 18446744073709551615n;

/** A single decoded `EvidenceAnchored` payload. */
export interface DecodedAnchorEvent {
  readonly evidenceId: string;
  readonly payloadHash: string;
  readonly attestor: string;
  readonly sequence: string;
  readonly kind: number;
  readonly previousPayloadHash: string;
}

/**
 * Decodes exactly one `EvidenceAnchored` log. Returns `null` when the log is not
 * that event or is malformed; the caller distinguishes the two by topic.
 *
 * Layout: three indexed words become topics 1-3 (evidenceId, payloadHash,
 * attestor). The three non-indexed values are ABI-encoded into `data` as three
 * full 32-byte words: `sequence` (uint64, left-padded), `kind` (enum, left-
 * padded) and `previousPayloadHash` (bytes32). `data` is therefore exactly
 * 96 bytes, i.e. `0x` plus 192 hex characters.
 */
export function decodeEvidenceAnchored(
  event: ObservedAnchorEvent,
): DecodedAnchorEvent | null {
  if (event.topics.length !== 4) return null;
  if (event.topics[0].toLowerCase() !== EVIDENCE_ANCHORED_TOPIC) return null;

  const evidenceId = canonicalBytes32(event.topics[1]);
  const payloadHash = canonicalBytes32(event.topics[2]);
  const attestorRaw = event.topics[3];
  // The third indexed word is a left-padded address.
  if (!attestorRaw || !/^0x0{24}[0-9a-fA-F]{40}$/.test(attestorRaw))
    return null;
  const attestor = canonicalAddress(`0x${attestorRaw.slice(26)}`);
  if (!evidenceId || !payloadHash || !attestor) return null;

  const data = event.data.toLowerCase();
  // sequence (uint64) | kind (uint8) | previousPayloadHash (bytes32)
  if (!/^0x[0-9a-f]{192}$/.test(data)) return null;

  const sequenceWord = data.slice(2, 66);
  const kindWord = data.slice(66, 130);
  const previousPayloadHash = `0x${data.slice(130, 194)}`;

  if (!/^0{48}[0-9a-f]{16}$/.test(sequenceWord)) return null;
  if (!/^0{62}[0-9a-f]{2}$/.test(kindWord)) return null;

  const sequence = BigInt(`0x${sequenceWord.slice(48)}`);
  if (sequence > UINT64_MAX) return null;
  const kind = Number.parseInt(kindWord.slice(62), 16);

  return {
    evidenceId,
    payloadHash,
    attestor,
    sequence: sequence.toString(),
    kind,
    previousPayloadHash,
  };
}

/**
 * Decides whether an observation proves `expected` was anchored.
 *
 * Order matters for a useful failure reason but not for safety: every branch
 * below either returns `verified: true` or a `not_verified` failure, and there is
 * no path that returns `verified: true` without a successful receipt, a matching
 * destination, a matching chain, a matching Registry identity and an exact event
 * match on all six fields.
 */
export function verifyAnchorObservation(
  expected: ExpectedAnchorCommitment,
  observation: ChainObservation | null,
): AnchorVerificationResult {
  if (!observation) return notVerified("NO_OBSERVATION");

  const expectedChain = canonicalDecimal(expected.chainId);
  const expectedRegistry = canonicalAddress(expected.registryAddress);
  const expectedEvidenceId = canonicalBytes32(expected.evidenceId);
  const expectedPayloadHash = canonicalBytes32(expected.payloadHash);
  const expectedPrevious = canonicalBytes32(expected.previousPayloadHash);
  const expectedSequence = canonicalDecimal(expected.sequence, UINT64_MAX);
  if (
    !expectedChain ||
    !expectedRegistry ||
    !expectedEvidenceId ||
    !expectedPayloadHash ||
    !expectedPrevious ||
    expectedSequence === null
  )
    return notVerified("EVENT_MALFORMED");

  const observedChain = canonicalDecimal(observation.chainId);
  if (observedChain === null) return notVerified("WRONG_CHAIN");
  if (observedChain !== ARBITRUM_SEPOLIA_CHAIN_ID.toString())
    return notVerified("WRONG_CHAIN");
  if (observedChain !== expectedChain) return notVerified("WRONG_CHAIN");

  if (observation.registryIdentity !== "verified")
    return notVerified("REGISTRY_IDENTITY_UNVERIFIED");

  if (!observation.receipt) return notVerified("RECEIPT_MISSING");
  const receipt = observation.receipt;

  const transactionHash = canonicalBytes32(observation.transactionHash);
  if (!transactionHash) return notVerified("TRANSACTION_NOT_FOUND");
  // The receipt must describe the same transaction that was requested; otherwise
  // a reader could answer with an unrelated but individually valid receipt.
  if (canonicalBytes32(receipt.transactionHash) !== transactionHash)
    return notVerified("RECEIPT_TRANSACTION_MISMATCH");

  if (receipt.status !== "success") return notVerified("TRANSACTION_REVERTED");

  const receiptTo = canonicalAddress(receipt.to);
  if (receiptTo === null || receiptTo !== expectedRegistry)
    return notVerified("WRONG_REGISTRY_ADDRESS");

  const transactionTo = canonicalAddress(observation.transactionTo);
  if (transactionTo === null || transactionTo !== expectedRegistry)
    return notVerified("WRONG_REGISTRY_ADDRESS");

  const transactionFrom = canonicalAddress(observation.transactionFrom);
  if (transactionFrom === null) return notVerified("ATTESTOR_MISMATCH");

  const matches = receipt.logs.filter(
    (log) =>
      canonicalAddress(log.address) === expectedRegistry &&
      log.topics.length > 0 &&
      log.topics[0].toLowerCase() === EVIDENCE_ANCHORED_TOPIC,
  );
  if (matches.length === 0) return notVerified("EVENT_MISSING");
  if (matches.length > 1) return notVerified("EVENT_AMBIGUOUS");

  const decoded = decodeEvidenceAnchored(matches[0]);
  if (!decoded) return notVerified("EVENT_MALFORMED");

  if (decoded.evidenceId !== expectedEvidenceId)
    return notVerified("WRONG_EVIDENCE_ID");
  if (decoded.payloadHash !== expectedPayloadHash)
    return notVerified("WRONG_PAYLOAD_HASH");
  // `kind` is validated before field comparison so an unexpected enum value can
  // never fall through to a later, less specific failure.
  if (decoded.kind !== SIMULATED_ROUTE_DECISION_KIND)
    return notVerified("WRONG_EVIDENCE_KIND");
  if (decoded.kind !== expected.evidenceKind)
    return notVerified("WRONG_EVIDENCE_KIND");
  if (decoded.sequence !== expectedSequence)
    return notVerified("WRONG_SEQUENCE");
  if (decoded.previousPayloadHash !== expectedPrevious)
    return notVerified("WRONG_PREVIOUS_PAYLOAD_HASH");

  // The attestor recorded in the event must be the account that actually sent
  // the transaction. A revoked-then-restored attestor is irrelevant here: this
  // proves authorship of a historical transaction, not present-day authority.
  if (decoded.attestor !== transactionFrom)
    return notVerified("ATTESTOR_NOT_EVENT_SENDER");
  if (canonicalAddress(receipt.from) !== transactionFrom)
    return notVerified("ATTESTOR_NOT_EVENT_SENDER");

  const blockNumber = canonicalDecimal(receipt.blockNumber);
  const blockHash = canonicalBytes32(receipt.blockHash);
  if (!blockNumber || !blockHash)
    return notVerified("BLOCK_METADATA_INCONSISTENT");

  return {
    verified: true,
    status: "verified",
    chainId: observedChain,
    registryAddress: expectedRegistry,
    transactionHash,
    blockNumber,
    blockHash,
    attestor: decoded.attestor,
  };
}

/**
 * Presentation guard. The status projection must derive its anchoring claim
 * from this function, so an outbox row cannot render as anchored on its own.
 */
export function anchoringStatusFor(
  result: AnchorVerificationResult | null,
): EvidenceAnchoringStatus {
  if (!result || !result.verified)
    return { verified: false, status: "not_verified" };
  return {
    verified: true,
    status: "verified",
    chainId: result.chainId,
    registryAddress: result.registryAddress,
    transactionHash: result.transactionHash,
    blockNumber: result.blockNumber,
    blockHash: result.blockHash,
    attestor: result.attestor,
  };
}
