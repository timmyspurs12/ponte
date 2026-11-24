# Windows 10 demo compatibility

**Status: static assessment only — not verified on a real Windows machine.** No Windows 10 host was available in the audit environment. Nothing in this document should be read as “tests passed on Windows”. The Linux instructions in [HACKATHON_DEMO_GUIDE.md](HACKATHON_DEMO_GUIDE.md) remain intact and are the executed path.

## Assessment

| Component | Finding | Confidence |
| --- | --- | --- |
| Host OS | Windows 10 Pro **x64** is the assumed target. Windows 10 32-bit, ARM and Windows 11 ARM are not covered by the pinned embedded PostgreSQL platform package. | Static |
| Node.js | Use the official **x64** Node.js 22.17+ Windows installer. The project scripts use Node APIs and `npm run` commands without shell-specific syntax. | Static |
| Embedded PostgreSQL | The lockfile includes the optional `@embedded-postgres/windows-x64@18.6.0-beta.19` package. Its metadata declares `os: ["win32"]`, `cpu: ["x64"]`; `embedded-postgres/dist/binary.js` maps `win32`+`x64` to that package. The Windows package contains `initdb.exe`, `pg_ctl.exe` and `postgres.exe`, and its `pg-symlinks.json` is empty, so symlink hydration is not expected to require Developer Mode for this pinned version. | Inspected package metadata and tarball |
| Windows runtime handling | `embedded-postgres` explicitly avoids `locale -a` on Windows and uses `taskkill` for shutdown because Windows does not support SIGINT for that path. | Inspected installed source |
| Next.js application | `npm run dev` uses `next dev --hostname 0.0.0.0`; no Unix shell is involved. Demo auth is development-only and fails closed in production builds. | Static |
| Browser tests | Use ordinary Playwright Chromium installed with `npm run test:install`. Do **not** set `PONTE_BROWSER_FALLBACK=1`; `scripts/prepare-browser.mjs` deliberately throws on non-Linux platforms. Playwright config already uses one worker. | Static |
| Screenshot capture | `scripts/capture-hackathon-screenshots.mjs` now loads `@sparticuz/chromium` only inside the Linux fallback branch. On Windows, run it with no fallback variable after installing Playwright Chromium. | Static |
| Docker / WSL | Not required for the application demo, tests or screenshots. They are only part of the separate Stylus artifact workflow, which is not needed for this demo. | Confirmed from script scope |
| 4 GB RAM | No Windows memory measurement was taken. The low-memory path below avoids production builds and parallel browser processes; it is a risk-reduction plan, not a measured guarantee. | Unverified |

**Conclusion:** native Windows 10 x64 is plausibly supported for the complete local demo without Docker or WSL, based on package metadata and platform-aware source. It remains unverified until the commands below are executed on the owner’s machine.

### Platform assumptions inspected

- `scripts/local-postgres.ts`: starts the bundled binaries with relative `.cache/postgres/PG_VERSION`; no Unix shell, executable bit or absolute POSIX path is involved. It handles `SIGINT`/`SIGTERM`, and the library also has a Windows-specific shutdown path.
- `node_modules/embedded-postgres/dist/binary.js` and `dist/index.js`: map `win32`+`x64` to the Windows package, avoid `locale -a` on Windows, and use `taskkill` where SIGINT is unavailable.
- `package-lock.json`: locks the optional `@embedded-postgres/windows-x64@18.6.0-beta.19`; no dependency or lockfile change was made.
- `scripts/prepare-browser.mjs` and `scripts/run-tests.mjs`: `PONTE_BROWSER_FALLBACK=1` is deliberately rejected off Linux x64, so Windows must use `npm run test:install`.
- `playwright.config.ts`: one worker, ordinary Playwright Chromium by default; no platform-specific path unless the Linux fallback variable is set.
- `scripts/capture-hackathon-screenshots.mjs`: the `@sparticuz/chromium` import is now inside the Linux fallback branch, so Windows does not load a Linux-only runtime.
- `package.json`, `scripts/reset-database.ts`, `scripts/seed-fixtures.ts`, `.env.example`, `src/server/security.ts`, `tests/` and `tests-backend/`: use npm/Node commands, loopback URLs and `URL` parsing; no mandatory POSIX shell, Docker or WSL.
- `scripts/phase2b*`, the Rust/Stylus artifact workflow and Linux-browser helper scripts are outside this demo path and are not part of the Windows verification claim.

## Exact PowerShell setup

Run from a PowerShell prompt in the repository root. The commands use Windows PowerShell 5.1-compatible syntax (built into Windows 10); PowerShell 7+ should also work. Neither shell was verified here.

### 1. Check Node and install dependencies

```powershell
[Environment]::Is64BitOperatingSystem
[Environment]::Is64BitProcess
$PSVersionTable.PSVersion.ToString()
node --version
npm --version
if (Get-NetTCPConnection -LocalPort 3000,54329 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3000 or 54329 is already in use.' }
npm ci --no-audit --no-fund
```

Both `Is64Bit...` lines must return `True`; `node --version` must report `v22.17.0` or newer. Use the official x64 Node.js installer. If npm lifecycle scripts are disabled by policy, embedded PostgreSQL will not have its platform package prepared; reinstall normally or run `npm rebuild @embedded-postgres/windows-x64` before continuing.

