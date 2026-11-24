/**
 * The trusted Arbitrum Sepolia evidence reader (Phase 2C.2A).
 *
 * This is the only production path that can turn a transaction hash into a
 * confirmation-authorizing observation. It owns the acquisition sequence:
 *
 *  1. `eth_chainId` must equal 421614.
 *  2. `eth_getCode` at the **finalized** block must be non-empty and must not be an
 *     EIP-7702 delegation designator.
 *  3. Keccak-256 of that code must equal the operator-pinned manifest hash. The
 *     expected hash never comes from this RPC.
 *  4. A positive control (`admin()` via `eth_call` at the finalized block) must
 *     succeed and return a valid nonzero address matching the manifest.
 *  5. The configured Registry address must equal the persisted commitment's address.
 *  6. The transaction and receipt are fetched and cross-checked.
 *  7. The receipt's block is fetched by number and its canonical hash compared.
 *  8. The L2 `finalized` head is fetched; the receipt block must be at or below it.
 *  9. The receipt block is re-read after the finality query and must be unchanged.
 *
 * Everything is validated with canonical decimal strings and `BigInt`, never with
 * JavaScript numbers. Any failure yields a typed unverified outcome; there is no
 * fallback to `latest`, `safe`, or a fixed confirmation count.
 *
 * ## Trust model (stated plainly)
 *
 * This reader trusts the configured RPC endpoint to answer honestly. It is **not** a
 * light client: it does not verify receipt inclusion, Merkle proofs, or any chain
 * commitment. "Finalized" is the endpoint's assertion about Arbitrum's parent-chain
 * finality, nothing more. A malicious or compromised RPC can answer consistently and
 * lie. Pinning the bytecode hash and the address removes the *caller* from the trust
 * path; it does not remove the endpoint.
 */

import "server-only";

import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  EVIDENCE_ANCHORED_TOPIC,
  evaluateAnchorObservation,
  type AnchorEvaluationResult,
  type ChainObservation,
  type ExpectedAnchorCommitment,
  type ObservedAnchorEvent,
} from "./anchor-verification";
import {
  ReadOnlyRpcClient,
  RpcTransportError,
} from "./rpc-read-only-transport";
import {
  isBrandedReaderConfig,
  type OperatorTrustedReaderConfig,
} from "./trusted-reader-config";
import type { FinalityEvidence } from "./trusted-observation";
import type { ReaderAcquisition, ReaderDispatch } from "./reader-capability";

/** `admin()` — the public address getter on the Registry. */
const ADMIN_SELECTOR = "0xf851a440";
/** EIP-7702 delegation designator prefix: 0xef0100 || address. */
const EIP7702_PREFIX = "0xef0100";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type TrustedReaderFailure =
  | "RPC_UNAVAILABLE"
  | "WRONG_CHAIN"
  | "REGISTRY_CODE_MISSING"
  | "REGISTRY_DELEGATED"
  | "REGISTRY_CODE_HASH_MISMATCH"
  | "REGISTRY_ADMIN_INVALID"
  | "REGISTRY_ADMIN_MISMATCH"
  | "REGISTRY_ADDRESS_MISMATCH"
  | "TRANSACTION_MISSING"
  | "TRANSACTION_MALFORMED"
  | "RECEIPT_MISSING"
  | "RECEIPT_MALFORMED"
  | "RECEIPT_BLOCK_MISSING"
  | "RECEIPT_BLOCK_HASH_MISMATCH"
  | "FINALITY_UNAVAILABLE"
  | "FINALITY_MALFORMED"
  | "RECEIPT_BLOCK_NOT_FINALIZED"
  | "RECEIPT_BLOCK_CHANGED_DURING_FINALITY_CHECK";

export type TrustedReaderResult =
  | {
      readonly ok: true;
      readonly observation: ChainObservation;
      readonly finality: FinalityEvidence;
      /**
       * The runtime bytecode hash the reader measured and compared against the
       * pinned value. Carried on the result so the seal records what was actually
       * measured rather than a value re-supplied by a caller.
       */
      readonly runtimeBytecodeHash: string;
    }
  | { readonly ok: false; readonly failure: TrustedReaderFailure };

