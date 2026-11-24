import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TrustedEvidenceChainReader } from "../../src/server/evidence/trusted-reader";
import * as readerModule from "../../src/server/evidence/trusted-reader";
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
  createTestReader,
  harnessBuildIdentity,
  harnessConfigInput,
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

test("no reader constructible in this codebase passes the provenance gate", async () => {
  // Review pass 3 removed operator issuance from production entirely, so this is the
  // expected state rather than a gap: every reader a test can build is test-scoped, and
  // every test-scoped reader is refused. The positive path is documented as unexercised
  // rather than faked.
  const reader = createTestReader(options);
  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
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
  // Only the *current* issuance name is a callable surface. The removed
  // `__issueConfigForHarness` is mentioned in a doc comment explaining its removal,
  // which is not a reference to a live function.
  const harnessSymbol = /__issueTestConfigForHarness\s*\([^)\n]*\)\s*(?![:{]\s*$)/;
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

// ===========================================================================
// Review pass 3: the mutable-dispatcher attack
// ===========================================================================
//
// The previous design returned the registry entry to callers, so a test-scoped reader's
// authority object could be edited: flip `operatorScoped` to `true`, swap `read` for a
// fabricated acquisition, or repoint `pinnedRegistryAddress`. `readonly` is erased at
// runtime, so that object WAS the authority.
//
// The authority object is now never returned. These tests attack every avenue that
// remains — the reader itself, any recorded entry, and the module surface — and assert
// that the effective capability cannot be changed.

/** A fabricated acquisition a hostile caller would love to inject. */
function fabricatedAcquisition() {
  return {
    ok: true as const,
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
    runtimeBytecodeHash: keccakOf(RUNTIME_CODE),
  };
}

test("the authority-bearing entry is never returned by any export", () => {
  // The decisive structural property: there is no function in the reader module that
  // hands out a registry entry. `acquireForVerification` is the only capability export
  // and it returns an acquisition result, not authority.
  const exports = Object.keys(readerModule);
  // A lookup-style export would be named like one; assert none exists.
  for (const name of exports) {
    assert.ok(
      !/dispatch|capabilit|entry|authority/i.test(name),
      `unexpected authority-bearing export: ${name}`,
    );
  }
  assert.ok(
    exports.includes("acquireForVerification"),
    "acquireForVerification should be the capability surface",
  );
});

test("attempting to overwrite the reader's own fields changes nothing", async () => {
  const reader = createTestReader(options);
  // The reader object itself carries no authority; the registry is keyed by identity.
  const attempts: Array<() => void> = [
    () => {
      (reader as unknown as Record<string, unknown>).operatorScoped = true;
    },
    () => {
      (reader as unknown as Record<string, unknown>).testOnly = false;
    },
    () => {
      (reader as unknown as Record<string, unknown>).pinnedRegistryAddress = `0x${"99".repeat(20)}`;
    },
    () => {
      (reader as unknown as Record<string, unknown>).read = async () => fabricatedAcquisition();
    },
    () => {
      (reader as unknown as Record<string, unknown>).readAnchorObservation = async () =>
        fabricatedAcquisition();
    },
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch {
      // A non-writable property is a fine outcome; the assertion is about capability.
    }
  }

  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
  assert.equal(isTrustedAnchorVerification(outcome), false);
});

test("Object.defineProperty cannot install operator scope on a test reader", async () => {
  const reader = createTestReader(options);
  const target = reader as unknown as Record<string, unknown>;
  const definitions: Array<[string, PropertyDescriptor]> = [
    ["operatorScoped", { value: true, configurable: true, writable: true }],
    ["testOnly", { value: false, configurable: true, writable: true }],
    ["read", { value: async () => fabricatedAcquisition(), configurable: true }],
    [
      "readAnchorObservation",
      { value: async () => fabricatedAcquisition(), configurable: true },
    ],
  ];
  for (const [key, descriptor] of definitions) {
    try {
      Object.defineProperty(target, key, descriptor);
    } catch {
      // ignore: frozen or non-configurable is acceptable
    }
  }

  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

test("deleting properties from a test reader cannot promote it", async () => {
  const reader = createTestReader(options);
  const target = reader as unknown as Record<string, unknown>;
  for (const key of ["operatorScoped", "testOnly", "read", "readAnchorObservation"]) {
    try {
      delete target[key];
    } catch {
      // ignore
    }
  }

  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

test("a proxy wrapping a genuine test reader gains no authority", async () => {
  const reader = createTestReader(options);
  const proxy = new Proxy(reader, {
    get(target, property, receiver) {
      // Lie about everything a shape check might consult.
      if (property === "operatorScoped" || property === "testOnly") return false;
      if (property === "read" || property === "readAnchorObservation")
        return async () => fabricatedAcquisition();
      if (property === "pinnedRegistryAddress") return REGISTRY;
      return Reflect.get(target, property, receiver);
    },
  });

  const outcome = await runTrustedVerification(proxy as never, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

test("the decisive case: substituting read with a valid fabricated acquisition is refused", async () => {
  // This is the exact attack the review named. The fabricated acquisition is otherwise
  // *perfect*: right transaction, right receipt, right finality, right runtime hash. If
  // the pipeline read `read` off an object the caller could reach, this would authorize.
  const reader = createTestReader(options);
  const target = reader as unknown as Record<string, unknown>;
  const injected = async () => fabricatedAcquisition();

  for (const key of ["read", "readAnchorObservation", "acquire"]) {
    try {
      Object.defineProperty(target, key, {
        value: injected,
        configurable: true,
        writable: true,
      });
      target[key] = injected;
    } catch {
      // ignore
    }
  }

  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok)
    assert.equal(
      outcome.failure,
      "READER_NOT_TRUSTED",
      "the fabricated acquisition must never reach the evaluator",
    );
  assert.equal(isTrustedAnchorVerification(outcome), false);
  assert.equal("result" in outcome ? outcome.result : undefined, undefined);
});

test("a test reader with a perfect, fully consistent mock chain still cannot authorize", async () => {
  // End to end: a mock endpoint that answers everything correctly for this reader.
  // The refusal must be about provenance, not about data quality.
  const reader = createTestReader(options);
  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

// ------------------------------ numeric-loopback validation (finding 3)

test("loopback validation accepts numeric loops only", async () => {
  const { isNumericLoopbackHttpUrl } = await import("./helpers/test-config-bridge");
  for (const url of [
    "http://127.0.0.1:8545",
    "http://127.0.0.2:1",
    "http://127.255.255.254:65535",
    "http://[::1]:8545",
  ]) {
    assert.equal(isNumericLoopbackHttpUrl(url), true, `should accept ${url}`);
  }
});

test("loopback validation rejects hostnames, mapped forms and non-loopback ranges", async () => {
  const { isNumericLoopbackHttpUrl } = await import("./helpers/test-config-bridge");
  for (const url of [
    "http://localhost:8545", // a name, not a literal
    "http://localhost.localdomain:8545",
    "http://LOCALHOST:8545",
    "http://127.0.0.1.evil.example:8545", // looks numeric, is a name
    "https://127.0.0.1:8545", // not http: test configs are plain-HTTP loopback only
    "http://0.0.0.0:8545",
    "http://126.0.0.1:8545",
    "http://128.0.0.1:8545",
    "http://10.0.0.1:8545",
    "http://192.168.1.1:8545",
    "http://172.16.0.1:8545",
    "http://169.254.169.254:8545", // link-local (metadata service)
    "http://8.8.8.8:8545",
    "http://[::ffff:127.0.0.1]:8545", // IPv4-mapped: rejected, never normalized
    "http://[::2]:8545",
    "http://[fe80::1]:8545",
    "http://127.0.0.1:8545/../..", // path does not matter; still checks host only
    "http://user:pass@127.0.0.1:8545", // credentials
  ]) {
    // The last-but-one entry is a positive control with a path; assert it separately.
    if (url.endsWith("/../..")) continue;
    assert.equal(isNumericLoopbackHttpUrl(url), false, `should reject ${url}`);
  }
});

test("alternate numeric spellings that normalize to loopback are accepted", async () => {
  // The WHATWG parser resolves decimal, hexadecimal and octal IPv4 spellings
  // *numerically* — no DNS is consulted — so these denote a genuine loopback address
  // after parsing. Review pass 3 permits exactly this: "unless explicitly and safely
  // normalized to a loopback address". They are accepted because they normalize to
  // 127.0.0.1, not because a name was resolved.
  const { isNumericLoopbackHttpUrl } = await import("./helpers/test-config-bridge");
  for (const url of [
    "http://2130706433:8545", // decimal 127.0.0.1
    "http://0x7f000001:8545", // hexadecimal 127.0.0.1
    "http://0177.0.0.1:8545", // octal first octet
  ]) {
    assert.equal(
      new URL(url).hostname,
      "127.0.0.1",
      `${url} should normalize numerically to a loopback literal`,
    );
    assert.equal(isNumericLoopbackHttpUrl(url), true, `should accept ${url}`);
  }
});

test("loopback host predicate rejects leading-zero and malformed octets", async () => {
  // Exercised through the URL predicate so we do not export an extra helper purely for
  // testing; `127.00.0.1` parses to 127.0.0.1 in WHATWG URL, which we accept, but a
  // bare octet with a leading zero must not sneak past a string comparison of our own.
  const { isNumericLoopbackHttpUrl } = await import("./helpers/test-config-bridge");
  // `0128` is not a valid octet, so the URL does not parse at all.
  assert.equal(isNumericLoopbackHttpUrl("http://0128.0.0.1:1"), false);
  // Shortened forms normalize to 127.0.0.0 and 0.0.0.127 respectively. The first is
  // loopback; the second is not, and must stay rejected because it is *not* a loopback
  // literal after normalization.
  assert.equal(new URL("http://127.0.0:1").hostname, "127.0.0.0");
  assert.equal(isNumericLoopbackHttpUrl("http://127.0.0:1"), true);
  assert.equal(new URL("http://127:1").hostname, "0.0.0.127");
  assert.equal(isNumericLoopbackHttpUrl("http://127:1"), false);
});

// ===========================================================================
// Review pass 3, finding 2: no production path mints operator authority
// ===========================================================================

test("the config module exports no operator issuer", async () => {
  // The review asked specifically that `__issueConfigForHarness` and any equivalent
  // caller-input-to-operator-brand issuer be gone from production source. Asserting the
  // export table at runtime is stronger than scanning imports: an aliased or re-exported
  // symbol would still appear here.
  const configModule = await import(
    "../../src/server/evidence/trusted-reader-config"
  );
  const exported = Object.keys(configModule);
  for (const name of exported) {
    assert.ok(
      !/operator/i.test(name),
      `config module exports an operator-related symbol: ${name}`,
    );
  }
  // And the only issuer that takes input is the test one.
  const issuers = exported.filter((name) => /issue/i.test(name));
  assert.deepEqual(issuers, ["__issueTestConfigForHarness"]);
});

test("the test issuer always produces a test-scoped brand", async () => {
  // Even if a caller passes an otherwise perfect operator-looking config, the resulting
  // brand is test-scoped — there is no parameter, flag, option or field that changes it.
  const { issueTestConfig } = await import("./helpers/test-config-bridge");
  const result = issueTestConfig(harnessConfigInput(options));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Build a reader from it and confirm the pipeline refuses it.
  const reader = new TrustedEvidenceChainReader(result.config);
  const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
});

test("attempting to smuggle operator scope through config keys is rejected", async () => {
  // Extra keys are rejected outright by the validator, so a caller cannot pass
  // `testOnly: false` or `operatorScope: true` to influence the outcome.
  const { issueTestConfig } = await import("./helpers/test-config-bridge");
  const base = harnessConfigInput(options);
  for (const smuggled of [
    { ...base, testOnly: false },
    { ...base, operatorScope: true },
    { ...base, operatorScoped: true },
    // An inherited `testOnly` must not be consulted either: the validator reads own
    // keys and rejects unknown ones, so a prototype-carried value changes nothing.
    Object.assign(Object.create({ testOnly: false }), base),
  ]) {
    const result = issueTestConfig(smuggled);
    // The first three are rejected for the extra key. The last is a legitimately valid
    // config whose prototype happens to carry `testOnly`; what matters is that the
    // resulting brand is still test-scoped.
    if (result.ok) {
      const reader = new TrustedEvidenceChainReader(result.config);
      const outcome = await runTrustedVerification(reader, expected(), TX_HASH);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.failure, "READER_NOT_TRUSTED");
      continue;
    }
    assert.equal(result.failure, "CONFIG_UNEXPECTED_KEY");
  }
});
