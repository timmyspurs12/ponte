/**
 * Read-only JSON-RPC transport for the trusted evidence reader.
 *
 * Security properties this module is responsible for:
 *
 * - **Method allowlist.** Only the six read methods below can be issued. Every
 *   write, submission, wallet, signing or unknown method is rejected locally with
 *   no network call, so a compromised caller cannot turn this into a broadcaster.
 * - **Endpoint is not caller-controlled.** The URL is supplied by a branded,
 *   operator-sourced configuration. Nothing in an API request can reach it.
 * - **Strict response validation.** JSON-RPC version, request/response id echo,
 *   HTTP status, content type and result shape are all checked. A mismatched id is
 *   an error, not a retry with the body of another request.
 * - **A bounded deadline over the whole operation.** One timer covers the wait for
 *   headers, the transfer of the body and the parse of the JSON. It is cleared only
 *   after the body has been consumed, so an endpoint that sends headers promptly and
 *   then stalls the body is still timed out.
 * - **A bounded body size.** `MAX_RPC_RESPONSE_BYTES` caps buffering. The limit is
 *   enforced from `Content-Length` when it is honest and, more importantly, from the
 *   byte stream while reading, so an understated or absent length cannot exhaust
 *   memory.
 *
 * This module performs no call at import time and is never exercised against a
 * public endpoint by the test suite; tests drive it with an in-process mock server.
 */

import "server-only";

/** The only methods the evidence reader may issue, and their argument arity. */
export const READ_ONLY_RPC_METHODS = Object.freeze({
  eth_chainId: 0,
  eth_getTransactionByHash: 1,
  eth_getTransactionReceipt: 1,
  eth_getBlockByNumber: 2,
  eth_getCode: 2,
  eth_call: 2,
} as const);

export type ReadOnlyRpcMethod = keyof typeof READ_ONLY_RPC_METHODS;

export type RpcFailure =
  | "RPC_METHOD_NOT_ALLOWED"
  | "RPC_URL_INVALID"
  | "RPC_TIMEOUT"
  | "RPC_HTTP_STATUS"
  | "RPC_CONTENT_TYPE"
  | "RPC_INVALID_JSON"
  | "RPC_INVALID_ENVELOPE"
  | "RPC_VERSION_MISMATCH"
  | "RPC_ID_MISMATCH"
  | "RPC_ERROR_RESPONSE"
  | "RPC_RESULT_SHAPE"
  | "RPC_RESPONSE_TOO_LARGE";

export class RpcTransportError extends Error {
  constructor(readonly failure: RpcFailure) {
    super(failure);
    this.name = "RpcTransportError";
  }
}

export interface RpcTransportOptions {
  readonly url: string;
  /** Milliseconds covering headers, body transfer and parsing. */
  readonly timeoutMs: number;
  /** Injected only through a test-scoped reader; production uses `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Monotonic request ids. Injected in tests for determinism. */
  readonly nextId?: () => number;
}

const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;

/**
 * Hard ceiling on a JSON-RPC response body.
 *
 * A malicious or broken endpoint can stream indefinitely, and unbounded buffering is
 * a denial-of-service vector against the server process. 2 MiB is far above any
 * legitimate response for the six read methods — the largest is a contract's runtime
 * bytecode, typically well under 30 KiB — and small enough to bound memory.
 */
export const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a body without buffering more than `limit` bytes.
 *
 * Streams chunk by chunk and cancels as soon as the ceiling is crossed, so an
 * endpoint that lies about `Content-Length` (or omits it) still cannot exhaust
 * memory. The body reader is always released, and cancelled on the oversized path.
 */