### 2. Create `.env.local` without printing the token

```powershell
if (Test-Path .env.local) { throw '.env.local already exists; review it before continuing.' }
Copy-Item .env.example .env.local

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$rng.Dispose()
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })

$path = Join-Path (Get-Location) '.env.local'
$lines = [System.IO.File]::ReadAllLines($path)
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -like 'PONTE_DEV_TOKEN=*') { $lines[$i] = "PONTE_DEV_TOKEN=$token" }
}
[System.IO.File]::WriteAllLines($path, $lines, [System.Text.UTF8Encoding]::new($false))
Remove-Variable token

if (-not (Select-String -Path .env.local -Pattern '^PONTE_DEV_TOKEN=[A-Za-z0-9_-]{32,128}$' -Quiet)) {
    throw 'PONTE_DEV_TOKEN is missing or invalid'
}
```

The generated token is 64 lowercase hexadecimal characters. It is written only to the ignored `.env.local`; it is never printed.

### 3. Start local PostgreSQL

In **terminal 1**:

```powershell
npm run db:local
```

Leave this terminal open. The first run initialises a real PostgreSQL 18 cluster under the ignored `.cache/postgres` directory on loopback port `54329`. Embedded PostgreSQL handles Windows shutdown through its exit hook and `taskkill`; press `Ctrl+C` in this terminal when finished.

### 4. Migrate, seed and start the application

In **terminal 2**:

```powershell
npm run db:migrate
npm run db:seed
npm run db:fixtures
npm run dev
```

`db:migrate` is safe to repeat; `db:seed` also applies the migration if needed.

Then open:

```powershell
Start-Process 'http://localhost:3000/dev-login'
```

Enter the local token from `.env.local`. Do not use `npm run build && npm start` for the demo: production financial access intentionally fails closed.

### 5. Complete the deterministic invoice lifecycle

Use the seeded invoice `PNT-2026-1048`:

1. Open `/app/invoices` and select `PNT-2026-1048` (Meridian Supply Co., R$25,000.00, initially `Pending payment`).
2. Click **Simulate Pix payment received**.
3. Select **Split liquidity** and click **Select route & continue**.
4. Click **Simulate settlement**, then **Confirm simulation**.
5. Expect **4,739.04 USDG**, **Split liquidity**, **No blockchain transaction occurred**, and a `SIM-…` receipt ID.
6. Export `ponte-demo-PNT-2026-1048.json`; reload the page to confirm database persistence.

All route and settlement outputs are simulated. No wallet, RPC endpoint or transaction is involved.

## Browser tests on Windows

One-time browser install:

```powershell
npm run test:install
```

Then, with PostgreSQL running:

```powershell
npm test
```

If the demo server from terminal 2 is already running, Playwright reuses it. If not, Playwright starts one server itself. Do not set `PONTE_BROWSER_FALLBACK`.

For a lower-memory subset:

```powershell
npm test -- tests/frontend.spec.ts --workers=1
npm test -- tests/quotes.spec.ts
```

`npm test` resets the simulation tables before each browser scenario; run it before or after the demo, not during it.

## Screenshots on Windows

After installing Playwright Chromium and starting the dev server:

```powershell
npm run db:reset -- --confirm-local-reset
node scripts/capture-hackathon-screenshots.mjs
```

`db:reset` is destructive to local simulation data and reseeds the fixtures. The screenshot script requires `PNT-2026-1048` to be `Pending payment`. Do not set `PONTE_BROWSER_FALLBACK`; ordinary Playwright Chromium is used.

## Low-memory approach for 4 GB RAM

- Run the demo with `npm run dev`; **skip `npm run build` and `npm start`**.
- Use one browser window and close unrelated tabs/applications.
- Do not run tests and screenshot capture at the same time.
- Playwright already uses `workers: 1`; keep that setting.
- For a quick check, run one spec at a time as shown above.
- Keep only two Node processes necessary for the demo: `npm run db:local` and `npm run dev`.
- If memory pressure is observed, skip the browser suite entirely and use the deterministic UI lifecycle plus the committed screenshots.

These are precautions only; no Windows 4 GB memory profile was measured.

## Recovery

```powershell
npm run db:seed
npm run db:fixtures
```

`db:seed` is repeatable. For a full local reset:

```powershell
npm run db:reset -- --confirm-local-reset
```

This refuses non-loopback databases and deletes all local simulation records before reseeding.

If login fails, confirm `.env.local` has `PONTE_DEV_AUTH=1` and a valid token; then restart `npm run dev`. If port `3000` or `54329` is occupied, stop the other local process before retrying.

## Remaining Windows limitations

- No command in this document was executed on Windows; all are unverified.
- 32-bit Windows and ARM Windows are not supported by the pinned embedded PostgreSQL package.
- The `npm ci` step requires registry access for dependencies and `npm run test:install` requires a one-time Playwright Chromium download. Neither is a paid service, but both need network access.
- The bundled PostgreSQL EXEs may need a current Microsoft Visual C++ Redistributable installed; this was not tested.
- Windows memory use under a 4 GB budget was not measured.
- The Rust optimizer, Stylus artifact workflow and Linux fallback browser path are outside the demo path and were not assessed for Windows.
