/**
 * Builds genuine `TrustedAnchorVerification` values for the backend tests.
 *
 * Phase 2C.2A made a bare evaluation proof insufficient for confirmation: the
 * boundary now also requires a seal that only the trusted pipeline can issue, and
 * that seal exists only if a *real reader* acquired the observation over a *real
 * transport*. So these tests cannot hand-build a result. They stand up an
 * in-process mock JSON-RPC endpoint, point the production reader class at it, and
 * run the production pipeline. The fake is the endpoint, never the reader.
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
  /** Verify for an outbox row and narrow to a trusted result, or throw. */
  confirmable(
    db: PoolClient,
    outboxId: string,
  ): Promise<{
    row: NonNullable<Awaited<ReturnType<typeof readConfirmableOutboxRow>>>;
    trusted: TrustedAnchorVerification;
  }>;
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
    async confirmable(db, outboxId) {
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
      if (!outcome.ok)
        throw new Error(
          `expected a trusted verification, got ${outcome.failure}${
            "evaluationFailure" in outcome && outcome.evaluationFailure
              ? `/${outcome.evaluationFailure}`
              : ""
          }`,
        );
      return { row, trusted: outcome.result };
    },
    close() {
      return server.close();
    },
  };
}

export { DEFAULT_CODE as ANCHOR_RUNTIME_CODE };
