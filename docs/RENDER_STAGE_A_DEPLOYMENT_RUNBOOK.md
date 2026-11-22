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
| `PONTE_PUBLIC_DEMO_READ_ONLY`   |                            no | Keep disabled in Stage A. Enable only in a separately reviewed synthetic-demo phase.                                                                             |
| `PONTE_PUBLIC_DEMO_BUSINESS_ID` |                   conditional | Required only after public demo onboarding has been explicitly approved; it must reference a distinct, existing synthetic business.                              |

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
- public viewer onboarding and a populated public demo. Keep it disabled until
  a separate reviewed synthetic demo-content provisioning phase creates a
  distinct tenant using only synthetic records.

No simulated journey should be represented to a judge as a real payment, KMS
operation, or blockchain anchor.

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
