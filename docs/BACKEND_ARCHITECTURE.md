# Phase 2A backend architecture

> The backend described here remains the current application foundation. Current product scope and evidence are summarised in [HACKATHON_DEMO_EVIDENCE.md](HACKATHON_DEMO_EVIDENCE.md).

Status: implemented local/CI simulation foundation, 16 November 2026. No public deployment, hosted resources, charges, production auth or money movement.

## Decision and official research

Use **Next.js Node Route Handlers + TypeScript + Zod 4 + node-postgres + PostgreSQL 18**, within the existing modular monolith. Keep the approved UI and async InvoiceService contract.

Official references consulted:

- [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers): native request/response handlers fit this application's API without a second server or CORS deployment.
- [Next.js authentication guide](https://nextjs.org/docs/app/guides/authentication): authentication, sessions and authorization are separate; enforce authorization on data access, not only navigation.
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html): row locks serialize competing financial mutations; transaction-scoped advisory locks serialize idempotency keys.
- [Zod basics](https://zod.dev/basics): server-side strict parsing and inferred types; bounded request bodies.
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations): evaluated versioned SQL/TypeScript migration approaches. Drizzle is a good future choice, but **not installed** here: this small schema's critical operations require explicit row/advisory locking and SQL constraints anyway. Reviewed forward-only SQL migrations and a small SQL repository avoid maintaining duplicate schema declarations or an unused abstraction. Trade-off: SQL results rely on pg's row types rather than generated ORM entity types; request/domain models are TypeScript/Zod validated, and real-PostgreSQL tests exercise queries. Reconsider Drizzle when schema/query breadth warrants it.

`embedded-postgres` is a dev-only convenience for the restricted sandbox, not a substitute database engine: it launches real PG binaries. Its prerelease packaging is a portability risk; use independently installed PG or the CI service if unavailable. Production must use a managed/operated database, never this helper.

## Layers

1. Route Handler: HTTP boundary, request IDs, JSON success/error envelope, no-store responses and status mapping. SQL exceptions are not returned to clients.
2. Auth: development token only, active user membership, tenant identity and role, persistent rate-limit counter.
3. Service: strict input parsing, explicit allowed state edges, quote arithmetic, idempotency, receipt construction and atomic business operations.
4. Repository: parameterized invoice/event/payment/quote/settlement/idempotency queries; tenant predicates; a small pool and `BEGIN/COMMIT/ROLLBACK` unit-of-work. SQL identifiers in history queries come from a fixed internal whitelist, not user input.
5. Versioned PostgreSQL schema: constraints and durable records. No automatic migration on incoming requests.

No shared UI component imports server database/auth modules. Browser fetches use same-origin relative URLs. No `NEXT_PUBLIC` secret or client database connection exists. The UI uses server-returned quote candidates rather than recomputing execution outputs. Its numeric amount field is retained solely for display and legacy form compatibility; API input/persistence is integer BRL minor strings.

## Schema and ownership

- **businesses/users/memberships**: created/updated timestamps with database update triggers; active/disabled memberships and admin/operator/viewer roles. Tenant/user identity comes from verified server context, never a request's business ID. Viewers may read; admin/operators may mutate.
- **invoices**: UUID, business FK, positive/range-constrained integer BRL cents, explicit checked status, case-insensitive tenant-unique reference, timestamp and JSONB presentation snapshot. Generated supplier/address/currency/asset/due/description columns expose queryable relational fields without independently writable duplicates. A CHECK forces snapshot ID/reference/status/funding/display amounts (including nulls) to agree with relational authority. Precise created/updated timestamps are hydrated from columns, stripped from stored JSON, and maintained by PG. Snapshot and relational state update in one transaction. List index `(business_id, created_at DESC)`.
- **payments**: one simulated payment per invoice, exact funding amount, unique `SIM-…` provider reference, tenant+invoice FK, received/confirmation time, creation time, fixed BRL currency and Confirmed status. There is no webhook or external provider endpoint.
- **quotes**: invoice+tenant ownership, UUID, fixed simulation source, true simulation flag, timestamps and 15-minute expiry. JSONB captures all three candidates, fee bps/minor units, rational rate, output/minimum/tolerance, demo precision and USD execution-cost cents. JSONB is an immutable server-generated snapshot through the API (not separately mutable candidate rows).
- **settlements**: one per invoice, composite tenant/invoice/quote FK, locked route ID, expected/minimum/actual demo output integer columns, checked state, created/settled timestamps. Asset is fixed to illustrative USDG; update timestamps are DB-maintained and Settled requires actual output/completion time. Hash is nullable and constrained to NULL: a simulated identifier is never an explorer hash. Actual output equals expected in this deterministic simulation; minimum is checked by PG.
- **payment_events**: append-only correlated lifecycle/quote events with actor, tenant, invoice, explicit previous/new states, status/route/funding snapshot and timestamps. Business-wide activity is tenant-scoped, paginated and optionally filtered by event type; the overview consumes it. PG trigger rejects UPDATE/DELETE. TRUNCATE/reset and a superuser can bypass normal immutability: this is not a cryptographic or privileged-DBA-proof audit ledger.
- **idempotency**: tenant+key unique, exact method/path/body fingerprint and committed response snapshot, timestamp.
- **rate_limits**: shared database counters, not server-process memory.

