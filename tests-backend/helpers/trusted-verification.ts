/**
 * An in-process mock chain for the backend tests.
 *
 * **Review pass 3 removed test-only operator issuance from production.** Earlier
 * revisions built a genuinely trusted result here by pointing an operator-scoped reader
 * at a mock endpoint. That is no longer possible, and deliberately so: a mock server
 * returning fabricated chain data cannot establish operator provenance, and the
 * confirmation boundary must not be satisfiable by one.
 *
 * So this helper now produces only what a test-scoped reader can produce: a *reader
 * result* obtained over a real transport, which is enough to exercise transport,
 * decoding, finality ordering and the confirmation boundary's rejection paths. It
 * cannot produce a `TrustedAnchorVerification`, and `confirmable()` therefore throws if
 * asked for one — loudly, rather than returning something that looks authorized.
 *
 * The positive path through `runTrustedVerification` → `confirmVerifiedAnchor` requires
 * a genuinely operator-pinned reader and a real reviewed deployment manifest. It is
 * recorded as unexercised in `docs/PHASE2C2A_TRUSTED_ARBITRUM_READER.md`, not faked.
 *
 * No public endpoint is contacted; the socket is loopback-only and ephemeral.
 */

import type { PoolClient } from "pg";
import { getAddress, toBeHex, zeroPadValue } from "ethers";
import {
  EVIDENCE_ANCHORED_TOPIC,
  type ExpectedAnchorCommitment,
} from "../../src/server/evidence/anchor-verification";
import { runTrustedVerification } from "../../src/server/evidence/trusted-authorization";
import { readConfirmableOutboxRow } from "../../src/server/evidence/anchor-confirmation";
import { TrustedEvidenceChainReader } from "../../src/server/evidence/trusted-reader";
import { createTestReader } from "../../tests/evidence/helpers/test-reader-factory";
import type { TrustedAnchorVerification } from "../../src/server/evidence/trusted-authorization";
import type { TrustedPipelineOutcome } from "../../src/server/evidence/trusted-authorization";
import {
  hex32,
  keccakOf,
  quantity,
  startMockRpcServer,
  type MockRpcServer,
  type RpcCall,
} from "../../tests/evidence/helpers/mock-rpc-server";

export interface WorldOptions {
  readonly registry: string;
  readonly attestor: string;
  readonly administrator: string;
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly finalizedOffset: number;
  readonly evidenceId: string;
  readonly payloadHash: string;
  readonly previousPayloadHash: string;
  readonly kind: bigint;
  readonly sequence: bigint;
  readonly runtimeCode: string;
}

export interface AnchorWorld {
  readonly reader: TrustedEvidenceChainReader;
  readonly options: WorldOptions;
  readonly server: MockRpcServer;
  /** Override one RPC method for a single test. */
  setOverride(method: string, value: unknown): void;
  /** Run the real pipeline against this world. */
  verify(commitment: ExpectedAnchorCommitment): Promise<TrustedPipelineOutcome>;
  /**
   * Historically verified an outbox row and narrowed to a trusted result. Since review
   * pass 3 no test can mint one, so this always throws with that reason.
   */
  confirmable(
    db: PoolClient,
    outboxId: string,
  ): Promise<{
    row: NonNullable<Awaited<ReturnType<typeof readConfirmableOutboxRow>>>;
    trusted: TrustedAnchorVerification;
  }>;
  /** The reader result over the mock chain, for reachable assertions. */
  acquire(
    transactionHash: string,
    registryAddress: string,
  ): ReturnType<TrustedEvidenceChainReader["readAnchorObservation"]>;
  close(): Promise<void>;
}

const DEFAULT_CODE = "0x6080604052348015600f57600080fd5b50";

