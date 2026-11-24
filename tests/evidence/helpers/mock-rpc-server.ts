/**
 * In-process mock JSON-RPC server for the trusted-reader tests.
 *
 * Tests must be deterministic and network-free. This harness binds to loopback on
 * an ephemeral port and speaks HTTP + JSON-RPC 2.0 so the *real* transport module is
 * exercised — method allowlisting, envelope validation, id echo, timeouts and error
 * handling all run against a real socket, not a stubbed `fetch`.
 *
 * It is not a fake reader: it is a fake *endpoint*. The reader under test is the
 * production class; only the peer it talks to is simulated. That distinction matters,
 * because the security property being tested is "a fabricated observation cannot
 * mint a confirmation-authorizing result" — which requires the real reader.
 *
 * Nothing here is reachable from the application runtime. This file lives under
 * `tests/` and is imported only by tests.
 */

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { keccak256 } from "ethers";
import type { AddressInfo } from "node:net";

export interface RpcCall {
  readonly method: string;
  readonly params: readonly unknown[];
}

export type RpcHandler = (call: RpcCall) => unknown | Promise<unknown>;

export interface MockRpcServer {
  readonly url: string;
  readonly calls: RpcCall[];
  /** Replace the responder mid-test. */
  setHandler(handler: RpcHandler): void;
  /** Replace the raw response writer, for malformed-envelope tests. Pass null to clear. */
  setRawResponder(
    responder:
      ((body: unknown, res: import("node:http").ServerResponse) => void) | null,
  ): void;
  close(): Promise<void>;
}

/**
 * Starts the mock server.
 *
 * `handler` returns the JSON-RPC `result`. Throwing produces a JSON-RPC `error`
 * object. Use `setRawResponder` to bypass all of that and emit arbitrary bytes.
 */
export async function startMockRpcServer(
  handler: RpcHandler,
): Promise<MockRpcServer> {
  const calls: RpcCall[] = [];
  let currentHandler: RpcHandler = handler;
  let rawResponder:
    ((body: unknown, res: import("node:http").ServerResponse) => void) | null =
    null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not json at all");
        return;
      }
      const envelope = body as {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      const call: RpcCall = {
        method: String(envelope.method),
        params: Array.isArray(envelope.params) ? envelope.params : [],
      };
      calls.push(call);

      if (rawResponder) {
        rawResponder(body, res);
        return;
      }

      Promise.resolve()
        .then(() => currentHandler(call))
        .then((result) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result }));
        })
        .catch((error: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: envelope.id,
              error: {
                code: -32000,
                message: String((error as Error)?.message),
              },
            }),
          );
        });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setHandler(next) {
      currentHandler = next;
    },
    setRawResponder(next) {
      rawResponder = next;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** `keccak256` of an arbitrary string, as the reader would compute over bytecode. */
export function keccakOf(value: string): string {
  return keccak256(value).toLowerCase();
}

/** Deterministic 32-byte hex from a label, for stable fixture values. */
export function hex32(label: string): string {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

/** Encode a decimal/hex number as a JSON-RPC quantity. */
export function quantity(value: number | bigint): string {
  return `0x${BigInt(value).toString(16)}`;
}
