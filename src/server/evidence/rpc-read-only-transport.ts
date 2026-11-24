/**
 * Read-only JSON-RPC transport for the trusted evidence reader.
 *
 * Security properties this module is responsible for:
 *
 * - **Method allowlist.** Only the six read methods below can be issued. Every
 *   write, submission, wallet, signing or unknown method is rejected locally with
 *   no network call, so a compromised caller cannot turn this into a broadcaster.
 * - **Endpoint is not caller-controlled.** The URL is a constructor argument that
 *   `trusted-reader-config.ts` supplies from server-side configuration. Nothing in
 *   an API request can reach it.
 * - **Strict response validation.** JSON-RPC version, request/response id echo,
 *   HTTP status, content type and result shape are all checked. A mismatched id is
 *   an error, not a retry with the body of another request.
 * - **Bounded timeouts.** Every request carries an `AbortSignal` deadline.
 *
 * This module performs no call at import time and is never exercised against a
 * public endpoint by the test suite; tests drive it with an in-process mock server.
 */

import "server-only";

import { createHash } from "node:crypto";

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
  | "RPC_RESULT_SHAPE";

export class RpcTransportError extends Error {
  constructor(readonly failure: RpcFailure) {
    super(failure);
    this.name = "RpcTransportError";
  }
}

export interface RpcTransportOptions {
  readonly url: string;
  /** Milliseconds before the request is aborted. */
  readonly timeoutMs: number;
  /** Injected in tests only. Production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Monotonic request ids. Injected in tests for determinism. */
  readonly nextId?: () => number;
}

const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A single-shot JSON-RPC client restricted to read methods.
 *
 * The client is cheap and stateless apart from its id counter; `trusted-reader.ts`
 * creates one per verification so a request cannot inherit another's state.
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
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
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
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError")
        throw new RpcTransportError("RPC_TIMEOUT");
      throw new RpcTransportError("RPC_HTTP_STATUS");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new RpcTransportError("RPC_HTTP_STATUS");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json"))
      throw new RpcTransportError("RPC_CONTENT_TYPE");

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new RpcTransportError("RPC_INVALID_JSON");
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new RpcTransportError("RPC_INVALID_JSON");
    }

    if (!isPlainObject(envelope))
      throw new RpcTransportError("RPC_INVALID_ENVELOPE");
    if (envelope.jsonrpc !== "2.0")
      throw new RpcTransportError("RPC_VERSION_MISMATCH");
    if (envelope.id !== id) throw new RpcTransportError("RPC_ID_MISMATCH");
    if ("error" in envelope && envelope.error !== undefined)
      throw new RpcTransportError("RPC_ERROR_RESPONSE");
    if (!("result" in envelope))
      throw new RpcTransportError("RPC_RESULT_SHAPE");
    return envelope.result;
  }
}

/**
 * Keccak-256 of deployed bytecode.
 *
 * `ethers` computes this locally; the hash never comes from the RPC. The expected
 * value it is compared against comes from the operator-pinned manifest, which is
 * the property that makes the comparison meaningful.
 */
export async function runtimeBytecodeHashOf(code: string): Promise<string> {
  const { keccak256 } = await import("ethers");
  return keccak256(code).toLowerCase();
}

export { createHash };
