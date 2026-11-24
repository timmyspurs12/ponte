import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getAddress, id as keccakId, toBeHex, zeroPadValue } from "ethers";
import {
  evaluateAnchorObservation,
  EVIDENCE_ANCHORED_TOPIC,
  isAnchorEvaluationProof,
  type ChainObservation,
  type ExpectedAnchorCommitment,
} from "../../src/server/evidence/anchor-verification";
import { createTestReader } from "./helpers/test-reader-factory";
import {
  hex32,
  keccakOf,
  quantity,
  startMockRpcServer,
  type MockRpcServer,
  type RpcCall,
} from "./helpers/mock-rpc-server";

/**
 * Trusted-reader tests (Phase 2C.2A).
 *
 * These exercise the **production** reader class against an in-process mock
 * JSON-RPC endpoint. No public endpoint is contacted; the socket is loopback-only
 * and ephemeral. Every assertion is deterministic.
 */

const CHAIN_ID = 421614;
const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const ATTESTOR = `0x${"33".repeat(20)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";
const RUNTIME_HASH = keccakOf(RUNTIME_CODE);
const TX_HASH = hex32("transaction");
const BLOCK_HASH = hex32("block");
const EVIDENCE_ID = hex32("evidence-id");
const PAYLOAD_HASH = hex32("payload-hash");
const PREVIOUS_HASH = `0x${"00".repeat(32)}`;
const RECEIPT_BLOCK_NUMBER = 12345678;
const FINALIZED_BLOCK_NUMBER = 12345900;

const EXPECTED: ExpectedAnchorCommitment = {
  chainId: String(CHAIN_ID),
  registryAddress: REGISTRY,
  evidenceId: EVIDENCE_ID,
  payloadHash: PAYLOAD_HASH,
  evidenceKind: 1,
  sequence: "1",
  previousPayloadHash: PREVIOUS_HASH,
};

/**
 * Reader construction options. The production constructor accepts only a branded
 * configuration, so tests build a **test-scoped** one through the sanctioned
 * harness; the reader under test is still the production class.
 */
const CONFIG = {
  rpcUrl: "http://127.0.0.1:1", // replaced per-test with the mock's URL
  timeoutMs: 5_000,
  registryAddress: REGISTRY,
  runtimeBytecodeHash: RUNTIME_HASH,
  administrator: ADMIN,
} as const;

function anchorLog(
  overrides: {
    address?: string;
    evidenceId?: string;
    payloadHash?: string;
    attestor?: string;
    kind?: bigint;
    sequence?: bigint;
    previous?: string;
  } = {},
) {
  const data = `0x${toBeHex(overrides.kind ?? 1n, 32).slice(2)}${toBeHex(
    overrides.sequence ?? 1n,
    32,
  ).slice(2)}${(overrides.previous ?? PREVIOUS_HASH).slice(2)}`;
  return {
    address: overrides.address ?? REGISTRY,
    topics: [
      EVIDENCE_ANCHORED_TOPIC,
      overrides.evidenceId ?? EVIDENCE_ID,
      overrides.payloadHash ?? PAYLOAD_HASH,
      zeroPadValue(getAddress(overrides.attestor ?? ATTESTOR), 32),
    ],
    data,
  };
}

/**
 * A complete, correct RPC world. Individual tests override one method to break it.
 */
function defaultWorld(overrides: Partial<Record<string, unknown>> = {}) {
  const receipt = {
    transactionHash: TX_HASH,
    status: "0x1",
    from: ATTESTOR,
    to: REGISTRY,
    blockNumber: quantity(RECEIPT_BLOCK_NUMBER),
    blockHash: BLOCK_HASH,
    logs: [anchorLog()],
  };
  const tx = { hash: TX_HASH, from: ATTESTOR, to: REGISTRY };
  const block = { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH };
  const finalized = {
    number: quantity(FINALIZED_BLOCK_NUMBER),
    hash: hex32("finalized"),
  };
  const adminReturn = `0x${zeroPadValue(getAddress(ADMIN), 32).slice(2)}`;

  return {
    eth_chainId: quantity(CHAIN_ID),
    eth_getCode: RUNTIME_CODE,
    eth_call: adminReturn,
    eth_getTransactionByHash: tx,
    eth_getTransactionReceipt: receipt,
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized" ? finalized : block,
    ...overrides,
  } as Record<string, unknown>;
}

function handler(world: Record<string, unknown>) {
  return (call: RpcCall): unknown => {
    const entry = world[call.method];
    if (entry === undefined) throw new Error("method not stubbed");
    if (typeof entry === "function")
      return (entry as (c: RpcCall) => unknown)(call);
    return entry;
  };
}

let server: MockRpcServer;

before(async () => {
  server = await startMockRpcServer(handler(defaultWorld()));
});

after(async () => {
  await server.close();
});

function readerFor(world: Record<string, unknown>, url = server.url) {
  server.setHandler(handler(world));
  server.setRawResponder(null);
  server.calls.length = 0;
  return createTestReader({ ...CONFIG, rpcUrl: url });
}

async function read(world: Record<string, unknown>) {
  const reader = readerFor(world);
  return reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
}

function failureOf(result: Awaited<ReturnType<typeof read>>): string | null {
  return result.ok ? null : result.failure;
}

// ---------------------------------------------------------------- happy path

test("the correct finalized receipt is accepted", async () => {
  const result = await read(defaultWorld());
  assert.equal(result.ok, true, `expected ok, got ${failureOf(result)}`);
  if (!result.ok) return;
  assert.equal(result.observation.registryIdentity, "verified");
  assert.equal(result.observation.transactionHash, TX_HASH);
  assert.equal(result.finality.level, "finalized");
  assert.equal(
    result.finality.finalizedBlockNumber,
    String(FINALIZED_BLOCK_NUMBER),
  );
  assert.equal(
    result.finality.receiptBlockNumber,
    String(RECEIPT_BLOCK_NUMBER),
  );
  // The reader derives registryIdentity itself; it is never a parameter.
  assert.equal(result.observation.receipt?.blockHash, BLOCK_HASH);
});

test("the reader reads code and admin at the finalized tag, never latest", async () => {
  const reader = readerFor(defaultWorld());
  await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  const blockTags = server.calls
    .filter((call) => call.method === "eth_getBlockByNumber")
    .map((call) => call.params[0]);
  assert.ok(blockTags.includes("finalized"));
  assert.ok(!blockTags.includes("latest"), "must not query latest");
  assert.ok(!blockTags.includes("safe"), "must not query safe");
  const codeCall = server.calls.find((call) => call.method === "eth_getCode");
  assert.equal(codeCall?.params[1], "finalized");
  const callCall = server.calls.find((call) => call.method === "eth_call");
  assert.equal(callCall?.params[1], "finalized");
});

// -------------------------------------------------------- chain and identity

test("wrong chain id is rejected", async () => {
  const result = await read(defaultWorld({ eth_chainId: quantity(1) }));
  assert.equal(failureOf(result), "WRONG_CHAIN");
});

test("unparseable chain id is rejected", async () => {
  const result = await read(defaultWorld({ eth_chainId: "0xzz" }));
  assert.equal(failureOf(result), "WRONG_CHAIN");
});

test("empty Registry code is rejected", async () => {
  const result = await read(defaultWorld({ eth_getCode: "0x" }));
  assert.equal(failureOf(result), "REGISTRY_CODE_MISSING");
});

test("non-hex Registry code is rejected", async () => {
  const result = await read(defaultWorld({ eth_getCode: 42 }));
  assert.equal(failureOf(result), "REGISTRY_CODE_MISSING");
});

test("EIP-7702 delegation designator is rejected even if otherwise plausible", async () => {
  const delegated = `0xef0100${REGISTRY.slice(2)}`;
  const result = await read(defaultWorld({ eth_getCode: delegated }));
  assert.equal(failureOf(result), "REGISTRY_DELEGATED");
});

test("runtime bytecode hash mismatch is rejected", async () => {
  const result = await read(
    defaultWorld({ eth_getCode: "0x6080604052348015600f57600080fd5b51" }),
  );
  assert.equal(failureOf(result), "REGISTRY_CODE_HASH_MISMATCH");
});

test("zero administrator response is rejected", async () => {
  const result = await read(defaultWorld({ eth_call: `0x${"00".repeat(32)}` }));
  assert.equal(failureOf(result), "REGISTRY_ADMIN_INVALID");
});

test("reverted admin call is rejected", async () => {
  const result = await read(defaultWorld({ eth_call: "0x" }));
  assert.equal(failureOf(result), "REGISTRY_ADMIN_INVALID");
});

test("truncated admin response is rejected", async () => {
  const result = await read(defaultWorld({ eth_call: `0x${"11".repeat(20)}` }));
  assert.equal(failureOf(result), "REGISTRY_ADMIN_INVALID");
});

test("admin mismatching the pinned manifest address is rejected", async () => {
  const other = `0x${zeroPadValue(getAddress(`0x${"99".repeat(20)}`), 32).slice(2)}`;
  const result = await read(defaultWorld({ eth_call: other }));
  assert.equal(failureOf(result), "REGISTRY_ADMIN_MISMATCH");
});

test("a receipt whose Registry differs from the pin is rejected", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = { ...receipt, to: `0x${"77".repeat(20)}` };
  const result = await read(world);
  assert.equal(failureOf(result), "RECEIPT_MALFORMED");
});

test("reading a Registry other than the pinned one is refused before any call", async () => {
  const reader = readerFor(defaultWorld());
  const result = await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: `0x${"55".repeat(20)}`,
  });
  assert.equal(failureOf(result), "REGISTRY_ADDRESS_MISMATCH");
  assert.equal(server.calls.length, 0, "must not touch the network");
});

// --------------------------------------------------------- transaction/receipt

test("missing transaction is rejected", async () => {
  const result = await read(defaultWorld({ eth_getTransactionByHash: null }));
  assert.equal(failureOf(result), "TRANSACTION_MISSING");
});

test("transaction with a different hash is rejected", async () => {
  const result = await read(
    defaultWorld({
      eth_getTransactionByHash: {
        hash: hex32("other"),
        from: ATTESTOR,
        to: REGISTRY,
      },
    }),
  );
  assert.equal(failureOf(result), "TRANSACTION_MALFORMED");
});

test("transaction to another contract is rejected", async () => {
  const result = await read(
    defaultWorld({
      eth_getTransactionByHash: {
        hash: TX_HASH,
        from: ATTESTOR,
        to: `0x${"88".repeat(20)}`,
      },
    }),
  );
  assert.equal(failureOf(result), "TRANSACTION_MALFORMED");
});

test("transaction with a missing sender is rejected", async () => {
  const result = await read(
    defaultWorld({ eth_getTransactionByHash: { hash: TX_HASH, to: REGISTRY } }),
  );
  assert.equal(failureOf(result), "TRANSACTION_MALFORMED");
});

test("a zero transaction hash is rejected before any call", async () => {
  const reader = readerFor(defaultWorld());
  const result = await reader.readAnchorObservation({
    transactionHash: `0x${"00".repeat(32)}`,
    registryAddress: REGISTRY,
  });
  assert.equal(failureOf(result), "TRANSACTION_MALFORMED");
  assert.equal(server.calls.length, 0);
});

test("missing receipt is rejected", async () => {
  const result = await read(defaultWorld({ eth_getTransactionReceipt: null }));
  assert.equal(failureOf(result), "RECEIPT_MISSING");
});

test("reverted receipt is represented honestly rather than dropped", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = { ...receipt, status: "0x0" };
  const result = await read(world);
  // The reader passes it through; the evaluator is what refuses a reverted receipt.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.observation.receipt?.status, "reverted");
  const evaluated = evaluateAnchorObservation(EXPECTED, result.observation);
  assert.equal(isAnchorEvaluationProof(evaluated), false);
});

test("receipt hash mismatch is rejected", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = {
    ...receipt,
    transactionHash: hex32("other"),
  };
  const result = await read(world);
  assert.equal(failureOf(result), "RECEIPT_MALFORMED");
});

test("receipt with an unknown status is rejected", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = { ...receipt, status: "0x2" };
  const result = await read(world);
  assert.equal(failureOf(result), "RECEIPT_MALFORMED");
});

test("receipt with malformed logs is rejected", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = {
    ...receipt,
    logs: [{ address: REGISTRY, topics: ["nope"], data: "0x" }],
  };
  const result = await read(world);
  assert.equal(failureOf(result), "RECEIPT_MALFORMED");
});

// ---------------------------------------------------------------- finality

test("receipt block above the finalized head is rejected", async () => {
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? {
            number: quantity(RECEIPT_BLOCK_NUMBER - 1),
            hash: hex32("finalized"),
          }
        : { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH },
  });
  const result = await read(world);
  assert.equal(failureOf(result), "RECEIPT_BLOCK_NOT_FINALIZED");
});

test("receipt block equal to the finalized head is accepted", async () => {
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? { number: quantity(RECEIPT_BLOCK_NUMBER), hash: hex32("finalized") }
        : { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH },
  });
  const result = await read(world);
  assert.equal(result.ok, true, `expected ok, got ${failureOf(result)}`);
});

test("an unsupported finalized tag is rejected and never downgraded", async () => {
  // A provider that answers finalized with an error, the classic "unsupported tag".
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) => {
      if (call.params[0] === "finalized")
        throw new Error("unsupported block tag");
      return { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH };
    },
  });
  const result = await read(world);
  assert.equal(failureOf(result), "FINALITY_UNAVAILABLE");
  // Prove no fallback happened: no latest/safe query was ever issued.
  const tags = server.calls
    .filter((call) => call.method === "eth_getBlockByNumber")
    .map((call) => call.params[0]);
  assert.ok(!tags.includes("latest"));
  assert.ok(!tags.includes("safe"));
});

test("a malformed finalized block is rejected", async () => {
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? { number: "not-a-number", hash: hex32("finalized") }
        : { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH },
  });
  const result = await read(world);
  assert.equal(failureOf(result), "FINALITY_MALFORMED");
});

test("a null finalized block is rejected", async () => {
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) =>
      call.params[0] === "finalized"
        ? null
        : { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH },
  });
  const result = await read(world);
  assert.equal(failureOf(result), "FINALITY_MALFORMED");
});

// ------------------------------------------------ reorg during finality check

test("a receipt block that changes during the finality check is rejected", async () => {
  let blockReads = 0;
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) => {
      if (call.params[0] === "finalized")
        return {
          number: quantity(FINALIZED_BLOCK_NUMBER),
          hash: hex32("finalized"),
        };
      blockReads += 1;
      // First read: canonical. Second read (after finality query): orphaned.
      return {
        number: quantity(RECEIPT_BLOCK_NUMBER),
        hash: blockReads === 1 ? BLOCK_HASH : hex32("orphaned"),
      };
    },
  });
  const result = await read(world);
  assert.equal(
    failureOf(result),
    "RECEIPT_BLOCK_CHANGED_DURING_FINALITY_CHECK",
  );
});

test("a receipt block that disappears during the finality check is rejected", async () => {
  let blockReads = 0;
  const world = defaultWorld({
    eth_getBlockByNumber: (call: RpcCall) => {
      if (call.params[0] === "finalized")
        return {
          number: quantity(FINALIZED_BLOCK_NUMBER),
          hash: hex32("finalized"),
        };
      blockReads += 1;
      if (blockReads === 1)
        return { number: quantity(RECEIPT_BLOCK_NUMBER), hash: BLOCK_HASH };
      return null;
    },
  });
  const result = await read(world);
  assert.equal(
    failureOf(result),
    "RECEIPT_BLOCK_CHANGED_DURING_FINALITY_CHECK",
  );
});

test("the receipt block is read twice, before and after the finality query", async () => {
  const reader = readerFor(defaultWorld());
  await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  const blockReads = server.calls.filter(
    (call) =>
      call.method === "eth_getBlockByNumber" && call.params[0] !== "finalized",
  );
  assert.equal(blockReads.length, 2);
});

// -------------------------------------------------------------- RPC failures

test("a transport error becomes RPC_UNAVAILABLE", async () => {
  const world = defaultWorld({
    eth_chainId: () => {
      throw new Error("connection refused");
    },
  });
  const result = await read(world);
  assert.equal(failureOf(result), "RPC_UNAVAILABLE");
});

test("invalid JSON becomes RPC_UNAVAILABLE", async () => {
  const reader = readerFor(defaultWorld());
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{ not json");
  });
  const result = await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  assert.equal(failureOf(result), "RPC_UNAVAILABLE");
});

test("a response id mismatch becomes RPC_UNAVAILABLE", async () => {
  const reader = readerFor(defaultWorld());
  server.setRawResponder((body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 999_999,
        result: quantity(CHAIN_ID),
      }),
    );
    assert.ok(body);
  });
  const result = await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  assert.equal(failureOf(result), "RPC_UNAVAILABLE");
});

test("a non-200 status becomes RPC_UNAVAILABLE", async () => {
  const reader = readerFor(defaultWorld());
  server.setRawResponder((_body, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end("{}");
  });
  const result = await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  assert.equal(failureOf(result), "RPC_UNAVAILABLE");
});

test("a non-JSON content type becomes RPC_UNAVAILABLE", async () => {
  const reader = readerFor(defaultWorld());
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  const result = await reader.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  assert.equal(failureOf(result), "RPC_UNAVAILABLE");
});

test("a hanging endpoint times out rather than hanging the request", async () => {
  const reader = readerFor(defaultWorld());
  server.setRawResponder(() => {
    // Never respond.
  });
  const slow = createTestReader({
    ...CONFIG,
    rpcUrl: server.url,
    timeoutMs: 150,
  });
  const result = await slow.readAnchorObservation({
    transactionHash: TX_HASH,
    registryAddress: REGISTRY,
  });
  assert.equal(failureOf(result), "RPC_UNAVAILABLE");
  assert.ok(reader);
});

// ---------------------------------------- fabricated observation / provenance

test("a fabricated observation cannot mint a confirmation-authorizing result", async () => {
  // Build an observation that satisfies every evaluator check, then show that the
  // evaluation proof it produces is *not* a trusted verification.
  const forged: ChainObservation = {
    chainId: String(CHAIN_ID),
    transactionHash: TX_HASH,
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    receipt: {
      transactionHash: TX_HASH,
      status: "success",
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: String(RECEIPT_BLOCK_NUMBER),
      blockHash: BLOCK_HASH,
      logs: [anchorLog()],
    },
    registryIdentity: "verified",
  };
  const evaluated = evaluateAnchorObservation(EXPECTED, forged);
  // The evaluator is happy — this is the defect Phase 2C.2A closes.
  assert.equal(isAnchorEvaluationProof(evaluated), true);

  const { isTrustedAnchorVerification } =
    await import("../../src/server/evidence/trusted-authorization");
  // But it is not, and cannot be turned into, a trusted verification.
  assert.equal(isTrustedAnchorVerification(evaluated), false);
  assert.equal(isTrustedAnchorVerification({ verified: true }), false);
  assert.equal(isTrustedAnchorVerification({ ...evaluated }), false);
});

test("the seal cannot be forged from outside the pipeline", async () => {
  const sealModule = await import("../../src/server/evidence/trusted-authorization");
  assert.equal(sealModule.isTrustedObservedAnchor({}), false);
  assert.equal(sealModule.isTrustedObservedAnchor(null), false);
  assert.equal(
    sealModule.isTrustedObservedAnchor({
      observation: {},
      finality: { level: "finalized" },
      registryAddress: REGISTRY,
      runtimeBytecodeHash: RUNTIME_HASH,
      transactionHash: TX_HASH,
    }),
    false,
  );
});

test("the seal and authorization factories are not exported at runtime", async () => {
  // Review pass 1: `sealTrustedObservation` and `createTrustedAnchorVerification`
  // were importable by any module, which let a caller manufacture authority from
  // fabricated input. Assert directly on the module namespace that they are gone —
  // this attacks the runtime export table, not the TypeScript types.
  const mod = await import("../../src/server/evidence/trusted-authorization");
  const exported = Object.keys(mod);
  for (const forbidden of [
    "sealTrustedObservation",
    "createTrustedAnchorVerification",
    "TrustedObservationSeal",
    "issueSeal",
    "issueTrustedVerification",
  ]) {
    assert.equal(
      (mod as Record<string, unknown>)[forbidden],
      undefined,
      `${forbidden} must not be exported`,
    );
    assert.ok(
      !exported.includes(forbidden),
      `${forbidden} must not appear in the module namespace`,
    );
  }
  // The only exported issuance entry point is the pipeline runner.
  assert.equal(typeof mod.runTrustedVerification, "function");
});

test("a fabricated observation with a verified identity cannot mint a seal", async () => {
  const mod = await import("../../src/server/evidence/trusted-authorization");
  // The most convincing forgery: every field is well-typed and the identity flag
  // claims to be verified.
  const fabricated = {
    chainId: String(CHAIN_ID),
    transactionHash: TX_HASH,
    transactionFrom: ATTESTOR,
    transactionTo: REGISTRY,
    registryIdentity: "verified" as const,
    receipt: {
      transactionHash: TX_HASH,
      status: "success" as const,
      from: ATTESTOR,
      to: REGISTRY,
      blockNumber: "9876543",
      blockHash: BLOCK_HASH,
      logs: [],
    },
  };
  // There is no exported function that accepts such an object, so the only thing a
  // caller can do is hand it a look-alike of the seal — which is not recognised.
  assert.equal(mod.isTrustedObservedAnchor(fabricated), false);
  assert.equal(mod.isTrustedAnchorVerification(fabricated), false);
  assert.equal(
    mod.isTrustedObservedAnchor({ ...fabricated, finality: {}, binding: {} }),
    false,
  );
});

test("a fabricated finalized finality object cannot mint a seal", async () => {
  const mod = await import("../../src/server/evidence/trusted-authorization");
  const forged = {
    observation: {},
    finality: {
      level: "finalized" as const,
      finalizedBlockNumber: "100",
      finalizedBlockHash: BLOCK_HASH,
      receiptBlockHash: BLOCK_HASH,
      receiptBlockNumber: "90",
    },
    runtimeBytecodeHash: RUNTIME_HASH,
    registryAddress: REGISTRY,
    transactionHash: TX_HASH,
    binding: {},
  };
  assert.equal(mod.isTrustedObservedAnchor(forged), false);
  assert.equal(mod.isTrustedAnchorVerification(forged), false);
  assert.equal(mod.isTrustedAnchorVerification({ verified: true, ...forged }), false);
});

// ------------------------------------------------------ event evaluation

test("a missing EvidenceAnchored event is rejected by the evaluator", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = { ...receipt, logs: [] };
  const result = await read(world);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const evaluated = evaluateAnchorObservation(EXPECTED, result.observation);
  assert.equal(isAnchorEvaluationProof(evaluated), false);
  assert.equal((evaluated as { failure: string }).failure, "EVENT_MISSING");
});

test("duplicate events are rejected by the evaluator", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = {
    ...receipt,
    logs: [anchorLog(), anchorLog()],
  };
  const result = await read(world);
  if (!result.ok) return assert.fail("expected ok");
  const evaluated = evaluateAnchorObservation(EXPECTED, result.observation);
  assert.equal((evaluated as { failure: string }).failure, "EVENT_AMBIGUOUS");
});

test("every commitment field mismatch is caught by the evaluator", async () => {
  const cases: Array<[string, Partial<ExpectedAnchorCommitment>]> = [
    ["evidence id", { evidenceId: hex32("other-id") }],
    ["payload hash", { payloadHash: hex32("other-payload") }],
    ["kind", { evidenceKind: 2 }],
    ["sequence", { sequence: "2" }],
    ["previous hash", { previousPayloadHash: hex32("other-previous") }],
    ["registry", { registryAddress: `0x${"66".repeat(20)}` }],
    ["chain", { chainId: "1" }],
  ];
  const result = await read(defaultWorld());
  if (!result.ok) return assert.fail("expected ok");
  for (const [field, override] of cases) {
    const evaluated = evaluateAnchorObservation(
      { ...EXPECTED, ...override },
      result.observation,
    );
    assert.equal(
      isAnchorEvaluationProof(evaluated),
      false,
      `${field} mismatch should not evaluate as verified`,
    );
  }
});

test("the attestor must be the transaction sender", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = {
    ...receipt,
    logs: [anchorLog({ attestor: `0x${"44".repeat(20)}` })],
  };
  const result = await read(world);
  if (!result.ok) return assert.fail("expected ok");
  const evaluated = evaluateAnchorObservation(EXPECTED, result.observation);
  assert.equal(
    (evaluated as { failure: string }).failure,
    "ATTESTOR_NOT_EVENT_SENDER",
  );
});

test("a log from a different contract is not counted as the anchor event", async () => {
  const world = defaultWorld();
  const receipt = world.eth_getTransactionReceipt as Record<string, unknown>;
  world.eth_getTransactionReceipt = {
    ...receipt,
    logs: [anchorLog({ address: `0x${"99".repeat(20)}` })],
  };
  const result = await read(world);
  if (!result.ok) return assert.fail("expected ok");
  const evaluated = evaluateAnchorObservation(EXPECTED, result.observation);
  assert.equal((evaluated as { failure: string }).failure, "EVENT_MISSING");
});

test("the expected event topic matches the registry ABI signature", () => {
  assert.equal(
    EVIDENCE_ANCHORED_TOPIC,
    keccakId("EvidenceAnchored(bytes32,bytes32,address,uint64,uint8,bytes32)"),
  );
});
