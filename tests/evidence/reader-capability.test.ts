import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TrustedEvidenceChainReader } from "../../src/server/evidence/trusted-reader";
import {
  isTrustedAnchorVerification,
  runTrustedVerification,
} from "../../src/server/evidence/trusted-authorization";
import type { ExpectedAnchorCommitment } from "../../src/server/evidence/anchor-verification";
import {
  keccakOf,
  startMockRpcServer,
  type MockRpcServer,
} from "./helpers/mock-rpc-server";
import {
  createHarnessOperatorReader,
  createTestReader,
  harnessBuildIdentity,
  harnessManifest,
  type TestReaderOptions,
} from "./helpers/test-reader-factory";

/**
 * Reader provenance (Phase 2C.2A, review pass 2, findings 1 and 2).
 *
 * Review pass 2 found that `runTrustedVerification` would accept *any* object shaped
 * like a reader and mint a genuine authorization from whatever that object returned.
 * These tests are the proof that the bypass is closed, and they are deliberately
 * written against the runtime boundary rather than the type system: every forgery
 * below type-checks fine and is written to look exactly like a legitimate reader.
 */

const REGISTRY = `0x${"11".repeat(20)}`;
const ADMIN = `0x${"22".repeat(20)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;
const TX_HASH = `0x${"77".repeat(32)}`;
const RUNTIME_CODE = "0x6080604052348015600f57600080fd5b50";

let server: MockRpcServer;
let options: TestReaderOptions;

before(async () => {
  server = await startMockRpcServer(() => "0x1");
  // A well-formed config: the runtime hash is a real keccak of real-looking code and
  // the manifest/build identity agree, so nothing here fails for a *format* reason.
  options = {
    rpcUrl: server.url,
    registryAddress: REGISTRY,
    runtimeBytecodeHash: keccakOf(RUNTIME_CODE),
    administrator: ADMIN,
  };
});

after(async () => {
  await server.close();
});

/** The persisted commitment the pipeline cross-checks, in its real shape. */
function expected(): ExpectedAnchorCommitment {
  return {
    chainId: "421614",
    registryAddress: REGISTRY,
    evidenceId: `0x${"99".repeat(32)}`,
    payloadHash: `0x${"98".repeat(32)}`,
    evidenceKind: 1,
    sequence: "1",
    previousPayloadHash: `0x${"00".repeat(32)}`,
  };
}

/** A complete, valid config body minus the endpoint, for endpoint-only tests. */
function harnessManifestAndIdentity() {
  const runtimeBytecodeHash = keccakOf(RUNTIME_CODE);
  const base = {
    rpcUrl: "",
    registryAddress: REGISTRY,
    runtimeBytecodeHash,
    administrator: ADMIN,
  };
  return {
    manifest: harnessManifest(base),
    buildIdentity: harnessBuildIdentity(base),
  };
}

/** A syntactically plausible acquisition result a hostile reader would return. */
function fabricatedResult() {
  return {
    observation: {
      chainId: "421614",
      transactionHash: TX_HASH,
      transactionFrom: `0x${"33".repeat(20)}`,
      transactionTo: REGISTRY,
      receipt: {
        transactionHash: TX_HASH,
        status: "success" as const,
        from: `0x${"33".repeat(20)}`,
        to: REGISTRY,
        blockNumber: "12000000",
        blockHash: BLOCK_HASH,
        logs: [],
      },
      transactionBlockNumber: "12000000",
      transactionBlockHash: BLOCK_HASH,
      finalizedBlockNumber: "12001000",
    },
    finality: {
      basis: "l2_finalized",
      finalizedBlockNumber: "12001000",
      observedBlockNumber: "12000000",
    },
    runtimeBytecodeHash: `0x${"00".repeat(32)}`,
  };
}

/**
 * Every forgery is built with the real method names and the real pinned address, so
 * a shape- or `instanceof`-based check would let each of them through.
 */
function forgeries(): Array<{ name: string; value: unknown }> {
  const fabricated = fabricatedResult();

  const plain = {
    pinnedRegistryAddress: REGISTRY,
    testScoped: false,
    readAnchorObservation: async () => fabricated,
    evaluate: async () => fabricated,
  };

  // `Object.create` with the real prototype: satisfies `instanceof` without ever
  // running the constructor. Properties are defined rather than assigned because the
  // real class exposes `pinnedRegistryAddress` as a getter.
  const viaObjectCreate = Object.defineProperties(
    Object.create(TrustedEvidenceChainReader.prototype) as object,
    {
      pinnedRegistryAddress: { value: REGISTRY, configurable: true },
      testScoped: { value: false, configurable: true },
      readAnchorObservation: { value: async () => fabricated, configurable: true },
    },
  );

  const proxy = new Proxy(plain, {
    get(target, property) {
      // Forward everything, and claim to be a genuine reader for any brand check.
      if (property === Symbol.toStringTag) return "TrustedEvidenceChainReader";
      return Reflect.get(target, property);
    },
    has: () => true,
  });

  // A subclass instance: satisfies `instanceof` genuinely, but never ran the base
  // constructor, so it was never registered.
  // Genuinely extends the class — `instanceof` is satisfied — but the base
  // constructor rejects an unbranded config, so the object cannot be produced this
  // way at all. Recorded as "construction throws", which is itself the proof that
  // class identity cannot be forged into a capability.
  const impostor = (() => {
    try {
      class Impostor extends TrustedEvidenceChainReader {
        constructor() {
          super(undefined as never);
        }
      }
      return new Impostor() as never;
    } catch (error) {
      return { threw: (error as Error).message };
    }
  })();

  return [
    { name: "plain object literal", value: plain },
    { name: "Object.create(prototype)", value: viaObjectCreate },
    { name: "proxied imitation", value: proxy },
    {
      name: "prototype swap on a bare object",
      value: Object.setPrototypeOf(
        Object.defineProperties({}, {
          pinnedRegistryAddress: { value: REGISTRY, configurable: true },
          testScoped: { value: false, configurable: true },
          readAnchorObservation: { value: async () => fabricated, configurable: true },
        }),
        TrustedEvidenceChainReader.prototype,
      ),
    },
    { name: "subclass with an unbranded config", value: impostor },
  ];
}

// ------------------------------------------------------- finding 1: forgery

for (const { name, value } of forgeries()) {
  test(`a fabricated reader is refused before any observation is used: ${name}`, async () => {
    const outcome = await runTrustedVerification(value, expected(), TX_HASH);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(
      outcome.failure,
      "READER_NOT_TRUSTED",
      `${name} must be refused as untrusted, got ${outcome.failure}`,
    );
  });
}

test("a forged reader never yields a confirmation-authorizing result", async () => {
  // This is the critical assertion from the review: the pipeline must not merely
  // report failure — it must not produce anything `isTrustedAnchorVerification`
  // accepts.
  let returnedAnything = false;
  for (const { value } of forgeries()) {
    const outcome = await runTrustedVerification(value, expected(), TX_HASH);
    if (outcome.ok) returnedAnything = true;
    assert.equal("result" in outcome ? outcome.result : undefined, undefined);
    assert.equal(isTrustedAnchorVerification(outcome), false);
  }
  assert.equal(returnedAnything, false);
});

test("a forged reader whose observation matches every expectation is still refused", async () => {
  // The forgery here returns a *perfect* observation: correct chain, correct address,
  // correct hashes, finalized. Only provenance can reject it, so this isolates the
  // capability check from every content check.
  const perfect = {
    pinnedRegistryAddress: REGISTRY,
    readAnchorObservation: async () => fabricatedResult(),
    readTransaction: async () => ({}),
    readReceipt: async () => ({}),
  };
  const outcome = await runTrustedVerification(perfect, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

test("the pipeline refuses primitive and null readers without throwing", async () => {
  for (const value of [null, undefined, 0, "", "reader", true, Symbol("x"), []] as never[]) {
    const outcome = await runTrustedVerification(value as never, expected(), TX_HASH);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
  }
});

// ------------------------------------------- finding 2: test-scoped refusal

test("a test-scoped reader is refused even though its RPC is fully valid", async () => {
  // The mock server answers correctly for this reader: it can perform real work.
  // What it cannot do is authorize.
  const reader = createTestReader(options);
  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

test("a test-scoped reader cannot authorize even with a matching commitment", async () => {
  const reader = createTestReader(options);
  // Give it a commitment whose fields match the fabricated path; the refusal must be
  // about provenance, not about content mismatches.
  const outcome = await runTrustedVerification(
    reader,
    { ...expected(), registryAddress: REGISTRY },
    TX_HASH,
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
  assert.equal(isTrustedAnchorVerification(outcome), false);
});

test("an operator-scoped reader is accepted by the provenance gate", async () => {
  // The converse, so the gate above is not simply refusing everything: a genuinely
  // operator-scoped reader passes Gate 0/0b and fails later on content, which proves
  // the capability lookup itself succeeds.
  const reader = createHarnessOperatorReader(options);
  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.notEqual(
      outcome.failure,
      "READER_NOT_TRUSTED",
      "an operator-scoped reader must pass the provenance gate",
    );
  }
});

// --------------------------------------- finding 2: production surface audit

/** Every `.ts` file under a directory, recursively. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

test("no production module imports the test bridge", () => {
  // The bridge is the only importer of the harness issuance function, and it lives
  // under `tests/`. If a `src/` file ever imports it, test-scoped configuration could
  // reach production, so this is asserted structurally rather than by convention.
  const importPattern =
    /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["'][^"']*(?:test-config-bridge|test-reader-factory)[^"']*["']/;
  // Match a *call*, not the single definition in `trusted-reader-config.ts`:
  // `__issueConfigForHarness(` followed by anything other than a function body.
  const harnessSymbol = /(?<!function\s)__issueConfigForHarness\s*\([^)\n]*\)\s*(?![:{]\s*$)/;
  const offenders = sourceFiles("src").filter((file) => {
    const source = readFileSync(file, "utf8");
    // Comments may legitimately *name* these files; only real imports and real calls
    // count. The harness symbol is matched as a call, not as a mention.
    return importPattern.test(source) || harnessSymbol.test(source);
  });
  assert.deepEqual(offenders, [], `production files reference test fixtures: ${offenders}`);
});

test("the capability writer is not exported from any production module", () => {
  // The writer must be module-private. An exported attach function would let any
  // module mint a reader, which is exactly the hole review pass 2 found.
  const offenders = sourceFiles("src").filter((file) =>
    /^export (function|const) attachReaderCapability/m.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, [], `a production module exports the capability writer`);
});

test("the test bridge is imported only from test files", () => {
  // The bridge may be imported by any `tests/` file — that is the point of putting it
  // there. What matters is that nothing under `src/` reaches it, which the test above
  // asserts. Here we verify the *direction*: the bridge exists under `tests/`, and its
  // importer set is confined to `tests/`.
  const importers = sourceFiles("tests").filter((file) => {
    if (file.endsWith("test-config-bridge.ts")) return false;
    return /from\s+["'][^"']*test-config-bridge["']/.test(readFileSync(file, "utf8"));
  });
  assert.ok(importers.length > 0, "expected the bridge to be in use");
  for (const file of importers)
    assert.ok(
      file.replace(/\\/g, "/").startsWith("tests/"),
      `bridge importer outside tests/: ${file}`,
    );
});

// ------------------------------ the authorizing path cannot be aimed off-box

test("harness operator scope refuses a non-loopback endpoint", async () => {
  // Review pass 2 forbids "an exported helper letting arbitrary endpoints reach the
  // authorizing pipeline". The bridge can mint an operator-scoped reader, so it must
  // be impossible to point that reader at a real network. This is enforced at
  // issuance time and is checked here for several shapes of remote endpoint.
  const { issueHarnessOperatorConfig } = await import(
    "./helpers/test-config-bridge"
  );
  const remote = [
    "https://sepolia-rollup.arbitrum.io/rpc",
    "https://arbitrum-sepolia-rpc.publicnode.com",
    "http://example.com:8545",
    "http://10.0.0.1:8545",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost.evil.example/",
    "https://127.0.0.1:8545/", // loopback host but TLS: not the harness's shape
  ];
  for (const rpcUrl of remote) {
    const result = issueHarnessOperatorConfig({
      ...harnessManifestAndIdentity(),
      rpcUrl,
      timeoutMs: 5_000,
    });
    assert.equal(result.ok, false, `operator scope accepted remote endpoint ${rpcUrl}`);
    if (!result.ok) assert.equal(result.failure, "CONFIG_RPC_URL");
  }
});

test("harness operator scope accepts a loopback endpoint", async () => {
  const { issueHarnessOperatorConfig } = await import(
    "./helpers/test-config-bridge"
  );
  const result = issueHarnessOperatorConfig({
    ...harnessManifestAndIdentity(),
    rpcUrl: "http://127.0.0.1:8545",
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, true, "loopback should be accepted for the harness");
});

// --------------------------------- deleting the pass-1 test-only surface

test("the pass-1 test-only exports are gone from production source", () => {
  // Review pass 2 required that `validateTestReaderConfig` and `registerTestTransport`
  // not remain as production helpers. Asserting the *absence* of an export is unusual,
  // but it is what prevents someone reintroducing them during a future refactor
  // without noticing this constraint.
  const surfaces = sourceFiles("src").map((file) => ({
    file,
    source: readFileSync(file, "utf8"),
  }));
  for (const name of ["registerTestTransport", "TEST_TRANSPORTS", "validateTestReaderConfig"]) {
    const present = surfaces.filter(({ source }) =>
      new RegExp(`export\\s+(?:function|const|let|var)\\s+${name}\\b`).test(source),
    );
    assert.deepEqual(
      present.map((s) => s.file),
      [],
      `${name} is exported from production source`,
    );
  }
});
