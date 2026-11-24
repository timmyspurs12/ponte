/**
 * The closed trusted-authorization boundary (Phase 2C.2A, review pass 1).
 *
 * ## The rule this module exists to enforce
 *
 * A confirmation-authorizing result may exist only as the output of a complete
 * trusted-reader acquisition. An earlier revision exported `sealTrustedObservation`
 * and `createTrustedAnchorVerification`, which meant any module could import a
 * helper and manufacture authority from fabricated inputs. JSDoc `@internal` is not
 * a security control, so those exports are gone.
 *
 * Everything capable of minting authorization is **module-private**:
 *
 * - `SEALED`, `TRUSTED_RESULTS` — private `WeakSet`s;
 * - `TrustedObservationSeal` — an unexported class;
 * - `issueSeal`, `issueTrustedVerification` — unexported functions.
 *
 * A non-exported binding in an ES module is unreachable from other modules. That is
 * the strongest closure available inside one Node process, and it is a runtime
 * property rather than a naming convention.
 *
 * The only exported entry point that authorizes is `runTrustedVerification`, which
 * needs a reader built from an operator-branded configuration.
 */

import "server-only";

import {
  evaluateAnchorObservation,
  isAnchorEvaluationProof,
  type AnchorEvaluationProof,
  type AnchorNotVerified,
  type ChainObservation,
  type ExpectedAnchorCommitment,
} from "./anchor-verification";
import type {
  FinalityEvidence,
  TrustedObservedAnchor,
} from "./trusted-observation";
import type { TrustedReaderFailure } from "./trusted-reader";
import { acquireForVerification } from "./trusted-reader";

/**
 * The fourteen values a trusted result is bound to.
 *
 * `confirmVerifiedAnchor` re-derives this from the proof and the seal's own
 * observation, then compares it field by field against the stored binding. If one
 * field differs, the result authorizes nothing.
 */
export interface TrustedBinding {
  readonly transactionHash: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly evidenceId: string;
  readonly payloadHash: string;
  readonly evidenceKind: number;
  readonly sequence: string;
  readonly previousPayloadHash: string;
  readonly receiptBlockNumber: string;
  readonly receiptBlockHash: string;
  readonly attestor: string;
  readonly finalizedBlockNumber: string;
  readonly finalizedBlockHash: string;
  readonly runtimeBytecodeHash: string;
}

/** The raw acquisition data a seal is built from, before any proof is considered. */
interface Acquisition {
  readonly observation: ChainObservation;
  readonly finality: FinalityEvidence;
  readonly runtimeBytecodeHash: string;
  readonly registryAddress: string;
  readonly transactionHash: string;
}

/**
 * Canonical form of a transaction hash, or `null` when it is not a usable 32-byte
 * value. Lowercased so the same hash written two ways compares equal, and rejects the
 * zero hash because no transaction can have it.
 */
function canonicalTransactionHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lowered)) return null;
  return lowered === `0x${"0".repeat(64)}` ? null : lowered;
}

/** Recursively freezes an object graph so later mutation cannot change meaning. */
function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return value;
}

/**
 * A defensive, deeply frozen copy of an observation.
 *
 * The copy is taken at issuance time, so a caller that keeps a reference to the
 * observation it passed to the reader cannot mutate what the seal represents
 * afterwards. Every nested array (logs, topics) is copied, not shared.
 */
function copyObservation(observation: ChainObservation): ChainObservation {
  const receipt = observation.receipt;
  const logs = receipt
    ? receipt.logs.map((log) =>
        deepFreeze({
          address: log.address,
          topics: Object.freeze([...log.topics]) as readonly string[],
          data: log.data,
        }),
      )
    : [];
  return deepFreeze({
    chainId: observation.chainId,
    transactionHash: observation.transactionHash,
    transactionFrom: observation.transactionFrom,
    transactionTo: observation.transactionTo,
    receipt: receipt
      ? {
          transactionHash: receipt.transactionHash,
          status: receipt.status,
          from: receipt.from,
          to: receipt.to,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          logs: Object.freeze(logs) as readonly never[],
        }
      : null,
    registryIdentity: observation.registryIdentity,
  }) as ChainObservation;
}

/**
 * The seal. Unexported class, module-private WeakSet, private field — so a
 * structural look-alike is rejected at runtime, not merely by the type checker.
 */
class TrustedObservationSeal implements TrustedObservedAnchor {
  readonly #token: symbol;

  constructor(
    readonly observation: ChainObservation,
    readonly finality: FinalityEvidence,
    readonly runtimeBytecodeHash: string,
    readonly registryAddress: string,
    readonly transactionHash: string,
    readonly binding: TrustedBinding,
  ) {
    this.#token = SEAL_PRIVATE;
  }

  /** True only for instances constructed in this module. */
  owns(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as TrustedObservationSeal).#token === SEAL_PRIVATE
    );
  }
}

const SEAL_PRIVATE = Symbol.for("ponte.trusted-observation.seal.v2");
const SEALED = new WeakSet<object>();
const TRUSTED_RESULTS = new WeakSet<object>();

