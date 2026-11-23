# PONTE Stage A — Manual Render Deployment Runbook

> **Status:** operational preparation only. This document does not create a
> Render service, PostgreSQL database, domain, OAuth App, KMS key, wallet, or
> blockchain transaction. Follow it only after an operator approves a real
> deployment.

Stage A is a public PONTE web application with PostgreSQL and GitHub OAuth. It
is **not** a real payment, KMS-backed evidence, registry, or blockchain
anchoring deployment.

## 1. Scope and runtime

The committed runtime pin is [`.node-version`](../.node-version): **Node
24.22.1**. `package.json` and `package-lock.json` require `>=24.22.1 <25`.
That exact release was clean-installed and validated with the application in
this repository before the pin was added.

Render's current native-runtime selection must still show an available Node
24.22.1-compatible runtime when an operator creates the service. Do not assume
that a newer major is compatible just because it is installed by a host.

### Deliberate runtime updates

A runtime update is a code-change review, not a dashboard-only switch:

1. Review the upstream Node security release and Render's currently available
   Node runtimes.
2. Update `.node-version`, the root `engines.node` range, and the root package
   metadata in `package-lock.json` together.
3. Run a clean install and the full validation suite with the exact candidate
   runtime.
4. Review production dependency compatibility and deployment memory results.
5. Commit the pin and validation evidence before changing the Render service.

## 2. Minimum plan and capacity decision

Create both resources in **Frankfurt** so web-to-database traffic uses Render's
private same-region network.

| Resource    | Minimum realistic Stage A plan                | Current planning cost |
| ----------- | --------------------------------------------- | --------------------: |
| Web service | `1c-2g` paid web service, one instance        |             $25/month |
| PostgreSQL  | smallest paid managed PostgreSQL plan, 256 MB |              $6/month |

### Why the 512 MB entry plan is not the recommendation

- **Confirmed measurement:** two clean Node 24.22.1 production builds of this
  repository peaked at **754,404 KiB and 760,956 KiB** child RSS (about
  737–743 MiB) on the validation host. A cold build is already larger than
  512 MB before any strict memory cap, so the $7 `0.5c-512mb` web plan is not a
  reliable build target. These are host measurements with no cgroup limit, not
  a Render-capped build.
- **Confirmed measurement:** a local production `next-server` used about
  118 MiB RSS after both health probes were requested. This is a single idle
  process, not a traffic or load benchmark, so it does not by itself prove
  runtime headroom on a small plan.
- **Confirmed measurement:** rebuilding an already-populated `.next` directory
  used about 531 MiB, still above 512 MB.
- **Estimate, not measurement:** a 512 MB web plan could plausibly serve a
  lightly used deployment if the build is cached or run elsewhere, but that has
  not been verified on Render and would rely on undocumented build caching.
- **Not measured:** the 256 MB PostgreSQL plan's behaviour under this schema's
  migrations, `pg` pool of five connections, and realistic concurrent traffic.

The minimum realistic starting budget is therefore **about $31/month before
taxes, transfer, storage, backups/retention changes, domain registration, or
later workers**. The formerly estimated $13/month stack remains a theoretical
entry-plan price, not this application's safe build recommendation. Recheck the
Render pricing page and plan names immediately before purchase; provider pricing
and plan entitlements change.

The memory figures are observations from this repository, not a claim of a
512 MB-capped Render build or a production traffic benchmark. Do **not** reduce
application security checks to fit an entry plan. Increase the web plan if
Render reports sustained memory pressure, health-check timeouts, slow starts, or
the service gains a worker, additional instances, or production KMS/chain
dependencies.

