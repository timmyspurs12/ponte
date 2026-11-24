/**
 * Trusted-reader observation types for Phase 2C.2A.
 *
 * This module is pure and has no side effects: it defines the shape a
 * *server-side reader* must produce before the verification pipeline may treat an
 * observation as authentic, plus the finality and Registry-identity evidence that
 * accompanies it.
 *
 * Nothing here mints a confirmation-authorizing proof. The proof type in
 * `anchor-verification.ts` still comes only from `evaluateAnchorObservation`, and
 * Phase 2C.2A additionally requires the trusted-reader seal below before the
 * confirmation boundary will accept it. See `docs/PHASE2C2A_TRUSTED_ARBITRUM_READER.md`.
 */

import type { ChainObservation } from "./anchor-verification";

/** The three Arbitrum JSON-RPC block tags, and what each one is worth. */
export const TRUSTED_BLOCK_TAGS = Object.freeze({
  /** Soft confirmation. Never sufficient for confirmed evidence. */
  latest: "latest",
  /** Parent-chain safe head. Still not the final confirmed state. */
  safe: "safe",
  /** Parent-chain finalized. The only tag that makes evidence eligible. */
  finalized: "finalized",
} as const);

export type TrustedBlockTag =
  (typeof TRUSTED_BLOCK_TAGS)[keyof typeof TRUSTED_BLOCK_TAGS];

/**
 * The finality evidence a trusted reader observed.
 *
 * `level` is recorded so a stored or logged result can never be mistaken for a
 * weaker observation after the fact. `finalizedBlockNumber` and
 * `finalizedBlockHash` are the parent-chain finalized head that was compared
 * against the receipt's block. All numeric values are canonical decimal strings:
 * no value in this module is ever held in a JavaScript `number`.
 */
export interface FinalityEvidence {
  readonly level: "finalized";
  readonly finalizedBlockNumber: string;
  readonly finalizedBlockHash: string;
  /** Canonical hash of the receipt's block, re-read after the finality query. */
  readonly receiptBlockHash: string;
  /** Canonical number of the receipt's block. */
  readonly receiptBlockNumber: string;
}

/**
 * Proof that a server-side reader, not a caller, produced an observation.
 *
 * This is an ordinary frozen value object rather than a class: it is created only
 * by `trusted-observation-seal.ts`, which is the single module allowed to import
 * the module-private symbol it is validated against. Callers can copy its fields
 * but cannot make `isTrustedObservedAnchor` return true for a copy.
 */
export interface TrustedObservedAnchor {
  readonly observation: ChainObservation;
  readonly finality: FinalityEvidence;
  /** Keccak-256 of the deployed runtime bytecode, as pinned by the manifest. */
  readonly runtimeBytecodeHash: string;
  /** Registry address the reader was configured with, canonical lowercase. */
  readonly registryAddress: string;
  readonly transactionHash: string;
}