/** True when `value` is a seal issued by this module. */
export function isTrustedObservedAnchor(
  value: unknown,
): value is TrustedObservedAnchor {
  return (
    value instanceof TrustedObservationSeal &&
    SEALED.has(value) &&
    value.owns(value)
  );
}

/**
 * Derives the binding from a proof and raw acquisition data, requiring them to
 * describe the same transaction, chain, contract, evidence record and block.
 *
 * Returns `null` if any corresponding field disagrees. This is the single place
 * where "the proof" and "the seal" are proven to be about the same thing.
 */
function bindProofToAcquisition(
  proof: AnchorEvaluationProof | null,
  acquisition: Acquisition,
): TrustedBinding | null {
  if (!proof) return null;
  const facts = proof.facts;
  const receipt = acquisition.observation.receipt;
  if (!receipt) return null;
  const commitment = facts.commitment;

  const observationsAgree =
    acquisition.observation.transactionHash === facts.transactionHash &&
    receipt.transactionHash === facts.transactionHash &&
    acquisition.registryAddress === facts.registryAddress &&
    receipt.to === facts.registryAddress &&
    acquisition.observation.chainId === facts.chainId &&
    receipt.blockNumber === facts.blockNumber &&
    receipt.blockHash === facts.blockHash &&
    acquisition.finality.receiptBlockNumber === facts.blockNumber &&
    acquisition.finality.receiptBlockHash === facts.blockHash &&
    commitment.chainId === facts.chainId &&
    commitment.registryAddress === facts.registryAddress &&
    acquisition.finality.level === "finalized";
  if (!observationsAgree) return null;

  return deepFreeze({
    transactionHash: facts.transactionHash,
    chainId: facts.chainId,
    registryAddress: facts.registryAddress,
    evidenceId: commitment.evidenceId,
    payloadHash: commitment.payloadHash,
    evidenceKind: commitment.evidenceKind,
    sequence: commitment.sequence,
    previousPayloadHash: commitment.previousPayloadHash,
    receiptBlockNumber: acquisition.finality.receiptBlockNumber,
    receiptBlockHash: acquisition.finality.receiptBlockHash,
    attestor: facts.attestor,
    finalizedBlockNumber: acquisition.finality.finalizedBlockNumber,
    finalizedBlockHash: acquisition.finality.finalizedBlockHash,
    runtimeBytecodeHash: acquisition.runtimeBytecodeHash,
  });
}

/** Issues a seal. Unexported: reachable only from `runTrustedVerification`. */
function issueSeal(
  acquisition: Acquisition,
  binding: TrustedBinding,
): TrustedObservationSeal {
  const seal = new TrustedObservationSeal(
    copyObservation(acquisition.observation),
    deepFreeze({ ...acquisition.finality }),
    acquisition.runtimeBytecodeHash,
    acquisition.registryAddress,
    acquisition.transactionHash,
    binding,
  );
  SEALED.add(seal);
  return deepFreeze(seal);
}

/** The authorization object a confirmation boundary consumes. */
export interface TrustedAnchorVerification {
  readonly verified: true;
  readonly status: "verified";
  readonly proof: AnchorEvaluationProof;
  readonly seal: TrustedObservedAnchor;
  readonly binding: TrustedBinding;
}

/** Unexported issuance. The only write to `TRUSTED_RESULTS`. */
function issueTrustedVerification(
  proof: AnchorEvaluationProof,
  seal: TrustedObservationSeal,
): TrustedAnchorVerification {
  const result: TrustedAnchorVerification = deepFreeze({
    verified: true as const,
    status: "verified" as const,
    proof,
    seal,
    binding: seal.binding,
  });
  TRUSTED_RESULTS.add(result);
  return result;
}

/** True when `value` is an authorization result this module issued. */
export function isTrustedAnchorVerification(
  value: unknown,
): value is TrustedAnchorVerification {
  if (typeof value !== "object" || value === null) return false;
  if (!TRUSTED_RESULTS.has(value)) return false;
  const candidate = value as TrustedAnchorVerification;
  return (
    isAnchorEvaluationProof(candidate.proof) &&
    isTrustedObservedAnchor(candidate.seal) &&
    typeof candidate.binding === "object" &&
    candidate.binding !== null
  );
}

/**
 * Re-derives the binding for a result and returns it only if it still equals the
 * binding recorded at issuance.
 *
 * The confirmation boundary uses this instead of reading `result.binding`
 * directly, so a mutated nested observation cannot silently change meaning.
 */
export function rebindTrustedResult(
  result: TrustedAnchorVerification,
): TrustedBinding | null {
  if (!isTrustedAnchorVerification(result)) return null;
  const seal = result.seal as TrustedObservationSeal;
  const derived = bindProofToAcquisition(result.proof, {
    observation: seal.observation,
    finality: seal.finality,
    runtimeBytecodeHash: seal.runtimeBytecodeHash,
    registryAddress: seal.registryAddress,
    transactionHash: seal.transactionHash,
  });
  if (!derived) return null;
  for (const key of Object.keys(result.binding) as (keyof TrustedBinding)[]) {
    if (derived[key] !== result.binding[key]) return null;
  }
  return derived;
}

