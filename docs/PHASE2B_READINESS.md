# Phase 2B.0 — Stylus feasibility gate and liquidity optimizer specification

Research date: **16 November 2026 UTC**. Baseline: merged main `acb82b5e1043fb4ab778ea474292126ccfdd1ab7` (PR #2); research branch `arena/db22c900-ponte`. This is a specification, not an implementation or an activation request.

## 1. Executive decision

**Overall: CONDITIONAL. Offline optimizer engineering is a reasonable next step; Sepolia deployment/activation is BLOCKED pending evidence and separate approval.** Stylus is not necessary to preserve the current simulation. There is no measured performance or gas advantage yet.

| Gate | Result | Meaning / exit evidence |
|---|---|---|
| Merged application inspection | PASS | Actual quote, model, service, repository and four requested documents reviewed at the baseline above |
| Exact fixture arithmetic | PASS | BigInt baseline independently invoked under Node 22 (historical; the project now pins Node 24.22.1); examples below. Not a market or execution test |
| Pure Rust optimizer design | CONDITIONAL | Bounded deterministic design below; no Rust implementation or parity run yet |
| Arena compilation readiness | FAIL | Rust, Cargo, rustup and Docker unavailable; build attempt exits 127 |
| Official starter WASM compilation | UNKNOWN | Attempt could not start; no binary produced |
| Read-only Sepolia CLI check | UNKNOWN | Attempt exits 127 before any RPC; independent RPC attempt also failed TLS |
| Sepolia identity / ArbWasm response | UNKNOWN | No JSON-RPC response obtained; precompile bytecode alone would not establish support or permission anyway |
| Current activation policy | CONDITIONAL | Official pause and proposed permissioned process documented; Sepolia operational authorization not verified |
| Snapshot temperature check | PASS (favorable result observed) | Closed Nov 5; For exceeds Against. This is not onchain authorization |
| Onchain governance / execution / usable Sepolia activation path | UNKNOWN | No verified proposal ID, execution receipt, live deployed mechanism or PONTE eligibility approval |
| Production or real-money readiness | FAIL | Existing simulation only; production auth remains closed; no token/PSP/liquidity/execution integrations |

**Can Sepolia proceed?** Read-only investigation may continue. **No deployment or activation should proceed on this evidence.** Offline specification/implementation does not require a wallet or testnet funding. Compilation success, generic quickstart language, a successful `eth_call`, and an audit publication are each insufficient authorization to activate.

No application/API/financial logic changed in 2B.0. No contracts deployed/activated, transactions submitted, wallets/keys created/requested, funds spent, accounts provisioned, paid services enabled or main modified. Connected hosting tools do not authorize deployment. Approved pt-BR/English frontend and Next.js/PostgreSQL architecture remain unchanged.

## 2. Dated primary-source activation evidence

All links below were retrieved on **2026-11-16**. Distinguish official notices, proposed policy, voting, audits and actual chain execution.

| Source | Observed fact | Limits |
|---|---|---|
| [Official activation pause notice](https://docs.arbitrum.io/notices/stylus-activation-pause-notice) | New and expired-program activation on **One and Nova** paused; active programs and keepalive remain available | Does not explicitly name Sepolia; omission is not permission |
| [Security Council emergency action, Oct 2 2026](https://forum.arbitrum.foundation/t/security-council-emergency-action-2-10-2026/31530) | Reports One/Nova activation gas set to `2^64−1`; Solidity unaffected; existing Stylus calls/keepalive unaffected. One programs reportedly do not expire before Aug 20 2027 | Official execution report; its listed transaction receipts were not independently queried here. Date is October 2, not February 10 |
| [Constitutional AIP: Stylus Activation Contract](https://forum.arbitrum.foundation/t/constitutional-aip-stylus-activation-contract/31605) | Proposed limited-audit/signature activation route, One scope; Nova excluded. Explicitly says Sepolia is outside that proposal but follows the same limited-audit/signature process | Proposal/thread is not proof that contracts were installed or that a new developer can activate today |
| [Nov 2 official vote roundup](https://forum.arbitrum.foundation/t/2-november-2026-roundup-of-active-upcoming-votes/31631) and [Snapshot proposal](https://snapshot.org/#/s:arbitrumfoundation.eth/proposal/0xbb3a36f5149d731c9fd11c150634b9bf90f95e73b8ec85e88cd5541149c6a8b6) | Identifies temperature check ending Nov 5 | Snapshot UI returned only login content; use public API evidence below, not an invented UI result |
| [Snapshot public API query](https://hub.snapshot.org/graphql?query=%7Bproposal(id%3A%220xbb3a36f5149d731c9fd11c150634b9bf90f95e73b8ec85e88cd5541149c6a8b6%22)%7Bid%20title%20state%20start%20end%20choices%20scores%20scores_total%20votes%7D%7D) | Matching title/ID; `closed`, Oct 29 20:45–Nov 5 20:45 UTC, 931 votes. Scores: For `73175697.23753905`, Against `54460630.129178114`, Abstain `978.3804577337288` (about 57.33% For excluding abstain) | Favorable nonbinding temperature check, **not constitutional onchain passage or execution** |
| [Trail of Bits summary, Nov 6](https://docs.arbitrum.io/audit-reports/2026_11_06_trail_of_bits_stylus_permissioned_deployer_summary_report.pdf) | Three engineer-days on Oct 2/4/5; private source commit `3c31811787912aacdb17de44feb1f67ea85d04b2`; reviewed permissioned deployer/gas setter/install action. One informational finding: root signatures commit fragment addresses, not fragment code; verify deployed fragment code before signing | Audit describes intended One/Nova/Sepolia use, broader than One proposal scope. Does not prove remediation, current chain scope, deployment or permission for PONTE |
| [Nov 11 official vote roundup](https://forum.arbitrum.foundation/t/11-november-2026-roundup-of-active-upcoming-votes/31691), [official onchain governance UI](https://alt.gov.arbitrum.foundation/) | No Stylus entry in retrieved active/latest listings | Partial listings are not exhaustive historical chain searches. Onchain proposal/passage/queue/execution remain UNKNOWN, not proven absent |

The emergency report lists Ethereum `0x30732bb7d2fe35e3ada0929ad5ab603c59355ad71a3f75d109bba0d3db97d11f`, One `0x9eb3a4be3ba777f9fc82250eddc10f8356731cc97c09a70801d30ce33322c652`, and Nova `0x79e0fed470dff7a22059b108e3f8f42eddd2b580a6771594060c4e7326c5f984`. These are source-reported references, not transactions sent or verified by this task.

### New-developer eligibility and prerequisites

Under the **proposed** process, being a new developer is not itself authorization or an automatic exclusion. Applicants need source/build configuration, a standard cargo-stylus reproducible build and matching codehash, a limited public pass/fail review through an approved ASP auditor, plus Foundation due diligence/terms and signature. The limited review checks Stylus-specific concerns, not full application/financial security. New versions and expired programs require the relevant process again. The thread identifies `activations@arbitrum.foundation`; nobody was contacted in this task. Terms were described as forthcoming in the Oct 28 discussion; current final terms, applicant eligibility, scheduling, costs and actual Sepolia signing endpoint remain unverified. Do not assume approval or a free audit.

The described mechanism temporarily reduces/restores activation gas atomically and relies on signatures/admin controls. Before any future activation request: obtain current Foundation/Sepolia instructions; verify the applicable chain, installed addresses/codehash/admin/signers and execution receipts; resolve audit finding status; obtain audit/terms/signatures for the exact reproducible artifact; separately obtain user authorization for any transaction. Snapshot success does not skip constitutional onchain voting, delays and execution for the One proposal. Sepolia's different governance scope does not waive the stated audit/signature prerequisite.

## 3. Arena toolchain and read-only evidence

### Observed environment

Probes during 19:35–19:37 UTC on 2026-11-16:

| Item | Exact observation | Status |
|---|---|---|
| OS / architecture | Debian GNU/Linux 12, Linux `6.1.158+`, `x86_64` | PASS |
| Node | `v22.22.3` | PASS for direct TS fixture probe |
| `rustc`, `cargo`, `rustup`, `cargo-stylus` | Not on PATH | FAIL |
| `wasm32-unknown-unknown` target | Cannot enumerate/install without rustup | UNKNOWN |
| Docker / daemon | `docker` unavailable; no Docker socket | FAIL for reproducible container builds |
| Native helpers | `/usr/bin/cc` present; clang/wasm-opt unavailable | Partial, not a Rust build |
| GitHub sources | Two official shallow clones succeeded under ignored `.cache/stylus-readiness/` | PASS for source inspection only |
| Rust distribution / crates index | HTTPS probes to `static.rust-lang.org` and `https://index.crates.io/config.json` failed curl TLS error 35 (`SSL_ERROR_SYSCALL`) | FAIL connectivity; not an upstream outage claim |
| Sepolia RPC | HTTPS batch request failed curl TLS error 35 | UNKNOWN chain behavior |

Arena outbound access is allowlisted; Rust distribution, crates index, RPC and container registries are outside the stated allowlist. No large local installation was requested from the user, and no toolchain installation was attempted. GitHub source availability cannot substitute for Rust artifacts, transitive crates and container images.

### Supported stack versus stale starter

[Official SDK release v0.10.10](https://github.com/OffchainLabs/stylus-sdk-rs/releases/tag/v0.10.10), published Oct 2 2026 at 23:25:48 UTC, was the latest observed release. Inspected tag commit **`76f8b055ec0bf421edd542b164dc2917c9e4e0bd`**: workspace Rust **1.91.0**, SDK/monorepo CLI **0.10.10**, target `wasm32-unknown-unknown`. Workspace alloy-primitives/sol-types `1.5.7`, alloy `1.7.3`; retain the exact lockfile rather than selecting loose dependency versions. Release addresses vulnerable ruint pin compatibility (>=1.17.1) and activation-pause errors; [PR #458](https://github.com/OffchainLabs/stylus-sdk-rs/pull/458) implements the latter. Confirm advisories again before future builds.

[Official quickstart](https://developer.arbitrum.io/stylus/quickstart) calls for Rust >=1.91. The separate [cargo-stylus repository](https://github.com/OffchainLabs/cargo-stylus) latest observed release `0.6.3` (Aug 2025) is not the current monorepo CLI baseline.

The requested [official standalone starter](https://github.com/OffchainLabs/stylus-hello-world/commit/5de573a787fefdaa7aeccebcda48e122e3653a0d) was cloned at **`5de573a787fefdaa7aeccebcda48e122e3653a0d`**: package `0.1.11`, SDK `0.9.0`, pinned Rust `1.87.0`. Its metadata and old install instructions lag the current SDK. Do not silently label it a current 0.10.10 build. Prefer the pinned SDK tag's `examples/hello_world` for the next current-stack test, explicitly documenting any starter migration and lockfile change.

### Commands actually attempted and outcomes

From the standalone starter clone:

```sh
cargo build --locked --release --target wasm32-unknown-unknown
# /bin/bash: cargo: command not found; exit 127
cargo stylus check --endpoint=https://sepolia-rollup.arbitrum.io/rpc
# /bin/bash: cargo: command not found; exit 127
```

Neither command reached compilation, validation or the network. No WASM, codehash, estimated fee or gas measurement exists. A successful future raw Cargo build alone will not prove Stylus validity.

Read-only RPC batch attempted against [official chain endpoint](https://developer.arbitrum.io/chain-info):

```sh
curl --connect-timeout 10 --max-time 20 \
  -H 'Content-Type: application/json' \
  --data '[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]},{"jsonrpc":"2.0","id":3,"method":"eth_getCode","params":["0x0000000000000000000000000000000000000071","latest"]}]' \
  https://sepolia-rollup.arbitrum.io/rpc
# curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL
```

Expected identity is **421614 / `0x66eee`**; actual chain ID, block number and getCode result are **UNKNOWN**, not zero. ArbWasm `0x71` comes from [activation documentation](https://developer.arbitrum.io/stylus/concepts/activation). Native precompiles can return empty ordinary bytecode; `getCode` is not a functional activation test.

[CLI check documentation](https://developer.arbitrum.io/stylus/cli-tools/check-and-deploy) and inspected v0.10.10 `stylus-tools/src/core/{check,activation}.rs` distinguish read-only simulation from transactions: check builds/processes/compresses code, checks active codehash status or simulates `activateProgram` with `eth_call` state overrides (temporary code/balance/random sender). It does **not** sign/send a transaction; its simulated value is not spending. Providers must support state overrides. A pause can cause this simulation to fail; a successful existing-code shortcut is not new-program activation permission.

### Reproduction after environment access is approved

Do not execute deploy/activate/integration examples, supply keys or work around TLS validation. First provision an approved Arena toolchain image/network allowance (not a paid resource) and record:

```sh
uname -a; cat /etc/os-release
rustc --version; cargo --version; rustup target list --installed
cargo stylus --version; docker version
# In a separate ignored checkout of the exact SDK commit above:
cargo install --path cargo-stylus --locked
cd examples/hello_world
cargo build --lib --locked --release --target wasm32-unknown-unknown
cargo stylus check --endpoint=https://sepolia-rollup.arbitrum.io/rpc
```

Pin Rust 1.91.0 and its wasm target, CLI source/lock and container image digest used for reproducibility; inspect tag README/toolchain before installation. A plain build and CLI-processed artifact are distinct. Capture commands, UTC time, commit, lockfile hash, features/profile, tool versions, stdout/stderr/exit status, raw and processed WASM sizes/hashes, endpoint/chain/block, and check result. The official process requires reproducible builds; absent Docker is not bypassed by calling a non-container build reproducible. Re-run the RPC batch first. Stop on unexpected chain, missing overrides, pause or permission errors. This plan is not authorization to install unapproved resources or send transactions.

## 4. Actual merged PONTE assessment

Reviewed `src/lib/quotes.ts`, `src/lib/models.ts`, `src/server/service.ts`, `src/server/repository.ts`, [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md), [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md), [PHASE2.md](PHASE2.md) and [README](../README.md). Descriptions here distinguish current behavior from the proposed optimizer.

### Existing arithmetic, not liquidity optimization

For BRL cents `F`, gross fixture output `G = floor(F*100/525)`; route output `O = floor(F*100*(10000-feeBps)/(525*10000))`; `feeMinor = G-O`; minimum `M = floor(O*9950/10000)`. All executable arithmetic is BigInt. The illustrative rate object `525/100` is **BRL per USDG**, so equal fixture decimal scales convert with inverse `100/525`. Do not apply the rate in the wrong direction or subtract an independently rounded fee.

| Candidate | Fee bps | Display slippage bps | Tolerance bps |
|---|---:|---:|---:|
| direct | 35 | 5 | 50 |
| split | 48 | 8 | 50 |
| multi | 65 | 12 | 50 |

**Displayed slippage does not alter expected or minimum output.** Minimum uses the separate fixed 50 bps tolerance. These three names are fixtures, not real pools, allocations or executed hops. There are no reserves, capacities, market snapshots, gas quotes or executable orders. `executionCostMinor="2"` is USD accounting cents, not USDG units, not gas and not subtracted from output. Fixture USDG has two decimals only by convention; no real chain/token address or decimals verified.

`quote()` accepts digit strings including zero/leading zeros up to 1,000,000,000; API input is stricter canonical positive BRL cents **100..1,000,000,000 inclusive**. Legacy `majorToMinor` accepts finite 0..10,000,000 major values only if equal to their two-decimal representation; display numbers must never feed execution arithmetic. New optimizer inputs should not accidentally expand API limits or break legacy fixture parity.

Direct Node invocation on the unchanged TS module produced these real baseline vectors (output / fee / minimum, all fixture units):

| F | direct | split | multi |
|---:|---|---|---|
| 100 | 18 / 1 / 17 | 18 / 1 / 17 | 18 / 1 / 17 |
| 2500000 | 474523 / 1667 / 472150 | 473904 / 2286 / 471534 | 473095 / 3095 / 470729 |
| 1000000000 | 189809523 / 666667 / 188860475 | 189561904 / 914286 / 188614094 | 189238095 / 1238095 / 188291904 |

Additional observed probes: `0` returns all-zero amounts; `0100` returns the same amounts as `100`. Command: `node --experimental-strip-types --input-type=module`, import `quote` from `./src/lib/quotes.ts`, call with these strings and print returned routes. Node emitted its module-type warning; no app source changed to suppress it. This was not a Rust differential benchmark or a rerun of the application suite.

### Preserve authoritative backend behavior

Server authentication/membership/role and same-origin checks precede mutation; strict schemas reject client-supplied authoritative output. Next Route Handlers → service → parameterized SQL repository → PG remains the application boundary. Tenant IDs come from authenticated context, not optimizer input.

Quotes are server-created immutable simulation snapshots with **15-minute expiry**, allowed from Pending payment/Funded. Funding is simulated and unique. Routing requires Funded, unexpired same-tenant/invoice quote and one of its candidates, persists expected/minimum and locks route. Settling rechecks expiry with PG `clock_timestamp()`, locks settlement and rejects a different submitted route; actual output equals expected in this simulation. SQL minimum constraints are not live swap enforcement. Routing expiry has no in-place recovery/requote: Failed is terminal and replacement is a new invoice.

All mutations run in a transaction: tenant/idempotency advisory lock, exact method/path/raw-body fingerprint, invoice row lock, state validation, domain writes, append-only correlated events, response snapshot and idempotency record. Replays return the original response, not current state. Composite tenant FKs, unique payment/settlement constraints and row locks remain necessary with Rust. Preserve Draft → Pending payment → Funded → Routing → Settled, allowed Failed edges and terminal states. Production financial API remains `503 AUTH_NOT_CONFIGURED`; no RLS or privileged-DBA-proof audit ledger claimed.

## 5. Proposed deterministic optimizer v1 (not implemented)

### Domain and bounded input

First implement **synthetic single-path candidate selection**, not arbitrary graph search or continuous split optimization. A supplied candidate may describe a synthetic direct, preallocated split or multi-hop path, but the pure core evaluates a normalized **aggregate rational quote**; it does not discover allocations, compound fees per hop, fetch pools or assert that aggregate parameters match a real AMM. Production adapters and split optimization need a separate reviewed model.

Proposed transport/domain structure (names are specification, not current API additions):

```text
OptimizeRequestV1 {
  version: 1, mode: SYNTHETIC,
  inputAsset: { namespace, id, decimals },
  outputAsset: { namespace, id, decimals },
  amountIn: U128, userMinOut: U128, toleranceBps: U16,
  asOfUnixSeconds: U64, expiresAtUnixSeconds: U64,
  snapshotId: Bytes32, candidates: CandidateV1[1..64]
}
CandidateV1 {
  routeId: Bytes32, snapshotId: Bytes32,
  rateNumerator: U128, rateDenominator: U128,
  feeBps: U16, estimatedImpactBps: U16,
  minInput: U128, maxInput: U128,
  availableInput: U128, availableOutput: U128,
  executionCostUsdCents: U128, expiresAtUnixSeconds: U64
}
OptimizeResultV1 {
  status, selectedRouteId?, amountIn, grossOut?, feeOut?, expectedOut?,
  minimumOut?, executionCostUsdCents?, effectiveExpiry?, snapshotId,
  evaluatedCount, rejected: [{ routeId, reason }]
}
```

JSON integers are canonical base-10 strings (`0` or nonzero without leading zeros); small enums/bps/version may be bounded JSON integers. ABI uses explicit uint128/uint16/uint64/bytes32 types and versioned tuples; never JSON floating point or architecture-sized `usize` as a wire field. Namespace/ID identifies **synthetic assets** now; a future real-token adapter must verify chain/address/decimals and reject mismatches. Supported decimals 0..38; rate already means **output base units per input base unit**. Never apply decimals again. BRL/fiat is offchain and cannot silently become an EVM input token.

Core input amount is 1..U128_MAX; PONTE simulation adapter preserves 100..1e9 BRL cents. Decimals do not make cents interchangeable across assets. Candidate capacity bounds are in input base units, availableOutput in output base units. `0` liquidity is unavailable, not unlimited. All candidates must match request snapshot; real liquidity provenance/freshness remains outside core. Synthetic namespace/snapshot must be unambiguously labeled and never persisted as market provenance.

### Validation, rounding and ranking

1. Validate version/mode/assets/decimals, canonical encodings, positive amount, 1..64 candidates, unique route IDs, shared snapshot, request `asOf < expiresAt`, tolerance and all bps 0..10000 inclusive. Denominator and numerator must be positive; `minInput <= maxInput`. Malformed structural input rejects the entire request with typed error. Sort IDs as unsigned 32-byte lexicographic values before evaluation/diagnostics; input order cannot select a winner.
2. Candidate expiry is valid only if `asOf < candidate.expiresAt`; effective expiry is the smaller request/candidate expiry. Skip expired candidates with `EXPIRED`. Caller supplies time to keep core pure; server uses trusted time, Stylus view uses block timestamp for validity. Core-supplied time is not authentication or a replay defense.
3. Require `minInput <= F <= maxInput` and `F <= availableInput`, inclusively; otherwise `BELOW_MIN`, `CAPACITY` or `INPUT_LIQUIDITY`. No partial fill, borrowing or fallback to invented liquidity.
4. With `N=rateNumerator`, `D=rateDenominator`, `f=feeBps`, evaluate `G=floor(F*N/D)` and `O=floor(F*N*(10000-f)/(D*10000))`. `feeOut=G-O`. Do not compute `G-floor(G*f/10000)`, which has different rounding. v1's supplied rate already incorporates any modeled expected price impact: **estimatedImpactBps is descriptive only**, not subtracted again. Tolerance is protection around O, not a second price estimate.
5. Require `O > 0` and `O <= availableOutput`; otherwise `ZERO_OUTPUT` or `OUTPUT_LIQUIDITY`. At f=10000, zero output is rejected, not selected as free liquidity. `T=floor(O*(10000-toleranceBps)/10000)`. Required minimum is `M=max(T,userMinOut)`; reject `USER_MIN_UNMET` if `M>O`. A 10000 tolerance can yield zero protection unless userMinOut is positive: expose/restrict such policy in the adapter, not hide it with rounding.
6. Rank eligible candidates by **highest expected output O**, then lowest `executionCostUsdCents`, then lexicographically smallest routeId. Cost is an accounting tie-breaker only, not subtracted from token output; USD cents cannot be mixed with token units without an approved exact conversion. No latency/slippage floating score. Return selected route and all derived fields; none eligible returns `NO_ROUTE` plus deterministic rejection reasons, not a fabricated quote.

Per-candidate rejection precedence is expiry → min input → max capacity → input liquidity → arithmetic range → zero output → output liquidity → user minimum. Structural errors are request-level; overflow is never silently treated as a cheaper route. Different future fee/impact/cost models require a version bump and new vectors.

### Overflow and resource safety

Use checked U256 intermediates in Rust/Stylus; TS reference uses BigInt but enforces the same U128 inputs/outputs and U256 intermediate ceiling at each multiplication. `F*N` fits U256 for U128 inputs, but multiplying by up to 10000 may not: explicitly detect/reject `ARITHMETIC_RANGE` before division, even if algebraic cancellation could make the final number fit. `D*10000`, `O*10000`, conversions and subtraction also checked; G/O/M/fee must fit U128. No wrapping, saturation, floats, panics or target-dependent arithmetic. Boundary tests must cover this deliberately conservative range policy. Checked division rejects zero first.

Bound candidate count to 64, route IDs to bytes32, errors to bounded enums; no recursive paths or unbounded strings/arrays in core/ABI. O(n) evaluation plus bounded canonical sorting is adequate. Native and WASM share the core and exact validation. This is not proof of acceptable WASM size/gas; measure it.

### Synthetic examples, not executable routes

At F=1000, tolerance=50, userMin=0, rate=2/1, ample declared synthetic liquidity:

| Synthetic candidate | Fee bps | Cost USD cents | Expected | Minimum |
|---|---:|---:|---:|---:|
| A | 100 | 3 | 1980 | 1970 |
| B | 50 | 4 | 1990 | 1980 |

B wins by output, not lower fee alone; if B maxInput=999, A wins; if both unavailable, NO_ROUTE. If output and cost tie, smallest bytes32 ID wins even after candidate permutation. These are hand-derived proposed test expectations, **not executed Rust/Stylus tests or market data**. Legacy fixture parity uses rate100/525 and the existing fees; do not port illustrative BRL major-unit rate525/100 directly as a base-unit output rate.

### Stateless view boundary and security limits

Future wrapper: versioned ABI `optimizeV1(...) view returns (...)` (or pure if it accepts all time/context explicitly), no storage mutations, payable methods, transfers, approvals, external pool calls, admin funds or execution authority. Validate caller-provided bounds and use block time in the view variant. Stateless recomputation cannot prove caller-supplied quotes/liquidity are truthful. It does not reserve liquidity, prevent replay, execute Pix, enforce a swap's minimum output or ensure settlement. Actual execution must independently enforce deadline/minOut/recipient/asset/chain/amount and reconcile receipts; out of scope here. Never put tenant identity, invoice details or business secrets in public calldata.

## 6. Architecture alternatives and recommendation

| Option | Benefits | Costs / risks | Decision |
|---|---|---|---|
| A. Pure Rust library + thin Stylus ABI wrapper | One arithmetic core, native differential testing, optional WASM view; clean no-I/O boundary | Rust/TS transport and U256 parity; toolchain/activation gating; wrapper/ABI cost | **Recommended target**, start with library only |
| B. Direct ABI-first Stylus contract | Fastest route to an onchain callable experiment, EVM interoperability | Couples logic/test harness to SDK; duplicates native logic or harder isolation; public inputs; activation blocked; no measured benefit | Not first implementation |
| C. Offchain Rust optimizer + eventual onchain constraints | Works without Stylus activation; private candidate inputs; onchain execution can validate constraints separately | Separate deployment/artifact boundary; offchain result still untrusted for settlement; constraints need execution design/audit | Practical fallback if Stylus remains gated |

Implement A's pure core first; keep C as an architectural fallback, **not a second running service now**. No rewrite of Next/PG or premature microservice. TS reference remains oracle during parity work; the server is the only quote authority. A future approved binding/worker can compute outside a DB transaction, but must recheck tenant, amount/version, snapshot expiry and state under existing locks before persisting. Do not hold invoice locks across slow RPC calls. Persist versioned immutable request/result/snapshot provenance and audit correlation atomically with quote creation under a reviewed future migration; do not change existing records in place. On errors/timeouts/version mismatch fail closed or explicitly retain the labeled existing simulation—never silently substitute a market quote.

The current API expects direct/split/multi IDs, fixed simulation provenance and exact receipt shape. New bytes32 IDs/routing semantics require an explicit adapter and reviewed API/schema evolution, not dropping the new structure into current endpoints. Browser renders server results and never selects authoritative outputs or signs a quote. Existing role/auth/tenant enforcement, idempotency fingerprints, route lock, expiry-at-routing/settlement, unique constraints and event history are not moved into the optimizer.

## 7. Reproducible correctness and benchmark plan

No Rust/WASM/chain benchmark was run. No gas, throughput, speedup, binary size, audit assurance or activation feasibility is inferred from marketing examples. Existing application quality results are historical in [QA_PHASE2A.md](QA_PHASE2A.md), not new results for this document.

### Correctness before performance

Create versioned synthetic JSON vectors with expected values and typed errors; identical schema/fixtures for TS reference, native Rust and Stylus harness. Record seed, fixture hash, baseline commit, compiler/CLI/lock/container versions. Separate **legacy parity** from **new v1 behavior** (legacy zero/leading-zero acceptance vs v1 strictness is intentional).

| Family | Required vectors / assertions |
|---|---|
| Funding | Existing 100 and 1e9 inclusive; 99, 1e9+1 adapter rejection; core 0,1,U128_MAX; negative, sign, exponent, decimal, whitespace, leading zeros, empty, too-long integer |
| Rounding | Exact divisibility and one base unit either side; gross vs fee-deducted floor difference; all three measured legacy vectors above; feeOut=G−O; min=floor(O*9950/10000) in fixture mode |
| Fees / tolerance | 0,1,9999,10000,10001 bps; fee10000 zero-output; tolerance10000; minOut=0,O,O+1; no double impact deduction |
| Rates / units | Zero denominator/numerator; mixed decimals0/2/6/18/38; invalid39; inverse-rate mistake; asset mismatch; no automatic double scaling; cost USD cents never subtracted from token output |
| Liquidity | Min−1/min/max/max+1; availableInput F−1/F/F+1; availableOutput O−1/O/O+1; zero capacity/liquidity, all unavailable, no partial fill |
| Expiry | asOf expiry−1/expiry/expiry+1; request vs candidate min deadline; stale snapshot ID mismatch; U64 bounds; server and block-time semantics |
| Selection | Every route wins at least once; unequal fee but same rounded output; equal output/cost; reversed/permuted inputs; duplicate IDs; 0,1,64,65 candidates; deterministic NO_ROUTE diagnostics |
| Overflow | U128 parse/output overflow; U256 intermediate multiplication boundary and +1; denominator*10000; no wrapping/panic; same TS/Rust rejection even if cancellation possible |
| Security/integration | Malformed ABI/calldata, oversized arrays, unsupported version; no state/value transfer; tenant attack/client-output tamper; quote expiry at both lifecycle edges; concurrent idempotent replay/route lock/audit persistence |

Property/fuzz requirements: deterministic repeat/permutation invariance; `0<=M<=O<=G` for eligible routes; fee conservation `G=feeOut+O`; capacity and expiry invariants; monotonic output for fixed valid candidate absent range rejection; no panic on arbitrary bytes; TS/native/WASM exact agreement including errors. At least 10,000 seeded generated cases initially plus minimized persisted failures; quantify coverage rather than claiming exhaustive proof.

### Measurement protocol

1. TS BigInt reference: Node22 pinned, release-like isolated process, monotonic `hrtime.bigint`; parsing/serialization measured separately and end-to-end.
2. Native Rust: pinned release build/target, deterministic datasets identical to TS; test core alone and full JSON binding separately. Criterion or equivalent warmed batches, prevent dead-code elimination.
3. WASM/Stylus: local host/unit harness for parity; raw WASM and CLI-processed/compressed sizes. Only after approval and verified activation path, measure a stateless view on an approved local chain or Sepolia via read-only calls. An empty ArbWasm bytecode response or generic CLI check is not an optimizer invocation benchmark.
4. Datasets: 1/3/8/16/32/64 candidates, varied valid/rejected ratios, maximal numeric widths and ties. At least 1,000 warmups and 10,000 measured evaluations per dataset across 5 process runs; report median/p95/p99, dispersion, CPU/OS/memory, run count and clock method. Separate cold startup, ABI encode/decode, RPC latency, execution estimate and host computation. Avoid equating network latency with core speed.
5. Record view gas/ink only when a real harness/provider reports it, with chain ID, block hash, activated artifact hash, compiler/CLI, calldata bytes and cold/warm context. Separate deployment/activation costs from per-call execution. Never spend testnet funds to fill this table under 2B.0. Compare Solidity only if the exact same algorithm and harness are separately implemented/reviewed; no generic percentage claim.

Acceptance: zero unexplained differential mismatches; deterministic typed invalids; bounded resource use and reviewed artifacts. Performance adoption threshold must be chosen with actual workload and binding/RPC overhead before replacement, not reverse-engineered from a favorable microbenchmark. At three fixture routes, TS may already be sufficient. Results table remains **NOT MEASURED** for TS timing, native timing, WASM timing/size, gas/ink and end-to-end latency.

## 8. Dependencies and staged implementation gates

| Stage | Scope after separate approval | Exit criteria / blockers |
|---|---|---|
| **2B.1 — Offline deterministic core** | TS v1 reference/vectors + pure Rust library; synthetic inputs only; no application API integration or contract deployment | Arena approved Rust1.91/target/crate access; lock/advisory review; exact legacy and v1 parity, bounds/fuzz/error tests; native benchmark with reproducible evidence. Choose checked U256 dependency explicitly; preserve financial conventions |
| **2B.2 — Thin wrapper feasibility** | ABI design, SDK0.10.10 wrapper, local WASM/harness and official current starter reproduction; read-only Sepolia check only | Working toolchain/reproducible Docker environment; ABI parity/resource tests; exact artifact hashes; successful or honestly failed read-only check. **Deployment/activation still requires a distinct go/no-go**, current policy, execution/addresses, applicant audit/signatures and user approval |
| **2B.3 — Server-authoritative simulation integration** | Reviewed binding/adapter + versioned snapshot schema/API migration if justified by evidence; no frontend redesign | Maintain Next/PG ownership, tenant auth, production fail-closed behavior, idempotency/locks/expiry/audit; backend/browser regression suite incl both languages; no real-liquidity claim. Reassess A vs C using actual measurements |

Real market adapters, verified USDG metadata, executable route sourcing, PSP/webhook settlement, production identity, wallet custody/signing, real swaps, compliance, reconciliation and deployment are separate scopes—not implied by completion of 2B.1–2B.3. No fabricated pools or partnership/liquidity claims should enter fixtures or documentation.

### Final handoff

- **Sepolia:** read-only research can continue; deployment/activation **cannot proceed on current evidence**.
- **Blocked:** Arena Rust/Cargo/wasm/Docker plus allowed artifact/RPC access; actual starter build and check; verified current Sepolia process/eligibility, onchain installation/execution evidence and artifact-specific audit/signatures. Snapshot favorability and audit publication do not resolve these.
- **Next task:** approve **2B.1 offline synthetic optimizer core and differential vectors**, first resolving an Arena-compatible pinned toolchain. Keep current financial application unchanged until a separate integration review.