async function readBounded(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) {
    // No stream available: read, then refuse anything over the limit before use.
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit)
      throw new RpcTransportError("RPC_RESPONSE_TOO_LARGE");
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new RpcTransportError("RPC_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or errored; nothing further to do.
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * A single-shot JSON-RPC client restricted to read methods.
 *
 * The client is cheap and stateless apart from its id counter; the reader creates
 * one per verification so a request cannot inherit another's state.
 */
export class ReadOnlyRpcClient {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #nextId: () => number;
  #idCounter = 0;

  constructor(options: RpcTransportOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new RpcTransportError("RPC_URL_INVALID");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new RpcTransportError("RPC_URL_INVALID");
    // Credentials in the URL would leak into logs and error messages.
    if (parsed.username || parsed.password)
      throw new RpcTransportError("RPC_URL_INVALID");
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < MIN_TIMEOUT_MS ||
      options.timeoutMs > MAX_TIMEOUT_MS
    )
      throw new RpcTransportError("RPC_TIMEOUT");

    this.#url = parsed.toString();
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#nextId =
      options.nextId ??
      (() => {
        this.#idCounter += 1;
        return this.#idCounter;
      });
  }

  /**
   * Issues one read method and returns the raw `result` value.
   *
   * `params` is validated against the method's arity so an unexpected extra
   * argument (for example a block tag injected by a caller) cannot slip through.
   */
  async call(
    method: ReadOnlyRpcMethod,
    params: readonly unknown[],
  ): Promise<unknown> {
    const arity = READ_ONLY_RPC_METHODS[method];
    if (arity === undefined)
      throw new RpcTransportError("RPC_METHOD_NOT_ALLOWED");
    if (params.length !== arity)
      throw new RpcTransportError("RPC_METHOD_NOT_ALLOWED");

    const id = this.#nextId();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const controller = new AbortController();
    // One deadline for the *entire* call, not just the network phase: the timestamp is
    // captured here and re-checked after parsing below, so a response that arrives in
    // time but parses slowly still fails as a timeout. The timer is also what aborts an
    // in-flight request or a stalled body read.
    const startedAt = Date.now();
    const deadlineAt = startedAt + this.#timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let text: string;
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: controller.signal,
        // Never forward ambient credentials to the RPC endpoint.
        credentials: "omit",
        redirect: "error",
      });

      if (!response.ok) throw new RpcTransportError("RPC_HTTP_STATUS");
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json"))
        throw new RpcTransportError("RPC_CONTENT_TYPE");

      // Reject an honestly oversized body before reading a single byte of it.
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_RPC_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new RpcTransportError("RPC_RESPONSE_TOO_LARGE");
      }

      // Body consumption happens *inside* the timed region.
      text = await readBounded(response, MAX_RPC_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof RpcTransportError) throw error;
      if ((error as { name?: string })?.name === "AbortError")
        throw new RpcTransportError("RPC_TIMEOUT");
      throw new RpcTransportError("RPC_HTTP_STATUS");
    } finally {
      clearTimeout(timer);
    }

    // The deadline covers parsing too. A pathological but well-formed body can spend
    // arbitrary time in `JSON.parse`, and a response that lands after the deadline must
    // not be accepted just because the bytes arrived in time.
    if (Date.now() > deadlineAt) throw new RpcTransportError("RPC_TIMEOUT");

    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new RpcTransportError("RPC_INVALID_JSON");
    }

    if (Date.now() > deadlineAt) throw new RpcTransportError("RPC_TIMEOUT");

    if (!isPlainObject(envelope))
      throw new RpcTransportError("RPC_INVALID_ENVELOPE");
    if (envelope.jsonrpc !== "2.0")
      throw new RpcTransportError("RPC_VERSION_MISMATCH");
    if (envelope.id !== id) throw new RpcTransportError("RPC_ID_MISMATCH");
    if ("error" in envelope && envelope.error !== undefined)
      throw new RpcTransportError("RPC_ERROR_RESPONSE");
    if (!("result" in envelope)) throw new RpcTransportError("RPC_RESULT_SHAPE");
    return envelope.result;
  }
}

/**
 * Keccak-256 of deployed bytecode.
 *
 * `ethers` computes this locally; the hash never comes from the RPC. The expected
 * value it is compared against comes from the operator-pinned manifest, which is
 * what makes the comparison meaningful.
 */
export async function runtimeBytecodeHashOf(code: string): Promise<string> {
  const { keccak256 } = await import("ethers");
  return keccak256(code).toLowerCase();
}