Application-level tenant predicates plus composite FKs provide isolation. **RLS is not claimed**. Deployment requires a least-privilege application role distinct from the migration owner, reviewed grants (including no event UPDATE/DELETE/TRUNCATE), and operational controls. Current local/CI credentials intentionally own their disposable database.

## State machine and atomicity

| From             | Allowed targets         |
| ---------------- | ----------------------- |
| Draft            | Pending payment, Failed |
| Pending payment  | Funded, Failed          |
| Funded           | Routing, Failed         |
| Routing          | Settled, Failed         |
| Settled / Failed | none                    |

Invoice creation is Draft. The UI then explicitly requests Pending payment. If the second request fails, the durable Draft remains discoverable and can be activated from its detail screen—no compensating deletion of financial history.

Every mutation acquires the transaction advisory lock for its tenant/idempotency key, checks a prior committed response, then locks the tenant-owned invoice `FOR UPDATE`. Creation uses a unique reference constraint. Funding inserts a unique payment. Routing requires an unexpired same-invoice quote and a valid candidate, and creates the unique settlement record. Settling reads the locked route and **rechecks expiry**, compares any submitted route, and writes actual output and a server receipt. Failed Routing records are marked Failed. Expired Routing cannot be settled or requoted in place: mark Failed; a recovery/requote workflow is future work, not silently bypassed.

Mutation, snapshot, payment/settlement rows, event and idempotency response commit together. Any failure rolls back all of them. Different concurrent confirmation keys cannot fund or settle twice: invoice row lock + valid-state check + unique constraints. Same-key concurrent requests wait and return the same committed response. Events correlate funding with its payment ID, quote creation with its quote ID, and settlement completion with its settlement ID; all retain the invoice/actor linkage.

The HTTP request ID is an observability identifier, separate from durable domain correlation IDs. Successful idempotent replays return the original domain response, not the latest invoice state. Keys are retained indefinitely in this small foundation; do not prune casually. There is not yet a production retention/partitioning policy. Exact raw JSON bytes are fingerprinted, so reordered/respaced JSON with a reused key conflicts.

## Authentication and security boundary

Production uses the official Auth.js (`next-auth`) GitHub OAuth App Router handler. It **fails closed with 503 `AUTH_NOT_CONFIGURED`** if its server-only configuration is absent, malformed, or contradictory. `/dev-login` returns 404 in production and `PONTE_DEV_*` values are never considered by the production path.

GitHub's stable numeric account ID is the sole external identity subject. A successful callback creates at most one immutable `external_identities(provider='github', subject)` mapping to an internal user; GitHub email, name, and login are not authorization inputs. The legacy required `users.email` value for OAuth-created records is a non-routable technical placeholder. Database constraints and an immutability trigger reject duplicate/repointed mappings. Auth.js sessions are encrypted JWT cookies; production sets `Secure`, `HttpOnly`, and `SameSite=Lax`. OAuth state/CSRF checks are supplied by Auth.js, callback destinations are restricted to the canonical `NEXTAUTH_URL` origin, and the browser-visible session projection excludes OAuth tokens, secrets, internal IDs, roles, and business IDs.

The configuration is intentionally a narrow, one-workspace policy: `PONTE_AUTH_BUSINESS_ID` selects the existing private business; `PONTE_AUTH_ADMIN_GITHUB_IDS` is an exact numeric-ID allowlist that may receive the configured bootstrap `admin` membership only upon first mapping. It never creates a business and never rewrites/re-enables an existing membership. When the explicit `PONTE_PUBLIC_DEMO_READ_ONLY=1` flag names a different existing synthetic demo business, a first-time otherwise-unprovisioned GitHub identity may receive only `viewer` there. No callback grants operator access or any access merely for being authenticated. The demo tenant must contain synthetic data only.

Every protected request resolves the session subject through `external_identities` and re-reads an **active** database membership before it chooses a business/role. Disabled or revoked memberships immediately become 403 even while an OAuth session remains valid. Same-tenant reads retain viewer access; the mutation boundary independently rejects `viewer`. Cross-tenant invoice/evidence lookups remain 404.

Local access still requires `PONTE_DEV_AUTH=1`, an unguessable 32–128-character token, configured UUID user/business and an active membership. `/dev-login` exchanges it for an eight-hour HttpOnly, SameSite=Strict cookie; Secure is added under HTTPS. Bearer tokens remain only for local API tests. The configured dev identity is one local identity, not user impersonation or a production fallback.

Authenticated API requests are limited to 120 per user+tenant per database minute, atomically across processes; exceeded counters return 429/Retry-After. Invalid bearer guesses do not reach tenant data; production-grade anonymous/login abuse control is still a deployment gate. JSON mutation streams are capped at 16 KiB; IDs/strings/amounts/date schemas are bounded and strict. Cross-origin mutation origins are rejected and no CORS credentials are granted. Data errors return safe codes; only server logs carry internal failures. No logging of development tokens is intentional.

