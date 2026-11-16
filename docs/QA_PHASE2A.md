# Phase 2A verification

Date: 16 November 2026. This document records observed local checks; final-commit GitHub Actions results are attached to the Phase 2A PR handoff rather than assuming a workflow file proves success.

## Local environment and results

- Linux x64 Arena, Node 22, Next.js 16.4.6, real PostgreSQL 18.6, UTF8.
- `db:seed`: clean initial schema migration and business/user/admin creation passed.
- Repeated `db:migrate`: passed without reapplying versioned migrations.
- `test:migrations`: passed against isolated real-PG schemas: populated initial-schema upgrade preserves data/events; immutable events restored; clean multi-file migration runner and repeat execution verified.
- `db:fixtures`: eight records created through the actual service/lifecycle, not browser financial fixtures.
- `db:reset -- --confirm-local-reset`: executed successfully against the local loopback simulation DB; migrates/seeds again. Reset is destructive and must never target valuable data.
- `test:backend`: **13/13 passed**. Real PG—not SQLite, a mocked driver or an in-memory approximation.
- ESLint, TypeScript and production `next build`: passed.
- Playwright: **15/15 passed** using the explicit restricted-Linux Chromium fallback. CI uses standard Chromium, separately verified through its actual run.
- `npm audit --omit=dev`: **0 production vulnerabilities** observed. Full audit reports 8 moderate development-only findings in the ESLint/TypeScript-ESLint/minimatch dependency chain; no unsafe forced major upgrade was applied.
- Served the built production application locally on port 3001: a request with the valid dev bearer token returned **503 AUTH_NOT_CONFIGURED**; `/dev-login` returned **404**. Stopped that verification server afterward. No public deployment was made.

## Backend coverage

Active/disabled memberships, viewer read-only enforcement, unauthenticated rejection and production fail-closed; canonical amount ranges and forbidden fields; case-insensitive tenant reference uniqueness; Draft-only edits; same-key concurrent replay and different-payload conflict; concurrent duplicate payment protection; terminal/invalid transitions; missing/expired quote on routing and expiry recheck on settlement; locked alternate route; one exact persisted receipt/settlement; NULL hash and actual=expected output; append-only events; cross-tenant GET/mutation and same-reference independence; pagination bounds/rate counters; real UTF8 server/PG checks/FK/check constraints/transaction rollback; single quote retrieval only for its invoice; precise timestamp/update metadata; generated relational descriptors/currencies/assets; snapshot mismatch and JSON-null rejection; explicit previous/new event states; business activity pagination/filter/isolation; malformed monetary HTTP values return 422 (not BigInt conversion failures); safe HTTP envelopes; same-origin Host comparison that does not trust Forwarded-Host.

## UI coverage

Portuguese default and English, cookie/language persistence, localized money/dates/minimums and static translation coverage; create→API GET→clear localStorage→refresh→simulated funding→alternate route→refresh→settlement/export→**open settled URL in a separate authenticated browser context**, with no shared localStorage; search/filter/sort/pagination; authenticated payment presentation; missing invoice; keyboard radio selection, dialog cancel/confirm/Escape, mobile navigation and screenshot/overflow checks at 1440/1280/768/390/360px. Actual `/dev-login` form submission is tested, as are HttpOnly/SameSite cookie attributes and anonymous API rejection.

Axe checks selected screens in both languages. Tests wait for final opacity before contrast analysis; this avoids mistaking intermediate Motion entrance frames for the final text contrast. This is not a complete accessibility audit.

## Issues found and corrected during implementation

- Removed an obsolete developer-page import after deleting the browser demo service.
- Login initially compared browser Origin with Next's internal 0.0.0.0 bind origin; changed to validated Origin vs actual Host, with a negative Forwarded-Host/attacker test. The browser form now successfully logs in.
- Initial embedded PG defaulted to SQL_ASCII; rebuilt the empty local development cluster explicitly as UTF8 and added an encoding assertion.
- Axe sometimes sampled hero/execution entrance opacity mid-animation; wait for completed opacity, not arbitrary screenshot timing.
- Removed remaining hard-coded `/demo-1` links after switching persisted invoices to UUIDs.

## Limits and disclosure

No native Windows 10/macOS run, Safari/Firefox run, manual screen-reader certification, physical low-powered device test, hosted provider test or production-auth integration is claimed. No real PSP/webhook, token transfer, wallet signing, contract, Stylus, market quote, managed DB, cloud deployment or paid resource was exercised. Embedded PostgreSQL's prerelease packaging is not a production recommendation. Production authentication and operational/security readiness remain explicit gates, not hidden TODOs behind public writable endpoints.

The Phase 1.1 screenshots and [historical QA](QA.md) remain the approved visual history; new automated run screenshots/reports are ignored artifacts, not silently substituted approved baselines.

## Detailed-checklist follow-up

The follow-up on the same open PR adds forward migration 002 rather than rewriting migration 001. Existing records remain intact. Newly introduced historical metadata uses migration time where no original timestamp existed; it is not claimed as original creation provenance. Business activity now comes from the persisted event endpoint and is displayed by the overview. Final-head Actions conclusions for this amendment are recorded in the PR handoff after the run, not inferred from the earlier commit's green checks.

## Phase 2A.2 frontend/backend consistency

- Failed-state retry removed; prominent localized replacement link opens the new invoice form. English and Portuguese tests assert no unsupported payment action, no API mutation on navigation, and unchanged original invoice plus activity history.
- Payment-link copy now explains workspace-only access, existing authenticated membership, internal demonstrations and unimplemented external supplier access. No public-checkout or browser-store claims remain in the interface.
- Four additional Playwright scenarios (two per language) verify the Failed replacement flow, all restriction messages, copied internal URL, authorized existing-invoice access, and anonymous API/UI rejection without invoice reference/wallet disclosure.
- All 15 browser/unit scenarios, all 13 real-PG backend tests, clean/upgrade migration integration, lint, TypeScript and production build are executed for this amendment. Actual final-commit Actions links are recorded in the PR handoff. The first new-test run caught a test locator matching both the application alert and Next's route announcer; scoping the locator to the main region fixed the test ambiguity without weakening its access assertions.
- No backend transition/authentication change, public deployment, merge or real financial operation is included.
