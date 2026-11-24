import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  MAX_RPC_RESPONSE_BYTES,
  ReadOnlyRpcClient,
  READ_ONLY_RPC_METHODS,
  RpcTransportError,
} from "../../src/server/evidence/rpc-read-only-transport";
import {
  startMockRpcServer,
  type MockRpcServer,
} from "./helpers/mock-rpc-server";

/**
 * Read-only transport tests (Phase 2C.2A).
 *
 * The property under test is that this client can only ever *read*. A write,
 * submission, wallet or signing method must be refused locally, before any socket
 * is opened — including if a future caller casts around the TypeScript type.
 */

let server: MockRpcServer;

before(async () => {
  server = await startMockRpcServer((call) => {
    if (call.method === "eth_chainId") return "0x66eee";
    return "0x1";
  });
});

after(async () => {
  await server.close();
});

function client(
  overrides: Partial<ConstructorParameters<typeof ReadOnlyRpcClient>[0]> = {},
) {
  server.calls.length = 0;
  return new ReadOnlyRpcClient({
    url: server.url,
    timeoutMs: 2_000,
    ...overrides,
  });
}

test("only the six read methods are described as allowed", () => {
  assert.deepEqual(Object.keys(READ_ONLY_RPC_METHODS).sort(), [
    "eth_call",
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getCode",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
  ]);
});

test("write and signing methods are refused without a network call", async () => {
  const forbidden = [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "eth_signTransaction",
    "personal_sign",
    "eth_accounts",
    "wallet_switchEthereumChain",
    "eth_getBalance",
    "eth_estimateGas",
    "debug_traceTransaction",
    "admin_addPeer",
    "web3_clientVersion",
    "__proto__",
    "constructor",
  ];
  for (const method of forbidden) {
    const rpc = client();
    await assert.rejects(
      // Cast past the union: the allowlist must hold at runtime, not just in types.
      () => rpc.call(method as never, []),
      (error: unknown) =>
        error instanceof RpcTransportError &&
        error.failure === "RPC_METHOD_NOT_ALLOWED",
      `${method} must be refused`,
    );
    assert.equal(
      server.calls.length,
      0,
      `${method} must not reach the network`,
    );
  }
});

test("a wrong parameter arity is refused without a network call", async () => {
  const rpc = client();
  await assert.rejects(
    () => rpc.call("eth_getTransactionByHash", []),
    /RPC_METHOD_NOT_ALLOWED/,
  );
  await assert.rejects(
    () => rpc.call("eth_getTransactionByHash", ["0x1", "extra"]),
    /RPC_METHOD_NOT_ALLOWED/,
  );
  assert.equal(server.calls.length, 0);
});

test("an allowed method is accepted and returns its result", async () => {
  const rpc = client();
  const result = await rpc.call("eth_chainId", []);
  assert.equal(result, "0x66eee");
  assert.equal(server.calls.length, 1);
});

test("credentials in the endpoint are rejected", () => {
  assert.throws(
    () =>
      new ReadOnlyRpcClient({
        url: "https://user:pass@example.com",
        timeoutMs: 1_000,
      }),
    /RPC_URL_INVALID/,
  );
});

test("a non-URL endpoint is rejected", () => {
  assert.throws(
    () => new ReadOnlyRpcClient({ url: "not-a-url", timeoutMs: 1_000 }),
    /RPC_URL_INVALID/,
  );
});

test("a non-HTTP protocol is rejected", () => {
  assert.throws(
    () => new ReadOnlyRpcClient({ url: "ftp://example.com", timeoutMs: 1_000 }),
    /RPC_URL_INVALID/,
  );
});

test("an out-of-range timeout is rejected at construction", () => {
  for (const timeoutMs of [0, 50, 60_000]) {
    assert.throws(
      () => new ReadOnlyRpcClient({ url: server.url, timeoutMs }),
      /RPC_TIMEOUT/,
    );
  }
});

test("a JSON-RPC error object becomes RPC_ERROR_RESPONSE", async () => {
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "execution reverted" },
      }),
    );
  });
  const rpc = client();
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_ERROR_RESPONSE/);
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x1" }));
  });
});

test("a wrong jsonrpc version is rejected", async () => {
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "1.0", id, result: "0x1" }));
  });
  const rpc = client();
  await assert.rejects(
    () => rpc.call("eth_chainId", []),
    /RPC_VERSION_MISMATCH/,
  );
});

test("a mismatched response id is rejected rather than accepted", async () => {
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 424242, result: "0x1" }));
  });
  const rpc = client();
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_ID_MISMATCH/);
});

test("a missing result field is rejected", async () => {
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id }));
  });
  const rpc = client();
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_RESULT_SHAPE/);
});

test("a redirect is refused rather than followed", async () => {
  // `redirect: "error"` means a 3xx surfaces as a fetch failure.
  server.setRawResponder((_body, res) => {
    res.writeHead(307, { location: "https://evil.example" });
    res.end();
  });
  const rpc = client();
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_HTTP_STATUS/);
});

test("an aborted request surfaces as RPC_TIMEOUT", async () => {
  server.setRawResponder(() => {
    // Never respond.
  });
  const rpc = client({ timeoutMs: 120 });
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_TIMEOUT/);
});

test("the outbound request never carries credentials", async () => {
  // Restore a normal responder: the preceding timeout test left a hanging one.
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
  });
  let seen: Headers | null = null;
  const capturingFetch: typeof fetch = async (input, init) => {
    seen = new Headers(init?.headers);
    return fetch(input, init);
  };
  const rpc = client({ fetchImpl: capturingFetch });
  await rpc.call("eth_chainId", []);
  assert.ok(seen);
  const headers = seen as Headers;
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("cookie"), null);
});