/**
 * The reader registry, and the only place a capability is ever written.
 *
 * Review pass 2 left this map in `reader-capability.ts` next to an exported
 * `attachReaderCapability`, so any module could mint a reader by importing the writer.
 * It now lives here, in module scope, with no exported writer at all. The constructor
 * below is the only code path that can add an entry, which makes "is a reader" and
 * "was constructed from a genuine branded config" the same statement.
 *
 * Only the lookup leaves this module.
 */
const DISPATCHERS = new WeakMap<object, ReaderDispatch>();

/** Attaches a capability. Module-private; reachable only from the constructor below. */
function attachReaderCapability(target: object, dispatch: ReaderDispatch): void {
  DISPATCHERS.set(target, dispatch);
}

/**
 * Resolves the dispatcher for a candidate reader, or `null`.
 *
 * This is the entire surface the authorization pipeline sees. It cannot create an
 * entry: a Proxy, `Object.create(TrustedEvidenceChainReader.prototype)`, a plain
 * object literal, or a cross-realm clone all miss, because none of them ran the
 * constructor.
 */
export function dispatchForReader(candidate: unknown): ReaderDispatch | null {
  if (candidate === null || typeof candidate !== "object") return null;
  return DISPATCHERS.get(candidate) ?? null;
}

function fail(failure: TrustedReaderFailure): TrustedReaderResult {
  return { ok: false, failure };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CANONICAL_ADDRESS = /^0x[0-9a-f]{40}$/;
const CANONICAL_BYTES32 = /^0x[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const HEX_QUANTITY = /^0x[0-9a-f]+$/;

function address(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return CANONICAL_ADDRESS.test(lowered) ? lowered : null;
}

function bytes32(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return CANONICAL_BYTES32.test(lowered) ? lowered : null;
}

/** Parses a JSON-RPC hex quantity into a canonical decimal string. */
function hexQuantity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  if (!HEX_QUANTITY.test(lowered)) return null;
  return BigInt(lowered).toString(10);
}

function decimal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return POSITIVE_DECIMAL.test(value) ? value : null;
}

function blockTag(tag: "latest" | "safe" | "finalized") {
  return tag;
}

/**
 * A transaction hash is a non-zero 32-byte value. A zero hash is accepted by the
 * pattern but can never describe a real transaction, so it is rejected here rather
 * than producing a confusing downstream failure.
 */
function transactionHash(value: unknown): string | null {
  const parsed = bytes32(value);
  if (!parsed) return null;
  return parsed === `0x${"0".repeat(64)}` ? null : parsed;
}

/** Reads the L2 finalized head as `{ number, hash }`, both strictly validated. */
async function readFinalizedHead(
  rpc: ReadOnlyRpcClient,
): Promise<{ number: bigint; hash: string } | null> {
  const block = await rpc.call("eth_getBlockByNumber", [
    blockTag("finalized"),
    false,
  ]);
  if (!isPlainObject(block)) return null;
  const number = hexQuantity(block.number);
  const hash = bytes32(block.hash);
  if (!number || !hash) return null;
  return { number: BigInt(number), hash };
}

/**
 * The reader. Constructed from a validated `TrustedReaderConfig`; there is no
 * constructor path that accepts a URL, address or hash from a request.
 */
export class TrustedEvidenceChainReader {
  readonly #config: OperatorTrustedReaderConfig;
  readonly #rpc: ReadOnlyRpcClient;

