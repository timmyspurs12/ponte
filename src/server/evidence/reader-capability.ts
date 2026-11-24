/**
 * Reader capability — types only (Phase 2C.2A, review passes 2 and 3).
 *
 * ## The hole this module used to have
 *
 * Review pass 2 found that `runTrustedVerification(reader, …)` accepted any object with
 * `readAnchorObservation()` and `pinnedRegistryAddress`. A fabricated object returning
 * a synthetic observation, synthetic finality evidence and a synthetic bytecode hash
 * drove the pipeline to mint a genuine `TrustedAnchorVerification`. The class type was
 * never a runtime boundary, and neither is `instanceof`.
 *
 * Pass 2 replaced that with a `WeakMap` from reader instance to a dispatcher object,
 * but left the *writer* exported, so any module could mint a reader. Pass 3 closed the
 * writer but found the next link: `dispatchForReader()` returned the stored dispatcher
 * **itself**, and `readonly` is a compile-time claim only. A caller could take the
 * dispatcher of its own test-scoped reader, flip `operatorScoped` to `true`, swap `read`
 * for a fabricated acquisition, or repoint `pinnedRegistryAddress` — and the pipeline
 * would then read the tampered values out of the object it was handed.
 *
 * ## Current arrangement
 *
 * The registry, the writer and the dispatch records now live in `trusted-reader.ts`, in
 * module scope, unexported. Nothing authority-bearing is ever returned. The only
 * exported operation is `acquireForVerification`, which:
 *
 * - looks the reader up in the module-private map;
 * - refuses anything that is not registered;
 * - refuses a test-scoped entry **before** touching it;
 * - reads the entry's own fixed values from the closure, never from a returned object;
 * - invokes the acquisition closure and returns a fresh result object.
 *
 * There is no object to mutate, because no object escapes. Freezing would also work,
 * but returning nothing is strictly stronger: it removes the attack surface rather than
 * hardening it.
 *
 * This module now holds types only.
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
 * What the pipeline receives from `acquireForVerification`.
 *
 * This is a **result**, not authority: it records an acquisition that has already
 * happened, cannot be replayed into a different decision, and carries no reference to
 * the reader, its registry entry, or any function.
 */
export type VerifiedAcquisition =
  | {
      readonly ok: true;
      /** The pinned address the reader was configured with, copied at acquisition. */
      readonly pinnedRegistryAddress: string;
      readonly observation: ChainObservation;
      readonly finality: FinalityEvidence;
      readonly runtimeBytecodeHash: string;
    }
  | { readonly ok: false; readonly failure: string };
