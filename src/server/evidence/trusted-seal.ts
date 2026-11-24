/**
 * The trusted-observation seal (Phase 2C.2A).
 *
 * Prior to this module there was one gate: `evaluateAnchorObservation` minted an
 * `AnchorEvaluationProof` from any caller-supplied `ChainObservation`. That made
 * the proof a statement about the *check having run*, never about where the
 * observation came from.
 *
 * This module adds the missing second gate. A reader that acquired its observation
 * from the configured JSON-RPC transport seals it here; the confirmation boundary
 * then requires **both** a genuine verification proof and a genuine seal. The two
 * gates are branded the same way and for the same reason: an ECMAScript private
 * field plus a module-private `WeakSet`, so a plain object, a spread copy, a JSON
 * round-trip or a `structuredClone` imitations are all rejected at runtime.
 *
 * Only `trusted-reader.ts` calls `sealTrustedObservation` in production. The seal
 * is not exported through any module that an API route can reach, and no
 * environment variable, feature flag or request field can produce one.
 */

import "server-only";

import {
  isAnchorEvaluationProof,
  type AnchorEvaluationProof,
} from "./anchor-verification";
import type {
  FinalityEvidence,
  TrustedObservedAnchor,
} from "./trusted-observation";

/** The only values that may occupy a seal. */
export interface SealedObservationFields {
  readonly observation: TrustedObservedAnchor["observation"];
  readonly finality: FinalityEvidence;
  readonly runtimeBytecodeHash: string;
  readonly registryAddress: string;
  readonly transactionHash: string;
}

const SEAL_PRIVATE = Symbol.for("ponte.trusted-observation.seal.v1");

/**
 * A sealed observation. The private field is unreachable from outside this module,
 * and `SEALED` records the instance so a prototype-cloned object is rejected.
 */
class TrustedObservationSeal implements TrustedObservedAnchor {
  readonly #token: symbol;

  private constructor(readonly fields: SealedObservationFields) {
    this.#token = SEAL_PRIVATE;
  }

  /** @internal Constructed only by `sealTrustedObservation`. */
  static create(fields: SealedObservationFields): TrustedObservationSeal {
    // Freeze the instance itself: freezing the field bag alone would leave the
    // wrapper mutable. The cast preserves the private field in the return type,
    // which `Object.freeze` erases.
    const seal = new TrustedObservationSeal(Object.freeze({ ...fields }));
    return Object.freeze(seal) as TrustedObservationSeal;
  }

  get observation(): TrustedObservedAnchor["observation"] {
    return this.fields.observation;
  }

  get finality(): FinalityEvidence {
    return this.fields.finality;
  }

  get runtimeBytecodeHash(): string {
    return this.fields.runtimeBytecodeHash;
  }

  get registryAddress(): string {
    return this.fields.registryAddress;
  }

  get transactionHash(): string {
    return this.fields.transactionHash;
  }

  /** @internal True only for instances this class constructed. */
  owns(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as TrustedObservationSeal).#token === SEAL_PRIVATE
    );
  }
}

/** Module-private registry of seals actually issued by `sealTrustedObservation`. */
const SEALED = new WeakSet<object>();

/** True when `value` is a seal this module issued, not a look-alike. */
export function isTrustedObservedAnchor(
  value: unknown,
): value is TrustedObservationSeal {
  if (!(value instanceof TrustedObservationSeal)) return false;
  return SEALED.has(value) && value.owns(value);
}

/**
 * Issues the seal.
 *
 * @internal Called by `trusted-reader.ts` after the transport has produced a
 * fully validated observation and the finality/identity checks have passed. It is
 * exported because that module lives in a different file, not because application
 * code should call it. Nothing reachable from an HTTP handler imports it.
 *
 * The guard below is deliberately runtime, not merely conventional: it refuses to
 * seal unless the observation carries the reader's own verified Registry identity,
 * so a caller that somehow obtained this function still cannot seal a fabricated
 * observation without also forging an identity the reader already established.
 */
export function sealTrustedObservation(
  fields: SealedObservationFields,
): TrustedObservationSeal {
  if (fields.observation.registryIdentity !== "verified")
    throw new Error("TRUSTED_SEAL_REQUIRES_VERIFIED_REGISTRY_IDENTITY");
  if (fields.finality.level !== "finalized")
    throw new Error("TRUSTED_SEAL_REQUIRES_FINALIZED_LEVEL");
  const seal = TrustedObservationSeal.create(fields);
  SEALED.add(seal);
  return seal;
}

/**
 * The object a confirmation boundary needs: a verification proof that the pure
 * evaluator issued **and** the seal that vouches for its observation.
 *
 * `evaluateAnchorObservation` mints the proof; this type only records that both
 * gates passed together. It is constructed by `trusted-verification.ts`.
 */
export interface TrustedAnchorVerification {
  readonly verified: true;
  readonly status: "verified";
  readonly proof: AnchorEvaluationProof;
  readonly seal: TrustedObservationSeal;
}

const TRUSTED_RESULTS = new WeakSet<object>();

/** @internal True only for results built by `createTrustedAnchorVerification`. */
export function createTrustedAnchorVerification(
  proof: AnchorEvaluationProof,
  seal: TrustedObservationSeal,
): TrustedAnchorVerification {
  const result = Object.freeze({
    verified: true as const,
    status: "verified" as const,
    proof,
    seal,
  });
  TRUSTED_RESULTS.add(result);
  return result;
}

/** True when `value` is a trusted verification result this module issued. */
export function isTrustedAnchorVerification(
  value: unknown,
): value is TrustedAnchorVerification {
  if (typeof value !== "object" || value === null) return false;
  if (!TRUSTED_RESULTS.has(value)) return false;
  const candidate = value as TrustedAnchorVerification;
  return (
    isAnchorEvaluationProof(candidate.proof) &&
    isTrustedObservedAnchor(candidate.seal)
  );
}
