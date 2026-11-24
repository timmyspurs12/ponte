import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
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