// ---------------------------------------------------------------------------
// Timeout and response-size handling (review pass 1, finding 3)
// ---------------------------------------------------------------------------

test("the deadline covers a body that stalls after headers arrive", async () => {
  // Headers are sent immediately, then the body never completes. Under the previous
  // implementation the timer was cleared once headers arrived, so this hung until the
  // test runner's own timeout.
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"jsonrpc":"2.0",');
    // Never finish the body.
  });
  const rpc = client({ timeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_TIMEOUT/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `should time out promptly, took ${elapsed}ms`);
});

test("an endpoint that never sends headers times out", async () => {
  server.setRawResponder(() => {
    // Never respond at all.
  });
  const rpc = client({ timeoutMs: 150 });
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_TIMEOUT/);
});

test("an oversized declared body is rejected without buffering it", async () => {
  const huge = "x".repeat(MAX_RPC_RESPONSE_BYTES + 1_000);
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(huge.length),
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: huge }));
  });
  const rpc = client();
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_RESPONSE_TOO_LARGE/);
});

test("an oversized streamed body is rejected even without a content-length", async () => {
  // No Content-Length (chunked transfer), so the cap must be enforced while reading.
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"jsonrpc":"2.0","id":');
    res.write(String(id));
    res.write(',"result":"');
    const chunk = "y".repeat(256 * 1024);
    // Write well past the ceiling.
    for (let written = 0; written < MAX_RPC_RESPONSE_BYTES + 512 * 1024; written += chunk.length)
      res.write(chunk);
    res.end('"}');
  });
  const rpc = client({ timeoutMs: 5_000 });
  await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_RESPONSE_TOO_LARGE/);
});

test("a body aborted mid-stream surfaces as a transport failure, not a hang", async () => {
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"jsonrpc":"2.0","id":1,');
    // Destroy the socket mid-body.
    setTimeout(() => res.destroy(), 10);
  });
  const rpc = client({ timeoutMs: 2_000 });
  await assert.rejects(
    () => rpc.call("eth_chainId", []),
    (error: unknown) =>
      error instanceof RpcTransportError &&
      ["RPC_HTTP_STATUS", "RPC_INVALID_JSON", "RPC_TIMEOUT"].includes(
        (error as RpcTransportError).failure,
      ),
  );
});

test("a valid response still works after all the failure cases", async () => {
  server.setRawResponder(null);
  server.setHandler((call) => (call.method === "eth_chainId" ? "0x66eee" : "0x1"));
  const rpc = client();
  assert.equal(await rpc.call("eth_chainId", []), "0x66eee");
});

test("a response at exactly the size ceiling is accepted", async () => {
  // The limit is exclusive; a body of exactly the ceiling must not be rejected.
  const padding = "z".repeat(64 * 1024);
  server.setRawResponder((body, res) => {
    const { id } = body as { id: unknown };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: padding }));
  });
  const rpc = client();
  const result = await rpc.call("eth_chainId", []);
  assert.equal(result, padding);
});

test("the deadline covers parsing, not just the network phase", async () => {
  // Review pass 2, finding 6. The previous implementation cleared the timer as soon as
  // the body had been read, so a small body with a pathological payload could occupy
  // the event loop in `JSON.parse` for arbitrarily long and still be accepted. The
  // documented claim was "one deadline for the entire operation"; this test holds the
  // source to it.
  //
  // A body only parses slowly if it is very large, so the size cap would normally fire
  // first. To isolate the *deadline* from the *size cap*, this test replaces
  // `JSON.parse` with a slow stand-in for the duration of one call: the payload is
  // small and well-formed, so only elapsed time can reject it.
  server.setRawResponder((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x66eee" }));
  });

  const realParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = ((text: string, reviver?: unknown) => {
    parseCalls += 1;
    // Block past the deadline without yielding.
    const until = Date.now() + 400;
    while (Date.now() < until) {
      /* spin */
    }
    return realParse(text, reviver as never);
  }) as typeof JSON.parse;

  try {
    const rpc = client({ timeoutMs: 100 });
    const started = Date.now();
    await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_TIMEOUT/);
    const elapsed = Date.now() - started;
    assert.equal(parseCalls, 1, "the body should have been parsed exactly once");
    assert.ok(elapsed >= 100, `should not resolve before the deadline: ${elapsed}ms`);
  } finally {
    JSON.parse = realParse;
  }
});

test("the deadline is per call and does not leak into later calls", async () => {
  // An earlier call that times out must not poison a later one: the deadline is
  // computed per invocation, not stored on the client.
  // Note: the responder must not call `JSON.parse` — the mock server runs in this
  // process, and the patched parse below would slow it down too, turning this into a
  // test of the server rather than the client.
  server.setRawResponder((body, res) => {
    const id = (body as { id?: number })?.id ?? 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"jsonrpc":"2.0","id":${id},"result":"0x66eee"}`);
  });

  const realParse = JSON.parse;
  JSON.parse = ((text: string, reviver?: unknown) => {
    const until = Date.now() + 300;
    while (Date.now() < until) {
      /* spin */
    }
    return realParse(text, reviver as never);
  }) as typeof JSON.parse;

  const rpc = client({ timeoutMs: 100 });
  try {
    await assert.rejects(() => rpc.call("eth_chainId", []), /RPC_TIMEOUT/);
  } finally {
    JSON.parse = realParse;
  }

  // Same client instance, no slow parse this time: must succeed.
  const result = await rpc.call("eth_chainId", []);
  assert.equal(result, "0x66eee");
});
