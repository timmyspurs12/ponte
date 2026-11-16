# Phase 1 QA handoff

Validated on 16 November 2026 in the Arena Linux environment. Final preview runs the production build on port 3000. No external deployment was initiated.

## Results

| Check | Result |
|---|---|
| `npm ci` / dependency installation | Initial `npm install` succeeded; package-lock included for repeatable `npm ci` |
| `npm run lint` | Pass, zero errors or warnings |
| `npm run typecheck` | Pass |
| `npm run build` | Pass, Next.js production compilation and route generation |
| `npm test` on production preview | **3 passed**, 41.2 seconds on final run |
| Browser JS/console errors | None in tested journeys, including reduced-motion check |
| Production dependency audit | `npm audit --omit=dev`: zero vulnerabilities |
| Full dependency audit | Eight moderate development-tool advisories in ESLint/TypeScript ESLint/minimatch dependency tree. Not silently forced to an incompatible Next ESLint major; review upstream updates before production delivery. |

## Actually tested

- Business overview and sample totals.
- Invoice form validation and error messages; valid invoice creation.
- Pix confirmation simulation, alternate liquidity route selection and route locking.
- Refresh persistence before settlement and reopening settled records.
- Confirmation dialog cancel, confirm and Escape behavior.
- Simulated receipt and JSON download filename.
- Public-facing payment route in the same browser store.
- Search, status filter, empty result, clear filters, sorting selection and pagination.
- Missing demo invoice recovery.
- All main pages at 1440, 1280, 768, 390 and 360px; document-width overflow assertions.
- Mobile navigation disclosure and in-page navigation.
- Keyboard arrow selection for the radio group, with focus and checked-state assertions.
- Reduced-motion rendering and successful mobile settlement.
- Axe WCAG 2 A/AA + 2.1 AA rule scan of `/`, `/app`, `/app/invoices/new`, `/pay/demo-1`: no detected violations in those initial states. Not a complete WCAG audit.

## Visual review and corrections

Inspected actual screenshots of desktop/mobile homepage, overview and settlement receipt. Refined small-copy sizing and dark panel contrast. Fixed mobile page overflow caused by a visually hidden invoice-table header escaping its scroll region. Corrected low-contrast process labels, final CTA metadata and inactive journey labels discovered by axe. Removed a reduced-motion server/client initial-style mismatch. Native confirmation dialog closes before removal, restoring focus to the payment action. The skip link uses clipped hidden styling when unfocused, preventing full-page screenshot artifacts without removing keyboard access.

Final images: `docs/screenshots/home-1440.png`, `home-390.png`, `overview-desktop.png`, `overview-mobile.png`, `receipt-desktop.png`, `receipt-mobile.png`.

## Test environment caveats

The standard Playwright browser CDN download failed due to network restrictions. Tests **did run**, using `@sparticuz/chromium` from the allowed npm registry and its bundled Linux libraries. Preparation is scripted by `npm test`. These are headless Chromium checks, not Safari/Firefox, screen-reader certification or physical low-powered-device measurements. No claims of live PSP, chain or Stylus integration are made. Generated browser caches and test reports are ignored by Git.

## Remaining frontend boundaries

Local demo links cannot transfer browser-local records to another user. No production sign-in, PDF receipt, localization, cross-device synchronization or banking QR code. Filtering is component-local rather than encoded in URL query parameters. Invoice due dates use native date inputs and ISO date text. A full localized money-input mask, deeper screen-reader testing and independent performance profiling would be useful follow-up polish. Phase 2 is unimplemented and gated on frontend approval.
