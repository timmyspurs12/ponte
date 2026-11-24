/**
 * Reader capability — types only (Phase 2C.2A, review pass 2).
 *
 * ## The hole this module used to have
 *
 * Review pass 2 found that `runTrustedVerification(reader, …)` accepted any object with
 * `readAnchorObservation()` and `pinnedRegistryAddress`. A fabricated object returning
 * a synthetic observation, synthetic finality evidence and a synthetic bytecode hash
 * drove the pipeline to mint a genuine `TrustedAnchorVerification`. The class type was
 * never a runtime boundary, and neither is `instanceof`: anything carrying the
 * prototype satisfies it.
 *
 * Pass 2 replaced that with a `WeakMap` from reader instance to a dispatcher closure,
 * but left the *writer* (`attachReaderCapability`) exported, so any module could still
 * mint a reader. That is the hole this module now closes.
 *
 * ## Current arrangement
 *
 * The `WeakMap` and its single writer live in `trusted-reader.ts`, in module scope,
 * unexported. `trusted-reader.ts` exports exactly one capability-related function —
 * `dispatchForReader` — which is a *lookup*. There is no exported function anywhere in
 * `src/` that can add an entry, so the only objects in the map are instances the
 * `TrustedEvidenceChainReader` constructor put there itself.
 *
 * This module holds the types the pipeline needs and nothing that can mint.
 */

import "server-only";

import type { ChainObservation } from "./anchor-verification";
import type { FinalityEvidence } from "./trusted-observation";

/** One validated acquisition. Mirrors the reader's own result shape. */
export type ReaderAcquisition =
  | {
      readonly ok: true;
      readonly observation: ChainObservation;
      readonly finality: FinalityEvidence;
      readonly runtimeBytecodeHash: string;
    }
  | { readonly ok: false; readonly failure: string };

/**
 * The operations the pipeline is allowed to perform on a reader.
 *
 * Only `trusted-reader.ts` constructs these. The pipeline receives one from
 * `dispatchForReader` and never touches the caller-supplied object.
 */
export interface ReaderDispatch {
  readonly pinnedRegistryAddress: string;
  /** False for a test-scoped reader; the pipeline refuses those. */
  readonly operatorScoped: boolean;
  read(input: {
    readonly transactionHash: string;
    readonly registryAddress: string;
  }): Promise<ReaderAcquisition>;
}