  /**
   * Constructs a reader and registers its **capability**.
   *
   * The constructor refuses anything that is not a configuration this module branded.
   * It takes no transport argument: review pass 2 removed the exported
   * `registerTestTransport`, so no code path can inject a fetch into a reader that
   * the pipeline would consider authoritative.
   *
   * Registration is what makes `runTrustedVerification` willing to use this object;
   * the class identity alone does not, and neither does the shape.
   */
  constructor(config: OperatorTrustedReaderConfig) {
    if (!isBrandedReaderConfig(config))
      throw new Error("TRUSTED_READER_REQUIRES_BRANDED_CONFIG");
    this.#config = config;
    this.#rpc = new ReadOnlyRpcClient({
      url: config.rpcUrl,
      timeoutMs: config.timeoutMs,
    });

    // The dispatcher closes over THIS instance's private state. The pipeline calls
    // the closure, never a method on a caller-supplied object, so a Proxy or a
    // prototype imitation cannot interpose.
    attachReaderCapability(this, {
      pinnedRegistryAddress: config.registryAddress,
      operatorScoped: !config.testOnly,
      read: (input) => this.#acquire(input),
    });
  }

  /**
   * The pinned Registry address. Exposed for diagnostics only; the pipeline reads the
   * capability's copy, not this getter.
   */
  get pinnedRegistryAddress(): string {
    return this.#config.registryAddress;
  }

  /**
   * Acquires and validates an observation for `transactionHash`, which must be the
   * transaction the persisted commitment expects.
   */
  async readAnchorObservation(input: {
    readonly transactionHash: string;
    readonly registryAddress: string;
  }): Promise<TrustedReaderResult> {
    return this.#acquire(input);
  }

  /** The real acquisition. Reached by the capability dispatcher. */
  async #acquire(input: {
    readonly transactionHash: string;
    readonly registryAddress: string;
  }): Promise<TrustedReaderResult> {
    const expectedRegistry = address(input.registryAddress);
    if (!expectedRegistry) return fail("REGISTRY_ADDRESS_MISMATCH");
    // The persisted commitment's Registry must be the pinned one. A configured
    // reader must never be talked into reading a different contract.
    if (expectedRegistry !== this.#config.registryAddress)
      return fail("REGISTRY_ADDRESS_MISMATCH");

    const requestedHash = transactionHash(input.transactionHash);
    if (!requestedHash) return fail("TRANSACTION_MALFORMED");

    try {
      // ---- 1. chain id ----
      const chainIdRaw = await this.#rpc.call("eth_chainId", []);
      const chainId = hexQuantity(chainIdRaw);
      if (!chainId || chainId !== ARBITRUM_SEPOLIA_CHAIN_ID.toString())
        return fail("WRONG_CHAIN");

      // ---- 2/3/4. Registry identity, measured at the finalized head ----
      const identityFailure = await this.#verifyRegistryIdentity();
      if (identityFailure) return fail(identityFailure);

      // ---- 5/6. transaction + receipt ----
      const tx = await this.#rpc.call("eth_getTransactionByHash", [
        requestedHash,
      ]);
      if (tx === null) return fail("TRANSACTION_MISSING");
      if (!isPlainObject(tx)) return fail("TRANSACTION_MALFORMED");
      const txHash = transactionHash(tx.hash);
      const txFrom = address(tx.from);
      const txTo = address(tx.to);
      if (!txHash || !txFrom || !txTo) return fail("TRANSACTION_MALFORMED");
      if (txHash !== requestedHash) return fail("TRANSACTION_MALFORMED");
      if (txTo !== this.#config.registryAddress)
        return fail("TRANSACTION_MALFORMED");

      const rawReceipt = await this.#rpc.call("eth_getTransactionReceipt", [
        requestedHash,
      ]);
      if (rawReceipt === null) return fail("RECEIPT_MISSING");
      if (!isPlainObject(rawReceipt)) return fail("RECEIPT_MALFORMED");
      const receiptHash = transactionHash(rawReceipt.transactionHash);
      if (!receiptHash || receiptHash !== requestedHash)
        return fail("RECEIPT_MALFORMED");
      const receiptBlockNumberHex = hexQuantity(rawReceipt.blockNumber);
      const receiptBlockHash = bytes32(rawReceipt.blockHash);
      if (!receiptBlockNumberHex || !receiptBlockHash)
        return fail("RECEIPT_MALFORMED");
      const receiptTo = address(rawReceipt.to);
      if (!receiptTo || receiptTo !== this.#config.registryAddress)
        return fail("RECEIPT_MALFORMED");
      const receiptFrom = address(rawReceipt.from);
      if (!receiptFrom) return fail("RECEIPT_MALFORMED");
      const status = rawReceipt.status;
      if (status !== "0x1" && status !== "0x0")
        return fail("RECEIPT_MALFORMED");
      if (!Array.isArray(rawReceipt.logs)) return fail("RECEIPT_MALFORMED");

      // ---- 7. the receipt's block, by number, must carry that exact hash ----
      const receiptBlock = await this.#rpc.call("eth_getBlockByNumber", [
        rawReceipt.blockNumber,
        false,
      ]);
      if (!isPlainObject(receiptBlock)) return fail("RECEIPT_BLOCK_MISSING");
      const blockHash = bytes32(receiptBlock.hash);
      const blockNumber = hexQuantity(receiptBlock.number);
      if (!blockHash || !blockNumber) return fail("RECEIPT_BLOCK_MISSING");
      if (blockNumber !== receiptBlockNumberHex)
        return fail("RECEIPT_BLOCK_HASH_MISMATCH");
      if (blockHash !== receiptBlockHash)
        return fail("RECEIPT_BLOCK_HASH_MISMATCH");

      // ---- 8. finality: the receipt block must be at or below the finalized head ----
      let finalized: { number: bigint; hash: string } | null;
      try {
        finalized = await readFinalizedHead(this.#rpc);
      } catch (error) {
        // A provider that does not support `finalized` lands here. There is no
        // fallback: an unsupported tag means the evidence is not eligible.
        if (error instanceof RpcTransportError)
          return fail("FINALITY_UNAVAILABLE");
        throw error;
      }
      if (!finalized) return fail("FINALITY_MALFORMED");
      if (BigInt(receiptBlockNumberHex) > finalized.number)
        return fail("RECEIPT_BLOCK_NOT_FINALIZED");

      // ---- 9. re-read the receipt block after the finality query ----
      const recheck = await this.#rpc.call("eth_getBlockByNumber", [
        rawReceipt.blockNumber,
        false,
      ]);
      if (!isPlainObject(recheck))
        return fail("RECEIPT_BLOCK_CHANGED_DURING_FINALITY_CHECK");
      const recheckHash = bytes32(recheck.hash);
      if (!recheckHash || recheckHash !== receiptBlockHash)
        return fail("RECEIPT_BLOCK_CHANGED_DURING_FINALITY_CHECK");

      const logs: ObservedAnchorEvent[] = [];
      for (const log of rawReceipt.logs) {
        if (!isPlainObject(log)) return fail("RECEIPT_MALFORMED");
        const logAddress = address(log.address);
        if (!logAddress) return fail("RECEIPT_MALFORMED");
        if (!Array.isArray(log.topics)) return fail("RECEIPT_MALFORMED");
        const topics: string[] = [];
        for (const topic of log.topics) {
          const parsedTopic = bytes32(topic);
          if (!parsedTopic) return fail("RECEIPT_MALFORMED");
          topics.push(parsedTopic);
        }
        if (
          typeof log.data !== "string" ||
          !/^0x[0-9a-f]*$/.test(log.data.toLowerCase())
        )
          return fail("RECEIPT_MALFORMED");
        logs.push(
          Object.freeze({
            address: logAddress,
            topics: Object.freeze(topics),
            data: log.data.toLowerCase(),
          }),
        );
      }

      const observation: ChainObservation = Object.freeze({
        chainId,
        transactionHash: txHash,
        transactionFrom: txFrom,
        transactionTo: txTo,
        receipt: Object.freeze({
          transactionHash: receiptHash,
          status:
            status === "0x1" ? ("success" as const) : ("reverted" as const),
          from: receiptFrom,
          to: receiptTo,
          blockNumber: receiptBlockNumberHex,
          blockHash: receiptBlockHash,
          logs: Object.freeze(logs),
        }),
        // Derived here, inside the reader, from the checks above. A caller cannot
        // assert this value; it is not a function parameter anywhere.
        registryIdentity: "verified" as const,
      });

      return {
        ok: true,
        observation,
        finality: Object.freeze({
          level: "finalized" as const,
          finalizedBlockNumber: finalized.number.toString(10),
          finalizedBlockHash: finalized.hash,
          receiptBlockHash,
          receiptBlockNumber: BigInt(receiptBlockNumberHex).toString(10),
        }),
        runtimeBytecodeHash: this.#config.runtimeBytecodeHash,
      };
    } catch (error) {
      if (error instanceof RpcTransportError) return fail("RPC_UNAVAILABLE");
      throw error;
    }
  }

  /** Steps 2-4: code, hash and the `admin()` positive control. */
  async #verifyRegistryIdentity(): Promise<TrustedReaderFailure | null> {
    const code = await this.#rpc.call("eth_getCode", [
      this.#config.registryAddress,
      blockTag("finalized"),
    ]);
    if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code))
      return "REGISTRY_CODE_MISSING";
    const lowered = code.toLowerCase();
    // Nothing deployed, or an empty account.
    if (lowered === "0x" || lowered.length <= 2) return "REGISTRY_CODE_MISSING";
    // EIP-7702: the account delegates to another contract. Its own "code" is just
    // a designator, and every call is executed by the delegate. That is not our
    // Registry, even if the designator target happens to be.
    if (lowered.startsWith(EIP7702_PREFIX)) return "REGISTRY_DELEGATED";

    const { keccak256 } = await import("ethers");
    const observedHash = keccak256(lowered).toLowerCase();
    if (observedHash !== this.#config.runtimeBytecodeHash)
      return "REGISTRY_CODE_HASH_MISMATCH";

    // Positive control: the contract must actually answer `admin()` at the same
    // block, and answer with the address the manifest pins. This catches code that
    // hashes correctly but was self-destructed, replaced, or is not answering.
    const adminResult = await this.#rpc.call("eth_call", [
      { to: this.#config.registryAddress, data: ADMIN_SELECTOR },
      blockTag("finalized"),
    ]);
    if (typeof adminResult !== "string" || !/^0x[0-9a-f]*$/i.test(adminResult))
      return "REGISTRY_ADMIN_INVALID";
    const result = adminResult.toLowerCase();
    // A revert, or an empty return, is not a valid administrator.
    if (result === "0x" || result.length !== 66)
      return "REGISTRY_ADMIN_INVALID";
    // `admin()` returns a single 32-byte ABI word: 12 bytes of zero padding followed
    // by the 20-byte address. The padding must actually be zero — a response whose
    // leading 24 hex characters are nonzero is not a canonical ABI encoding of an
    // address, and extracting the trailing 20 bytes would silently accept it.
    const padded = result.slice(2);
    if (!/^0{24}$/.test(padded.slice(0, 24)))
      return "REGISTRY_ADMIN_INVALID";
    const admin = address(`0x${padded.slice(24)}`);
    if (!admin || admin === ZERO_ADDRESS) return "REGISTRY_ADMIN_INVALID";
    if (admin !== this.#config.administrator) return "REGISTRY_ADMIN_MISMATCH";
    return null;
  }
}

/**
 * Evaluates a trusted observation against a persisted commitment.
 *
 * Unlike the Phase 2C.1 entry point, this accepts only a `TrustedReaderResult` —
 * the reader's own output type. It cannot be called with a hand-written
 * `ChainObservation`, because that type has no `ok` discriminant. The proof is then
 * minted by the same pure evaluator as before.
 */
export function evaluateTrustedObservation(
  expected: ExpectedAnchorCommitment,
  trusted: Extract<TrustedReaderResult, { ok: true }>,
): AnchorEvaluationResult {
  return evaluateAnchorObservation(expected, trusted.observation);
}

/** Exposed for diagnostics: the topic the reader filters on. */
export const TRUSTED_READER_EVENT_TOPIC = EVIDENCE_ANCHORED_TOPIC;