// ---------------------------------------------------------------------------
// The pipeline: the only exported issuance entry point
// ---------------------------------------------------------------------------

export type TrustedPipelineFailure =
  | TrustedReaderFailure
  | "EVALUATION_REJECTED"
  /** The supplied reader did not carry this codebase's capability, or was test-scoped. */
  | "READER_NOT_TRUSTED"
  /** The requested transaction hash was malformed. */
  | "TRANSACTION_HASH_MALFORMED"
  /** The reader answered about a different transaction than the one requested. */
  | "TRANSACTION_MISMATCH"
  | "REGISTRY_ADDRESS_MISMATCH";

export type TrustedPipelineOutcome =
  | { readonly ok: true; readonly result: TrustedAnchorVerification }
  | {
      readonly ok: false;
      readonly failure: TrustedPipelineFailure;
      readonly evaluationFailure?: AnchorNotVerified["failure"];
    };

/**
 * Acquires, evaluates, binds and issues.
 *
 * `reader` must be a `TrustedEvidenceChainReader` that this codebase constructed from a
 * branded configuration. The check is **not** a private-field access and not an
 * `instanceof`: it is a capability lookup inside `trusted-reader.ts`, where a
 * module-private `WeakMap` is keyed by the instance. This function never reads a
 * property from `reader` and never receives an authority-bearing object back, so a
 * structural imitation — object literal, `Object.create`, Proxy, prototype swap, spread
 * copy or cross-realm clone — misses the map and is refused with `READER_NOT_TRUSTED`.
 *
 * A registered reader is still refused unless it is operator-scoped, and no
 * operator-scoped reader can be constructed in this codebase (review pass 3), so this
 * function currently returns `READER_NOT_TRUSTED` for every caller.
 */
export async function runTrustedVerification(
  reader: unknown,
  expected: ExpectedAnchorCommitment,
  transactionHash: string,
): Promise<TrustedPipelineOutcome> {
  // ---- Gate 0: the reader must be one this codebase constructed ----
  //
  // `reader` is deliberately typed `unknown`, and no property of it is read here.
  // The security mechanism is a capability lookup inside `trusted-reader.ts`: a
  // module-private `WeakMap` keyed by the instance. Review pass 2 showed that a plain
  // object with a plausible shape could drive the whole pipeline, and review pass 3
  // showed that *returning* the registry entry let a caller mutate its authority. The
  // entry is now never returned. `acquireForVerification` performs the lookup, checks
  // scope against the private record, invokes the closure, and hands back a result.
  //
  // Nothing here inspects a caller-supplied field or private brand: an imitation —
  // object literal, `Object.create`, Proxy, prototype swap or spread copy — misses the
  // map entirely.
  const requested = canonicalTransactionHash(transactionHash);
  if (!requested) return { ok: false, failure: "TRANSACTION_HASH_MALFORMED" };

  let acquired;
  try {
    // The registry comparison happens inside the boundary, before any I/O, so a
    // mismatched commitment never causes a network call and the pinned value is never
    // handed out for the caller to compare.
    acquired = await acquireForVerification(reader, {
      transactionHash: requested,
      expectedRegistryAddress: expected.registryAddress,
    });
  } catch {
    return { ok: false, failure: "RPC_UNAVAILABLE" };
  }
  // `READER_NOT_TRUSTED` here covers both an unregistered candidate and a registered
  // test-scoped reader; the distinction is deliberately not exposed to the caller.
  if (!acquired.ok) return { ok: false, failure: acquired.failure as TrustedReaderFailure };

  // The reader must answer about the transaction that was requested. This is checked
  // independently of the reader's own internal checks, because the pipeline must not
  // assume they exist.
  const observedHash = canonicalTransactionHash(acquired.observation.transactionHash);
  if (!observedHash || observedHash !== requested)
    return { ok: false, failure: "TRANSACTION_MISMATCH" };
  // The receipt must name the same transaction, not merely a plausible one.
  const receiptHash = canonicalTransactionHash(
    acquired.observation.receipt?.transactionHash ?? "",
  );
  if (!receiptHash || receiptHash !== requested)
    return { ok: false, failure: "TRANSACTION_MISMATCH" };

  // The seal's registry address is the pinned one the reader used, never a value
  // taken from the observation it just returned.
  const acquisition: Acquisition = {
    observation: acquired.observation,
    finality: acquired.finality,
    runtimeBytecodeHash: acquired.runtimeBytecodeHash,
    registryAddress: acquired.pinnedRegistryAddress,
    transactionHash: requested,
  };

  const evaluated = evaluateAnchorObservation(expected, acquisition.observation);
  if (!isAnchorEvaluationProof(evaluated)) {
    return {
      ok: false,
      failure: "EVALUATION_REJECTED",
      evaluationFailure: (evaluated as AnchorNotVerified).failure,
    };
  }

  const binding = bindProofToAcquisition(evaluated, acquisition);
  if (!binding) return { ok: false, failure: "EVALUATION_REJECTED" };

  const seal = issueSeal(acquisition, binding);
  return { ok: true, result: issueTrustedVerification(evaluated, seal) };
}