function anchorLogFor(options: WorldOptions) {
  return {
    address: options.registry,
    topics: [
      EVIDENCE_ANCHORED_TOPIC,
      options.evidenceId,
      options.payloadHash,
      zeroPadValue(getAddress(options.attestor), 32),
    ],
    data: `0x${toBeHex(options.kind, 32).slice(2)}${toBeHex(
      options.sequence,
      32,
    ).slice(2)}${options.previousPayloadHash.slice(2)}`,
  };
}

/**
 * Starts a mock endpoint describing one coherent, finalized anchor.
 *
 * `commitment` values are read from the seeded database row by the caller; this
 * helper only describes the chain, so the two cannot drift accidentally.
 */
export async function startAnchorWorld(
  options: WorldOptions,
): Promise<AnchorWorld> {
  const overrides = new Map<string, unknown>();
  const anchorLog = anchorLogFor(options);
  const runtimeHash = keccakOf(options.runtimeCode);

  const base: Record<string, unknown> = {
    eth_chainId: quantity(421614),
    eth_getCode: options.runtimeCode,
    eth_call: `0x${zeroPadValue(getAddress(options.administrator), 32).slice(2)}`,
    eth_getTransactionByHash: {
      hash: options.transactionHash,
      from: options.attestor,
      to: options.registry,
    },
    eth_getTransactionReceipt: {
      transactionHash: options.transactionHash,
      status: "0x1",
      from: options.attestor,
      to: options.registry,
      blockNumber: quantity(options.blockNumber),
      blockHash: options.blockHash,
      logs: [anchorLog],
    },
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? {
            number: quantity(options.blockNumber + options.finalizedOffset),
            hash: hex32("backend-finalized"),
          }
        : { number: quantity(options.blockNumber), hash: options.blockHash },
  };

  const server = await startMockRpcServer((call) => {
    if (overrides.has(call.method)) {
      const override = overrides.get(call.method);
      // An override may be a constant or a responder function.
      if (typeof override === "function")
        return (override as (c: RpcCall) => unknown)(call);
      return override;
    }
    const entry = base[call.method];
    if (entry === undefined)
      throw new Error(`method not stubbed: ${call.method}`);
    if (typeof entry === "function")
      return (entry as (c: RpcCall) => unknown)(call);
    return entry;
  });

  const reader = createTestReader({
    rpcUrl: server.url,
    registryAddress: options.registry,
    runtimeBytecodeHash: runtimeHash,
    administrator: options.administrator,
  });

  return {
    reader,
    options,
    server,
    setOverride(method, value) {
      overrides.set(method, value);
    },
    verify(commitment) {
      return runTrustedVerification(
        reader,
        commitment,
        options.transactionHash,
      );
    },
    /**
     * Historically returned a genuinely trusted result. It cannot: no operator-scoped
     * reader can be constructed in this codebase since review pass 3. Tests that need a
     * sealed result are skipped with that reason; calling this throws so the situation
     * cannot be mistaken for a passing assertion.
     */
    async confirmable(db, outboxId): Promise<never> {
      const row = await readConfirmableOutboxRow(db, outboxId);
      if (!row) throw new Error("outbox row not found");
      const outcome = await runTrustedVerification(
        reader,
        {
          chainId: row.chainId,
          registryAddress: row.registryAddress,
          evidenceId: row.evidenceId,
          payloadHash: row.payloadHash,
          evidenceKind: row.evidenceKind,
          sequence: row.sequence,
          previousPayloadHash: row.previousPayloadHash,
        },
        options.transactionHash,
      );
      throw new Error(
        `no trusted verification can be minted in tests (review pass 3): ${outcome.ok ? "unexpectedly authorized" : outcome.failure}`,
      );
    },
    /** The reader result over the mock chain, for the reachable assertions. */
    acquire(transactionHash: string, registryAddress: string) {
      return reader.readAnchorObservation({ transactionHash, registryAddress });
    },
    close() {
      return server.close();
    },
  };
}

export { DEFAULT_CODE as ANCHOR_RUNTIME_CODE };