Relevant Render documentation: [pricing](https://render.com/pricing),
[health checks](https://render.com/docs/health-checks), and
[managed PostgreSQL](https://render.com/docs/postgresql-creating-connecting).

## 3. Create the database first

1. Sign in to the approved Render workspace with MFA enabled.
2. Select **New → PostgreSQL**.
3. Choose **Frankfurt** and a paid plan. Do not select a free database for a
   persistent judge/demo deployment.
4. Wait for the database to become available.
5. Retain its **Internal Database URL** only for the web service's
   server-side `DATABASE_URL` secret. Do not put it in the repository, a
   browser bundle, issue, screenshot, or public documentation.
6. Keep database access limited to the approved operators. Record the backup,
   point-in-time recovery, and restore procedure supplied by the selected plan.

## 4. Create the Render web service

1. Select **New → Web Service** and connect the approved repository and branch.
2. Select **Frankfurt**, the native Node runtime, one paid `1c-2g` instance,
   and the repository root as the working directory. Do not select the 512 MB
   entry plan: the measured build peak already exceeds that memory size.
3. Confirm Node **24.22.1** is selected from `.node-version`. If Render needs
   an explicit dashboard/runtime setting, set its Node version to the same
   exact value.
4. Configure these commands exactly:

   ```text
   Build Command:      npm ci && npm run build
   Pre-deploy Command: npm run db:migrate
   Start Command:      npm start
   Health Check Path:  /api/health/ready
   ```

   The migration command is forward-only, repeatable, and serializes through a
   PostgreSQL advisory lock. Never substitute `db:seed`, `db:fixtures`, or
   `db:reset` in a production service.

5. Do not add a `render.yaml`/Blueprint in this phase. Keep provisioning manual
   until the account, region, billing, and secret owners are approved.

Render treats a 2xx/3xx HTTP response as healthy. The configured readiness
endpoint returns `200` only after a minimal PostgreSQL query succeeds; it
returns generic `503` when PostgreSQL is unavailable. A failed readiness check
can block a bad deploy or cause Render to restart an unhealthy instance, which
is preferable to routing traffic to an instance that cannot use its required
database.

## 5. Health endpoints

| Path                | Purpose               | Database/provider behavior                                                              | Response                                                        |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/api/health/live`  | Process liveness      | Does not query PostgreSQL or any external provider                                      | generic `200` JSON                                              |
| `/api/health/ready` | Application readiness | Executes only `SELECT 1` using the existing PostgreSQL pool; no transaction or mutation | generic `200` JSON when available, generic `503` JSON otherwise |

Both paths run in the Node.js runtime, are dynamic, and send `Cache-Control:
no-store`. They intentionally reveal no connection strings, exception text,
SQL diagnostics, tenant IDs, or provider configuration.

Use `/api/health/ready` for Render's HTTP health-check path. Use the liveness
path only for a separate process-level probe when database readiness is not the
question being tested.

## 6. Production environment variables

Set these in Render's server-side environment/secret settings. Use real values
only in Render; all examples below are placeholders.

| Variable                        |                      Required | Purpose                                                                                                                                                          |
| ------------------------------- | ----------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      |                           yes | Production runtime marker. It disables development authentication.                                                                                               |
| `DATABASE_URL`                  |                           yes | Render **internal** PostgreSQL connection URL. Treat it as a secret.                                                                                             |
| `NODE_VERSION`                  | hosting setting when required | Must match the committed tested runtime: `<NODE_24_22_1>`.                                                                                                       |
| `AUTH_SECRET`                   |                           yes | Auth.js server-only encrypted JWT/cookie secret. Generate and retain it in the approved secret manager only.                                                     |
| `AUTH_GITHUB_ID`                |                           yes | Production GitHub OAuth App client ID.                                                                                                                           |
| `AUTH_GITHUB_SECRET`            |                           yes | Production GitHub OAuth App client secret.                                                                                                                       |
| `NEXTAUTH_URL`                  |                           yes | Canonical HTTPS root origin, represented as `<CANONICAL_HTTPS_ORIGIN>`. It cannot include a path, query, fragment, or credentials.                               |
| `PONTE_AUTH_BUSINESS_ID`        |                           yes | Existing private-business UUID created by the bootstrap step below.                                                                                              |
| `PONTE_AUTH_ADMIN_GITHUB_IDS`   |                           yes | Comma-separated, canonical decimal GitHub numeric account IDs for intended first administrators. GitHub usernames and email addresses are not valid substitutes. |
| `AUTH_URL`                      |                      optional | Auth.js alias; if set, it must be exactly equal to `NEXTAUTH_URL`.                                                                                               |
| `NEXTAUTH_SECRET`               |                      optional | Compatibility alias; if set, it must be exactly equal to `AUTH_SECRET`.                                                                                          |
| `PONTE_PUBLIC_DEMO_READ_ONLY`   |                   conditional | Must stay unset or `0` while demo content is provisioned. Set exactly `1` only after §7a completes and the operator approves public viewer access.               |
| `PONTE_PUBLIC_DEMO_BUSINESS_ID` |                   conditional | Required together with the flag above; must be the UUID provisioned in §7a and must differ from `PONTE_AUTH_BUSINESS_ID`.                                        |

Never set any `PONTE_DEV_*`, `PONTE_LOCAL_EVIDENCE_TEST_*`, local token, or
local registry setting in Render production. Never expose any secret through a
`NEXT_PUBLIC_*` variable.

## 7. Migrate, then bootstrap exactly one private business

The initial service deployment runs `npm run db:migrate` before start. After
migrations succeed, open a paid Render Shell for the web service and execute
this one-time command with operator-supplied placeholders:

```bash
npm run db:bootstrap-business -- \
  --confirm-production \
  --business-id "<PRIVATE_BUSINESS_UUID>" \
  --business-name "<PRIVATE_BUSINESS_NAME>"
```

The command is deliberately narrow:

- it requires `NODE_ENV=production`, `--confirm-production`, a non-loopback
  PostgreSQL URL, and no local-development/evidence variables;
- it creates only one `businesses` row in a transaction;
- it is idempotent only for the same UUID and normalized matching name;
- it refuses a conflicting existing UUID without updating it;
- it creates no user, membership, OAuth identity, admin role, invoice, fixture,
  demo record, KMS record, or evidence record;
- its own success/failure output never prints database credentials or database error details. (The operator shell or npm may still echo the supplied non-secret command arguments.)

If the command reports that it was refused or failed, do not paste command
output or database URLs into a ticket. Verify the listed prerequisites and use
an approved operator channel. Never replace it with the local seed command.

## 7a. Provision the synthetic public demo tenant

Stage A can optionally expose a **read-only synthetic demo** to any authenticated
GitHub account. It is a separate tenant with fabricated sample invoices; it is
never the private administrator business and never contains real activity.

Complete this section only after §7 succeeds. The exact order matters:

1. **Migrations complete** (`npm run db:migrate` finished successfully).
2. **Private administrator business bootstrapped** (§7).
3. **Synthetic demo content provisioned** with the command below, while
   `PONTE_PUBLIC_DEMO_READ_ONLY` is still unset or `0`.
4. **Demo records verified** (read-only `--verify`, plus the SQL checks below).
5. **`PONTE_PUBLIC_DEMO_READ_ONLY=1`** set in Render.
6. **`PONTE_PUBLIC_DEMO_BUSINESS_ID`** set to the same demo UUID.
7. **Confirm the demo UUID differs from `PONTE_AUTH_BUSINESS_ID`.** The
   application refuses a configuration where they are equal.
8. **Deploy/restart** the web service so the new environment is loaded.
9. **Test with an unprivileged GitHub account** that has never signed in.
10. **Confirm the viewer can read demo content but cannot mutate it or reach the
    private business.**

### Provision

In a Render Shell for the web service, with operator-supplied placeholders:

```bash
npm run db:bootstrap-public-demo -- \
  --confirm-production \
  --business-id "<DEMO_BUSINESS_UUID>" \
  --business-name "<DEMO_BUSINESS_NAME>"
```

This is a different command from `db:bootstrap-business` and deliberately
shares no code path with the local seed/fixture scripts. It:

- requires `NODE_ENV=production`, `--confirm-production`, a non-loopback
  PostgreSQL URL, and no `PONTE_DEV_*`/`PONTE_LOCAL_EVIDENCE_TEST_*` setting;
- refuses a demo UUID equal to `PONTE_AUTH_BUSINESS_ID`;
- refuses to run while `PONTE_PUBLIC_DEMO_READ_ONLY=1`, so population always
  precedes enablement;
- writes **only** `businesses`, `invoices`, `payments`, `quotes` and
  `settlements` in a single transaction;
- uses fixed UUIDv5 identifiers derived from a repository namespace, so a
  repeat run addresses the same rows and verifies them instead of duplicating;
- refuses (and rolls back) any existing row whose contents differ, and never
  updates, deletes, or resets data;
- creates **no** users, memberships, external identities, admin elevation, KMS
  metadata, evidence records, outbox jobs, or registry data;
- prints only short reason codes, never a connection string, row content, or
  database exception.

Optional read-only verification, safe to run at any time (including after the
demo is enabled):

```bash
npm run db:bootstrap-public-demo -- \
  --confirm-production --verify \
  --business-id "<DEMO_BUSINESS_UUID>" \
  --business-name "<DEMO_BUSINESS_NAME>"
```

### What the demo contains

Six fabricated invoices covering the lifecycle the current UI renders
truthfully: `Draft`, `Pending payment`, `Funded`, `Routing` (recorded simulated
route decision), `Settled` (simulated receipt) and `Failed`. References start
with `DEMO-SYN-`; suppliers and descriptions state that they are synthetic;
wallet fields are repeating placeholder patterns. Every quote is the
application's fixed simulation pricing model.

Deliberately **not** created: settlement transaction hashes (the schema
constrains the column to `NULL`), evidence rows, KMS envelopes, outbox jobs,
registry events, and payment events. Those require a genuine external
integration or a real acting user.

### Demo safety properties

- `PONTE_PUBLIC_DEMO_READ_ONLY=1` grants a first-time GitHub sign-in exactly one
  `viewer` membership in the demo tenant — never `admin`/`operator`, and never a
  membership in the private business.
- A viewer can read demo invoices, quotes, payments, settlements and activity.
  Every write (`POST`/`PATCH`) is refused with `403 FORBIDDEN` before any body
  is parsed, and no cross-tenant read returns `200`.
- No anonymous access exists: the demo still requires a valid GitHub session.
- Configuring a GitHub subject in `PONTE_AUTH_ADMIN_GITHUB_IDS` always resolves
  to the private business with `admin`, even when the demo is enabled.

### Ordering hazard: sign-in before the demo exists

An OAuth callback creates an **immutable** external-identity mapping exactly
once. If a person signs in while `PONTE_PUBLIC_DEMO_READ_ONLY` is not `1`, they
receive no membership; a later login does not retroactively grant one, and the
application does not upgrade existing mappings. Such an account will keep
seeing "Workspace access denied" until a separate, reviewed membership
operation is built. This is why the demo flag must be enabled **before**
inviting any unprivileged tester to sign in, and why a controlled test account
that has never signed in should be used for step 9.

## 8. Domain and GitHub OAuth

1. Add and verify the canonical custom domain in Render before production OAuth
   testing. Render supplies TLS after domain verification.
2. Create a **separate production GitHub OAuth App**. Do not reuse local client
   secrets.
3. Set its homepage URL to `<CANONICAL_HTTPS_ORIGIN>`.
4. Set its callback URL exactly to:

   ```text
   https://<canonical-host>/api/auth/callback/github
   ```

5. Place the resulting client ID and client secret only in the Render secret
   fields named above.
6. Confirm `NEXTAUTH_URL` is the same canonical HTTPS root origin.

GitHub OAuth App instructions are available in GitHub's
[official documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

## 9. First administrator sign-in

Perform this only after migration and business bootstrap both completed:

1. Verify the first administrator's decimal GitHub account ID is already in
   `PONTE_AUTH_ADMIN_GITHUB_IDS`.
2. Verify `PONTE_AUTH_BUSINESS_ID` equals the business UUID created by the
   bootstrap command.
3. Sign in with that configured GitHub account.
4. The existing Auth.js callback atomically creates that account's immutable
   external-identity record and its initial active `admin` membership.
5. Verify the workspace loads, then verify `/dev-login` is unavailable in the
   production runtime.

Do not invite an unlisted person to sign in first. A first unlisted callback
can create an immutable external identity without an authorized membership;
changing the allowlist later does not upgrade that mapping during another
login. Additional membership management needs a future reviewed workflow.

## 10. What Stage A does and does not provide

After a correctly configured Stage A deployment, the following are usable:

- public marketing pages;
- GitHub OAuth sign-in with strict configured-admin bootstrap;
- fresh PostgreSQL-backed membership checks and tenant-isolated application
  journeys that do not require real evidence preparation;
- clearly labelled simulated Pix/USDG UI and persisted simulation data.

The following remain unavailable or intentionally blocked:

- real Pix payments, PSP integration, wallet signing, token transfers, custody,
  or USDG settlement;
- real GCP KMS composition: the GCP adapter remains dormant until a separately
  reviewed Stage B composition, IAM, credential, key-version, and audit-log
  design is implemented;
- registry submission, Arbitrum Sepolia RPC/signer use, confirmation handling,
  retries, or independent verification: no worker exists yet for the evidence
  outbox;
- evidence-preparing route transitions in production, because the only current
  application composition selects a guarded local synthetic provider that
  refuses production execution;
- a populated public demo remains **optional**: §7a provisions a distinct
  synthetic tenant with fabricated invoices, and
  `PONTE_PUBLIC_DEMO_READ_ONLY=1` enables read-only viewer access once the
  operator has run §7a and verified the result.

No simulated journey should be represented to a judge as a real payment, KMS
operation, or blockchain anchor. The demo UI states on every workspace view that
the records are synthetic, that no Pix payment or wallet exists, and that no
KMS or blockchain operation occurred. The evidence panel for a demo invoice
shows the explicit "No evidence record" empty state — it never shows a persisted
or anchored claim for synthetic data.

## 11. Recovery and operating basics

- Enable MFA for GitHub, Render, and any domain/DNS account.
- Keep the database URL, Auth.js secret, and OAuth secret in access-controlled
  secret storage; rotate through an approved change procedure.
- Review the selected Render Postgres plan's backup/PITR window before launch
  and test a recovery procedure before relying on it.
- Use `/api/health/ready`, service logs, and Render metrics to investigate
  service/database availability without exposing diagnostics publicly.
- Do not add a worker, KMS credential, RPC endpoint, wallet key, or public demo
  flag under this Stage A runbook. Each requires its own review and acceptance
  criteria.

---

# Part 2 — Zero-cost public demo path (Render Free + Neon Free)

> **Status:** Phase 1.3.9 preparation. Nothing in this part has been executed.
> No Render service, Neon project, GitHub OAuth App, secret, or workflow run
> exists yet. All values below are placeholders in angle brackets; never copy a
> real hostname, account id, or secret into this file.
>
> **Budget:** $0. Every step here uses a free plan. If any step asks for a
> payment method, a plan upgrade, or a paid add-on, **stop and report it** — do
> not continue and do not enter card details.

Parts 1 and 2 are alternatives. Part 1 assumes a paid Render web service with a
Render Postgres database. Part 2 is the free-only path: **Render Free web
service + Neon Free PostgreSQL**. They are not combined, and the free path
never uses Render Postgres (its free tier expires 30 days after creation).

## 12. What the free path is, and what it is not

| Concern | Free path behaviour |
| --- | --- |
| Web compute | Render **Free** instance: 0.1 CPU / 512 MB RAM, one instance |
| Sleep | Spins down after 15 minutes with no inbound HTTP/WebSocket traffic |
| Wake | Next HTTP request; the browser shows a loading page for roughly a minute |
| Filesystem | Ephemeral; every redeploy, restart, and spin-down discards local files |
| Shell / SSH | **Not available.** No one-off jobs either. |
| Database | Neon **Free** project; scales to zero after 5 idle minutes |
| Database pooling | Neon PgBouncer, transaction mode, through the `-pooler` hostname |
| Migrations | GitHub Actions, manual dispatch, direct (non-pooled) endpoint |
| Custom domain | **Not on a free budget.** Use the assigned `onrender.com` hostname. |
| Uptime | No SLA. Render may restart a free service at any time. |

Render's documentation says free instances should not host production
applications. This path exists to demonstrate PONTE publicly at zero cost. It is
not a claim of production readiness, availability, or durability.

**Deliberately not done in this path:** no periodic external pings to defeat the
sleep timer; no paid worker; no paid custom domain; no paid database; no plan
upgrade; no payment method on file.

## 13. Verified provider limits (as of 2026-11-19)

Every figure below is from the provider's own documentation. Local measurements
are kept separate in §25.

### Render Free (web service)

- **Compute:** 0.1 CPU, 512 MB RAM, single instance. No scaling.
- **Instance hours:** 750 per workspace per calendar month. Spun-down services
  consume none; unused hours do not roll over.
- **Exhaustion:** all free web services in the workspace are **suspended until
  the next calendar month**. With no payment method, that is the end state.
- **Idle sleep:** after 15 minutes without inbound traffic; wake takes about one
  minute.
- **No shell, no SSH, no one-off jobs.** This is why migrations run in GitHub
  Actions.
- **Build pipeline:** Starter tier, 2 CPU / 8 GB RAM, **500 pipeline minutes**
  per month. Exhaustion disables new builds for the month; existing builds keep
  serving.
- **Outbound bandwidth:** exhaustion suspends all free services for the month.
- **Service-initiated traffic threshold:** Render may suspend a free service
  that starts an uncommonly high volume of outbound traffic. Its own examples
  include *"Accessing an external database"*. Restoration requires moving to a
  **paid** plan.
  - This is the single largest structural risk of this architecture and is
    stated plainly in §21. The design keeps request volume and query count low,
    but no configuration can remove the risk while the database is external.
- **Reserved ports** `18012`, `18013`, `19099` cannot be bound. Outbound SMTP
  ports `25`, `465`, `587` are blocked.
- **`robots.txt`** while asleep returns `Disallow: /` and does not wake the
  service.
- **Free Postgres is not used** (1 per workspace, 1 GB, expires after 30 days).

### Neon Free (project)

- **Compute:** 100 CU-hours per project per month. The minimum 0.25 CU size at
  full utilisation is about **400 compute-hours** — more than a month of
  continuous running, and scale-to-zero reduces it further.
- **Scale to zero:** after 5 minutes idle, and it **cannot be disabled** on Free.
- **Storage:** 1 GB per project, 20 GB per account.
- **Public network transfer:** 5 GB per project included.
- **Autoscaling:** up to 2 CU (8 GB RAM). At 0.25 CU the compute allows 112
  server connections, 105 of them usable by the application.
- **Pooling:** PgBouncer, `pool_mode=transaction`, fixed and not user
  configurable. Pooled hostname = the endpoint id plus `-pooler`.
- **No spending notifications and no SLA** on Free. Exhausting a quota does not
  silently bill: usage simply stops until the next month.

### GitHub Actions

- Standard GitHub-hosted runners in **public** repositories are free, with no
  minute quota. `timmyspurs12/ponte` is public, so the manual database workflow
  costs nothing.
- `workflow_dispatch` **requires the workflow file to exist on the default
  branch** before the "Run workflow" button appears. The default branch here is
  `main`. See §16 for the exact consequence.

## 14. Architecture: two URLs, two secrets

```
Render Free (Next.js)  --TLS, pooled-->  Neon PgBouncer  -->  Neon Postgres
        ^                                        ^
        |                                        |
  DATABASE_URL (pooled)              GitHub Actions only:
                                    PONTE_DATABASE_URL_DIRECT (direct)
```

| Variable | Where it lives | Endpoint | Who may read it |
| --- | --- | --- | --- |
| `DATABASE_URL` | Render environment (secret) | Neon **pooled** (`-pooler`) | The web service process |
| `PONTE_DATABASE_URL_DIRECT` | GitHub Actions **secret** | Neon **direct** | The database workflow only |

Rules the code now enforces, not merely documents:

- The runtime refuses a non-pooled host, a loopback or `.internal`/`.local`
  host, any SSL query parameter other than `sslmode=verify-full`, and any URL
  that tries to set `statement_timeout`, `lock_timeout`,
  `idle_in_transaction_session_timeout`, or `options`. See
  `src/server/database-config.ts`.
- The administrative path refuses a `-pooler` host, so DDL cannot accidentally
  run through PgBouncer. See `src/server/admin-database.ts`.
- Both paths pass an explicit `ssl: { rejectUnauthorized: true }`. This matters
  because `pg`'s `ssl: true` requests TLS **without** verifying the chain, and
  because `pg` parses the connection string *over* any options object, so a
  `?sslmode=require` in the URL would otherwise silently weaken the transport.
- **Neither URL is ever prefixed `NEXT_PUBLIC_`**, printed by the application,
  or included in a workflow log.

### Why the pooled endpoint is mandatory at runtime

Neon gives a 0.25 CU compute 112 server connections. A direct-connecting app
pool can exhaust that during a burst or after a restart overlap. The pooler
absorbs client churn, and the application pool is capped at **5** connections.

### Why migrations use the direct endpoint

Neon documents schema migrations and admin tasks as direct-connection use cases.
A migration keeps one session open across many statements, which transaction
pooling does not preserve.

### PgBouncer incompatibilities, checked against this code

| Session feature | Supported by PgBouncer transaction mode? | PONTE usage |
| --- | --- | --- |
| `pg_advisory_xact_lock` (transaction-scoped) | Yes | Used for migrations and idempotency |
| `pg_advisory_lock` / `pg_advisory_unlock` (session) | **No** | Not used anywhere |
| `BEGIN` / `COMMIT` / `ROLLBACK` | Yes | Every write path |
| `SET` / `RESET` session variables | **No** | Not used in application code |
| `LISTEN` / `NOTIFY` | **No** | Not used |
| SQL `PREPARE` / `DEALLOCATE` | **No** | Not used (driver-side only) |
| `WITH HOLD` cursors | **No** | Not used |
| Temporary tables with `ON COMMIT PRESERVE/DELETE ROWS` | **No** | Not used |

The pool sends `statement_timeout` and `idle_in_transaction_session_timeout` in
the startup packet. Neon documents `statement_timeout` as one of the few
settings that **carry over** between clients, so the URL is forbidden from
setting it a second time; the app owns its value.

## 15. Step 1 — Create the Neon Free project

1. Create a Neon account with the **Free** plan. Do not add a payment method.
2. Create **one** project:
   - **Region:** AWS Europe (Frankfurt) — `aws-eu-central-1`. Neon supports
     Frankfurt; if it is unavailable in the console, choose the closest offered
     region and record the choice. The region cannot be changed later.
   - **Postgres version:** the default offered version.
3. From **Connect**, copy **both** connection strings and keep them only in a
   password manager:
   - **Pooled** (`Connection pooling` toggle **on**) — hostname ends in
     `-pooler.<region>.aws.neon.tech`. This becomes the Render `DATABASE_URL`.
   - **Direct** (toggle **off**) — this becomes the GitHub secret.
4. Append or verify `?sslmode=verify-full` on both strings.
   - If the console gives you `sslmode=require`, change only that parameter to
     `verify-full`. The runtime refuses `require` on purpose: current
     `pg-connection-string` treats it as an alias for `verify-full`, but warns
     that this changes in v3.
   - `?channel_binding=require` is accepted and may be kept.
5. Confirm the endpoint ids differ only by the `-pooler` suffix:
   - Pooled: `<endpoint-id>-pooler.<region>.aws.neon.tech`
   - Direct: `<endpoint-id>.<region>.aws.neon.tech`

Do not create a second project, branch, or database for this deployment. The
free allowance is per project and one project is sufficient.

## 16. Step 2 — Put the workflow on `main` first

GitHub only offers the **Run workflow** button once the workflow file exists on
the repository's **default branch**, which is `main`. On this branch
(`arena/40fa34c0-ponte`) the file exists but is **not triggerable**, and that
cannot be worked around without weakening the branch rule.

Required ordering, performed by a human reviewer (Phase 1.3.9 does not merge):

1. Review `.github/workflows/manual-database-operations.yml` and the modules it
   calls (`scripts/manual-database-operations.ts`,
   `scripts/validate-database-operation.ts`,
   `scripts/database-operation-runner.ts`, `scripts/migrate.ts`).
2. Merge that reviewed change into `main` through the normal review process.
3. Only then does **Actions → Manual database operations → Run workflow**
   appear.

Until step 2 happens, every database operation below is blocked. State this
plainly in any status report; do not claim the workflow is usable before it is
on `main`.

## 17. Step 3 — Configure repository variables and secrets

In **Settings → Secrets and variables → Actions**:

**Variables** (not secrets; they are configuration, not credentials):

| Name | Example placeholder | Purpose |
| --- | --- | --- |
| `PONTE_DB_OPERATORS` | `octocat,release-manager` | Comma-separated GitHub logins allowed to dispatch |
| `PONTE_AUTH_BUSINESS_ID` | `<private-business-uuid>` | The private administrator tenant |

**Secrets:**

| Name | Value |
| --- | --- |
| `PONTE_DATABASE_URL_DIRECT` | The Neon **direct** connection string from §15 |

`PONTE_DB_OPERATORS` is the authorization boundary. A login not on the list
fails the first workflow step, and the same check runs again inside the CLI.
Keep it to the smallest set of people who may change production data.

## 18. Step 4 — Create the Render Free web service

1. Sign up at Render with the **Hobby** workspace. Do not add a payment method.
2. **New → Web Service**, connect the GitHub repository.
3. Settings:

| Field | Value |
| --- | --- |
| Name | `<service-name>` (becomes `<service-name>.onrender.com`) |
| Region | **Frankfurt** (same region as the Neon project) |
| Branch | `main` |
| Runtime | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm run start` |
| Instance type | **Free** |
| Health check path | `/api/health/ready` |
| Auto-deploy | **On commit** (default), or After CI checks pass |

4. **Leave the pre-deploy command empty.** Render runs a pre-deploy command on
   *every* deploy; using it for migrations would mean an ordinary deploy mutates
   the database. Migrations happen only through the manual workflow.
5. Node version: Render's default Node for services created on or after
   2026-10-21 is `24.22.1`, which matches `.node-version` and
   `package.json#engines`. Set the `NODE_VERSION` environment variable to
   `24.22.1` as well, so a future default change cannot silently move the
   runtime.
6. `next start` reads `PORT`, which Render sets, and the start script already
   binds `0.0.0.0`, which Render requires.

## 19. Step 5 — Runtime environment variables

Set these in **Render → Environment**. Mark every secret as a secret.

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24.22.1` |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `DATABASE_URL` | Neon **pooled** URL, `sslmode=verify-full` |
| `AUTH_SECRET` | 32+ character random secret |
| `NEXTAUTH_URL` | `https://<service-name>.onrender.com` |
| `AUTH_GITHUB_ID` | GitHub OAuth App client id |
| `AUTH_GITHUB_SECRET` | GitHub OAuth App client secret |
| `PONTE_AUTH_BUSINESS_ID` | `<private-business-uuid>` (same as the repo variable) |
| `PONTE_AUTH_ADMIN_GITHUB_IDS` | Comma-separated numeric GitHub **user ids** |
| `PONTE_PUBLIC_DEMO_READ_ONLY` | **omit** until §23 |
| `PONTE_PUBLIC_DEMO_BUSINESS_ID` | **omit** until §23 |

Notes:

- `NEXTAUTH_URL` must be the exact HTTPS origin with no path, query, or
  trailing slash. `AUTH_URL`, if set at all, must be identical.
- `PONTE_AUTH_ADMIN_GITHUB_IDS` takes **numeric account ids**, not logins.
- The runtime fails closed: a malformed production configuration behaves as
  "authentication unavailable" rather than falling back to a development mode.
- If `DATABASE_URL` violates the transport policy, the service starts, and
  `/api/health/ready` returns `503` with no diagnostic detail. The reason code
  appears once in the service log at pool creation.

## 20. Step 6 — Seed order: migrate, private business, demo, verify

Run these in order from **Actions → Manual database operations → Run workflow**
after §16 is complete. Concurrency is locked per repository, so a second run
waits for the first instead of interleaving.

| # | Operation | `business_id` | `business_name` | `confirmation` |
| --- | --- | --- | --- | --- |
| 1 | `verify` | *(empty)* | *(empty)* | *(empty)* |
| 2 | `migrate` | *(empty)* | *(empty)* | `APPLY migrate` |
| 3 | `business-bootstrap` | `<private-business-uuid>` | `<private-business-name>` | `APPLY business-bootstrap` |
| 4 | `demo-bootstrap` | `<demo-business-uuid>` | `<demo-business-name>` | `APPLY demo-bootstrap` |
| 5 | `verify` | *(empty)* | *(empty)* | *(empty)* |

What each run does:

1. **`verify`** — read-only. Confirms connectivity, shows recorded migrations
   and which, if any, are pending. Expect "pending" on a new database.
2. **`migrate`** — applies `migrations/001…006` forward, inside one transaction,
   under a transaction-scoped advisory lock. Re-running is a no-op. It never
   seeds, resets, truncates, or drops.
3. **`business-bootstrap`** — creates exactly one business row. It creates **no
   user and no membership**. Administrator access is granted later by the first
   GitHub sign-in from an allow-listed account.
4. **`demo-bootstrap`** — inserts the deterministic synthetic demo tenant
   (`6` invoices, `2` quotes, `3` payments, `2` settlements). Re-running verifies
   instead of inserting. A drift in any row raises `CONFLICT` and rolls back.
   It refuses to run while `PONTE_PUBLIC_DEMO_READ_ONLY=1`.
5. **`verify`** — read-only. Confirms the schema is current and reports tenant
   and synthetic-user counts.

Inputs are validated before the database secret is placed in the job
environment: a wrong actor, a non-`main` ref, a malformed UUID, a name with
shell metacharacters, or a missing confirmation phrase fails in seconds.

## 21. Step 7 — Enable the public demo, then deploy

Only after §20 step 4 succeeds **and** §20 step 5 passes:

1. In Render → Environment, set:
   - `PONTE_PUBLIC_DEMO_READ_ONLY=1`
   - `PONTE_PUBLIC_DEMO_BUSINESS_ID=<demo-business-uuid>`
   - `<demo-business-uuid>` **must differ** from `PONTE_AUTH_BUSINESS_ID`;
     configuration parsing rejects a collision.
2. Save. Render redeploys with the new environment.
3. Confirm `https://<service-name>.onrender.com/api/health/ready` returns
   `{"status":"ready"}`.
4. Confirm `https://<service-name>.onrender.com/api/health/live` returns
   `{"status":"ok"}`.

The demo flag is an operator action in the dashboard, never a side effect of a
migration or a workflow run.

## 22. Step 8 — GitHub OAuth callback and first sign-ins

1. Create **one** GitHub OAuth App (not a GitHub App).
2. **Authorization callback URL:**
   `https://<service-name>.onrender.com/api/auth/callback/github`
3. Put its client id and secret in the Render environment from §19.
4. **First administrator sign-in:** sign in with an account whose **numeric id**
   is listed in `PONTE_AUTH_ADMIN_GITHUB_IDS`. That first sign-in binds the
   identity to the private business and creates the membership.
5. **First viewer sign-in:** any other GitHub account signs in and receives the
   read-only viewer role against the demo tenant. Viewer writes are refused by
   the server, not merely hidden in the UI.
6. If you later change the `onrender.com` hostname, the OAuth callback URL and
   `NEXTAUTH_URL` must both change with it.

## 23. Step 9 — Testing after an idle wake

1. Leave the service alone for at least 15 minutes.
2. Open the site in a private window. A Render loading page appears for about a
   minute while the instance starts.
3. The first page may take longer than usual: Neon scales to zero after 5 idle
   minutes, so the first query also wakes the compute.
4. Confirm a normal page load, one API call, and the demo disclosure banner.
5. Confirm `/api/health/ready` returns `200` afterwards.

This is expected behaviour, not a fault. Do not add an external pinger to avoid
it: that consumes instance hours, defeats scale-to-zero, and is out of scope for
this phase.

## 24. Charge protection and quota exhaustion

**Rules for this deployment**

- No payment method on either account.
- No plan upgrade. Render's own documentation states that upgrading the
  *workspace* plan does not remove Free *instance* limits; only upgrading the
  instance does, and that is out of scope.
- No paid custom domain. Use the assigned `onrender.com` hostname.
- No paid worker, cron, or one-off job.
- No external uptime pinger.

**What happens when each quota is exhausted** (with no payment method, there is
nothing to bill, so the service stops instead):

| Quota | Exhausted behaviour |
| --- | --- |
| Render 750 instance hours | All free web services suspended until the next calendar month |
| Render build minutes (500) | New builds disabled for the month; the last build keeps serving |
| Render outbound bandwidth | All free services suspended for the month |
| Render service-initiated traffic | Service may be suspended; restoration requires a **paid** plan |
| Neon 100 CU-hours | Compute stops until the next month |
| Neon 1 GB storage | Writes fail until storage is freed |

The free-tier design keeps a single always-awake service near 744 of 750
instance hours, so a second free web service would overrun the allowance.

**Monitoring:** check Render → Billing → Monthly Included Usage and Neon →
Billing weekly. Both providers email before a limit is reached.

**Stop-and-report triggers:** any prompt for a card, any upgrade screen, any
"restore your service" message that requires payment, or a suspension for
service-initiated traffic. Report the situation rather than paying.

**The structural risk, restated:** Render names *"Accessing an external
database"* as an example of service-initiated traffic that can trigger
suspension, and restoration requires a paid plan. Running the database on Neon
is therefore not risk-free even at idle. The mitigation is low traffic and
few queries per request — not a guarantee.

## 25. Verification performed for this phase

All checks below ran **locally against a disposable PostgreSQL 18.6** and the
repository's own test servers. **No Render or Neon service was created, and no
provider performance claim is made.**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint .` | clean |
| Prettier (`src`, `tests`, `playwright.config.ts`) | clean |
| Production build | exit 0, all routes dynamic |
| Backend suite (`npm run test:backend`) | 142 pass, 0 fail |
| Evidence suite (`npm run test:evidence`) | 82 pass, 0 fail |
| Migration integration (`npm run test:migrations`) | pass |
| Browser suite (`npm test`) | 22 pass, 0 fail |

New automated coverage in this phase:

- `tests-backend/runtime-database-config.test.ts` — 13 cases: pooled/direct
  selection, TLS modes, forbidden query parameters, loopback/internal hosts,
  secret-free failure text, pool option budgets.
- `tests-backend/manual-database-workflow.test.ts` — 13 cases: dispatch policy,
  operator allow-list, confirmation phrases, tenant input validation, and
  structural assertions on the workflow YAML (dispatch-only trigger, least
  privilege, serialization, secret scoping, and absence of `db:seed`,
  `db:reset`, `db:fixtures`, `TRUNCATE`, and `DROP TABLE`).
- `tests-backend/manual-database-operations.test.ts` — 15 cases: migration
  ordering and lock scope, rollback on failure, idempotent replay, read-only
  verify, schema-before-tenant ordering, and the unreachability of the local
  seed path on a hosted runtime.

- `tests-backend/pool-reconnect.test.ts` — 2 cases, opt-in with
  `PONTE_RECONNECT_TEST=1`: an idle pooled connection whose backend is
  terminated is reported as a pool `error` event, discarded, and transparently
  replaced; a transaction still rolls back cleanly afterwards. This reproduces
  the Neon-suspend and Render-restart condition locally.

Local measurements taken against the disposable PostgreSQL 18.6 instance (these
are **local** measurements, not provider measurements):

| Measurement | Result |
| --- | --- |
| TLS with `ssl: { rejectUnauthorized: true }` against a self-signed cert | Rejected: `DEPTH_ZERO_SELF_SIGNED_CERT` |
| TLS with `?sslmode=verify-full` in the URL | Rejected: same error — the URL does not weaken the object |
| TLS with `?sslmode=require` (pg 8.23 aliases it to verify-full) | Rejected: same error, with a deprecation warning |
| TLS trusting the throwaway CA | Connected; `pg_stat_ssl.ssl = true` |
| Backend terminated while idle in the pool | 1 pool `error` event, process alive, next query reconnected with a new backend pid |
| Hosted-runtime configuration guard | All four invalid shapes refused with a reason code and no URL in the message |

Deliberately **not** claimed: actual Render memory/CPU behaviour, actual Neon
wake latency, actual PgBouncer behaviour, and Render build duration. Those
require running the services, which this phase does not do.

## 26. Known blockers to a fully free public deployment

1. **Workflow triggerability.** The manual workflow cannot run until it is on
   `main`. Phase 1.3.9 does not merge. Until a reviewer merges it, no migration
   or bootstrap can be executed at all.
2. **Service-initiated traffic suspension.** A Render free service may be
   suspended for outbound traffic to an external database, and restoration
   requires a paid plan. This is a provider policy risk with no free mitigation;
   the only fully compliant alternative is a Render-hosted database, whose free
   tier expires after 30 days.
3. **Sleep and cold start.** 15-minute sleep plus roughly one minute of wake,
   compounded by Neon's 5-minute scale-to-zero, means the first visit after
   idleness is slow. This is accepted behaviour for a demo, not a defect.
4. **No SLA or backup.** Neon Free provides no SLA; Render Free provides no
   uptime guarantee and an ephemeral filesystem. The synthetic demo data is
   reproducible from `npm run db:bootstrap-public-demo`, so its loss is
   recoverable; a real tenant would not be.
5. **Instance-hour headroom.** One always-awake service uses about 744 of 750
   monthly hours. Any additional free service in the workspace risks suspending
   both.
6. **OAuth App creation.** The callback URL depends on the final
   `onrender.com` hostname, which does not exist until the service is created.
   Create the OAuth App after step §18.
