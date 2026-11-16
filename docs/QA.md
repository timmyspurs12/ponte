# Phase 1.1 QA handoff

Validated on 16 November 2026. The live Arena preview serves the production frontend build on port 3000. No public deployment, payment integration or Phase 2 implementation was initiated. Phase 1 screenshots remain as baselines; new Portuguese screenshots have the `phase1.1-pt-` prefix.

## Results

| Check | Observed result |
|---|---|
| Dependency installation | Lockfile installation succeeded in real Ubuntu GitHub Actions (`npm ci`) |
| ESLint | `npm run lint`: pass |
| TypeScript | `npm run typecheck`: pass |
| Production build | `npm run build`: pass |
| Full local suite | **11 passed**, approximately 1.6 minutes, against the production preview |
| Browser JS and console errors | None in the tested bilingual journeys/layouts |
| Ubuntu / standard Chromium | Actual GitHub Actions runs succeeded; see CI evidence below |
| Windows 10 native execution | **Not performed**: no Windows host is available in this session. Portable commands and code paths are implemented, not claimed as a native Windows test result. |
| Production dependency audit | `npm audit --omit=dev`: zero vulnerabilities |
| Full dependency audit | Eight moderate dev-tool advisories remain in the ESLint ecosystem; no incompatible forced major downgrade was applied. |

## CI evidence and behavior

Workflow: [Frontend quality](../.github/workflows/frontend.yml). Ubuntu 24.04 + Node 22, `npm ci`, lint, typecheck, production build, `playwright install --with-deps chromium`, full tests and artifact upload. It triggers on PRs targeting main and pushes to the existing feature branch. There are no deployment steps or credentials.

The first Phase 1.1 source commit, `2f31bf1db13e860e3a00c5a53c8a6a5506e20931`, produced **real successful Actions runs**, including standard Chromium browser installation and the then-eight-test suite:

- [PR event run 43872766548](https://github.com/timmyspurs12/ponte/actions/runs/43872766548)
- [Push event run 43872766243](https://github.com/timmyspurs12/ponte/actions/runs/43872766243)

The expanded **eleven-test** suite also passed on source commit `040986644b3f3386c83ec44cdd31ebe6fb494239` in both real standard-Chromium runs:

- [PR event run 43874234876](https://github.com/timmyspurs12/ponte/actions/runs/43874234876)
- [Push event run 43874228121](https://github.com/timmyspurs12/ponte/actions/runs/43874228121)

All recorded job steps succeeded, including the full test step and report upload. The first workflow revision emitted a non-blocking action-runtime deprecation annotation. The workflow now uses verified v5 tags of checkout/setup-node/upload-artifact (Node 24 action runtime, with Node 22 still used for the application). The final-head run link and SHA are recorded in the Phase 1.1 handoff comment on [PR #1](https://github.com/timmyspurs12/ponte/pull/1). No success is inferred merely from creating YAML.

## Actually tested

- The existing complete English flow: invalid form, creation, Pix simulation, alternate route, cancel/confirm dialog, refresh persistence, receipt export, public checkout, missing invoice, search/filter/sort/pagination.
- Portuguese is the default on a fresh browser, with server/client `html.lang` alignment.
- Selector changes labels, validation errors, statuses, route labels and number formatting immediately without resetting the journey.
- English preference survives reload; Portuguese-created invoice data and user-entered business names remain unchanged.
- Complete Portuguese invoice/Pix/settlement flow with language switching before and after route selection.
- Selected route's minimum output is displayed in both locales from the candidate model, not recalculated in the panel.
- Filter values remain stable when translated option labels change.
- Both languages across `/`, `/app`, `/app/invoices`, `/app/invoices/new`, `/pay/demo-1` and `/developers` at **1440, 1280, 768, 390 and 360px**. Language selector visible and functional; no document horizontal overflow.
- Brazilian `R$ 25.000,00`, English `R$25,000.00`, localized USDG decimals, pt-BR/en-US dates and explicitly UTC timestamps.
- Exact integer output/minimum/fee formulas, boundary values, rejection of fractional minor units/sub-cent legacy amounts, JSON serialization, three distinct candidate minimums, locked-route settlement rejection and old receipt normalization.
- Translation-registry completeness for every static interface `t()` message key.
- Keyboard radio navigation, Escape/cancel/confirm dialog handling, reduced motion and mobile settlement.
- Axe A/AA + 2.1 AA scans of four main initial screens in **both languages**. No detected violations. Scans wait for the initial hero opacity entrance to complete to avoid measuring transient faded colors. Not an accessibility certification.

## Visual preservation and refinement

Inspected actual Portuguese desktop/mobile screenshots of homepage, overview and payment detail, alongside the original English baselines. The mineral-green/chalk identity, Manrope, IBM Plex Mono, bridge illustration, editorial hierarchy, compact navigation, tables and restrained Motion remain intact. Changes are limited to the language control, small responsive header adjustments and Portuguese headline sizing. A 360px developer-header overflow discovered in testing was corrected by grouping its controls consistently with marketing navigation.

Six new images: `docs/screenshots/phase1.1-pt-{home,overview,payment}-{1440,390}.png`. Automated test screenshots now go to ignored `test-results/screenshots/`, so normal CI does not rewrite the approved baselines.

## Platform boundaries

Standard Playwright is the default. The Node runner uses `spawnSync(process.execPath, ...)` and forwards exit codes/arguments without Bash environment assignment, shell expansion or Windows `.cmd` quoting. Playwright starts the built frontend itself; it only reuses existing servers outside CI.

This restricted Linux sandbox cannot download standard Chromium from the browser CDN. Local tests therefore used the **explicit** `PONTE_BROWSER_FALLBACK=1` path with the existing registry-packaged Chromium and bundled libraries. Paths are resolved by the package, not a hardcoded `/tmp/chromium` in config. GitHub Actions uses the standard path and actually installed its browser/dependencies successfully. The fallback refuses unsupported operating systems; Windows uses `npm run test:install` then `npm test` without modifying source configuration.

## Remaining issues / non-claims

No native Windows 10, Safari/Firefox, physical low-powered device or manual screen-reader testing was available. Native number/date input editing follows browser conventions; there is no custom localized money-entry mask. Invoice/payment amounts retain the explicitly marked Phase 1 major-unit storage boundary; real backend persistence must migrate to integer minor units as described in [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md). USDG's two-decimal demo scale is not a claim about onchain decimals.

Demo links remain browser-local, not shareable records. No real quotes, payments, authentication, banking QR codes, smart contracts, wallet signing, PDF receipts or backend persistence. These boundaries are intentional and unchanged.