`/pay/[id]` retains the approved presentation but is **not an anonymous bearer/capability link**. Authorization is required and guessing another invoice UUID never bypasses its tenant.

## Financial units

See [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md). API funding is canonical integer **BRL cents**; PG stores bigint and JSON uses strings. Quote calculations use BigInt, rational 525/100 illustrative BRL/USDG and candidate-specific floor boundaries. Demo USDG output is two decimal places **only by fixture convention**, not verified token metadata. Execution cost `2` is USD accounting cents, not token output, and is not subtracted as gas. No chain ID, contract, token decimals, signature or real transaction hash is fabricated.

## Hosting comparison — research only

Official free tiers checked 16 November 2026; quotas/terms can change. No account, project or database was provisioned.

| Option                                              | Official free-tier snapshot                                                                                  | Fit / limitations                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local PG / CI PG service                            | No hosted service account                                                                                    | Selected **now**: fully reproducible, no paid resources, CI validates ordinary PostgreSQL rather than a mock                                                            |
| [Neon](https://neon.com/pricing)                    | $0; 100 projects; 100 CU-hours/month/project; 1 GB/project; scale to zero                                    | Preferred **candidate** for future managed PostgreSQL: SQL portability and no extra auth/storage stack; sleeping compute/cold starts and quota monitoring required      |
| [Supabase](https://supabase.com/pricing)            | $0; 500 MB DB, two active projects, pause after one week inactivity; 50k MAU, 5 GB egress, 1 GB file storage | Useful if its auth/storage become deliberate requirements; more services than Phase 2A needs; free pause/storage constraints                                            |
| [Vercel Hobby](https://vercel.com/docs/plans/hobby) | Free app tier; 4 active CPU-hours, 360 GB-hours memory, 1M function invocations, 100 GB fast transfer/month  | Next.js app-host candidate, **not a PostgreSQL database**; free limits, eligibility/commercial terms and a separate DB must be reviewed. Not an authorization to deploy |

Free limits are not a production availability, compliance or unlimited-usage promise. Do not activate paid upgrades/trials, attach payment methods or rely on pricing permanence. A future host choice must be reapproved with exact projected usage and eligibility.

## Deployment preparation

**Not deployed and not production-ready.** Before asking for secrets or creating resources:

1. Obtain approval for exact app host, managed PG plan/region and any cost ceiling. Review data residency and free-plan eligibility. Vercel's connected status is not permission to deploy.
2. Create separate GitHub OAuth Apps for development and production only after approval; register the exact production callback, place `AUTH_SECRET`/GitHub credentials in the approved server-only secret store, provision the intended existing business/memberships, and security-review the deployment configuration. Authentication code is implemented, but credentials/resources are intentionally not created by this repository.
3. Supply server-only `DATABASE_URL` through the approved secret manager, with verified TLS (do not disable certificate validation), pooled app connection and separate migration connection/role. Keep the app near the database. Review total serverless pool concurrency (current per-process max=5).
4. Apply reviewed migrations as a separate release step; never run reset/fixtures or schema changes inside requests. Take a backup, test restoring it and plan forward-fix/rollback compatibility.
5. Configure least-privilege grants, secret rotation, HTTPS, allowed origin/proxy policy, login/API abuse prevention, monitoring/redacted logs/alerts, retention and backups. Confirm Postgres timeouts and capacity; bound/monitor long list/history queries as data grows.
6. Run final tests against the approved staging stack and perform security/compliance review before any user or money data. Actual PSP, signed webhooks, wallet/token adapters, contracts, custody and settlement reconciliation require separate scopes and approvals.

## Verification

`npm run db:seed`, repeated `db:migrate`, `test:backend`, lint, TypeScript, production build and Playwright are executable. Backend tests use real PG for tenant isolation, permissions, strict validation, reference uniqueness, idempotency/replay, concurrent payments, event immutability, quote expiry at routing and settling, locked route, receipt persistence, terminal states, pagination and rate limits. The HTTP wrapper is checked for safe status/envelopes. UI suites reset disposable tables and exercise both languages and supported widths. CI runs PostgreSQL 18 as a service. Actual results and final-head Actions links: [QA_PHASE2A.md](QA_PHASE2A.md).

## Forward-migration checklist amendment

`002_audit_metadata.sql` preserves the already-reviewed initial schema/history while adding the requested relational metadata and audit edges. Historical records without prior timestamps use migration time; this is not fabricated provenance. The event trigger is removed only within the migration transaction to backfill previous/new states, then reinstated before commit. The runner discovers ordered versioned SQL files under the existing advisory lock and records each application.

`npm run test:migrations` verifies a populated initial schema upgrades without losing its invoice/quote/event data, verifies event immutability after backfill, and invokes the actual multi-file runner twice against a separate clean schema. Temporary schemas are removed afterward. The command requires a disposable development/test database with schema-creation rights, never a production application role.
