# Phase 1.1 monetary model

All figures remain **deterministic frontend demo fixtures**, not market data, actual liquidity, a Stylus calculation, a token redemption guarantee or an executable quote.

## Boundaries

`Invoice.amount` and `Payment.amount` retain their Phase 1 browser-local **major-unit numbers** for compatibility. Their type comments mark them as legacy. The form rejects sub-cent precision. `majorToMinor()` validates the legacy boundary and produces a base-10 integer string. `demoQuote()` is the only bridge from a legacy invoice to `quote({ fundingMinor })`.

Quote, candidate, receipt and execution amounts use JSON-safe **integer strings**. BigInt is used only inside calculation functions; it is never serialized directly. Basis points are integral numbers (10,000 = 100%). `minorToDisplayNumber()` is explicitly a display-only conversion, never an execution input.

BRL uses 2 demo decimals. **USDG also uses 2 decimals in this illustration only. These are not claimed onchain USDG decimals.** A real token adapter must obtain and validate contract metadata separately. Token symbols and technical identifiers are never translated.

## Exact calculations

For funding `F` in BRL cents, illustrative rate `525 / 100` BRL per USDG:

- Gross USDG demo cents: `floor(F × 100 / 525)`.
- Candidate fee: 35 / 48 / 65 bps.
- Candidate output: `floor(F × 100 × (10000 − feeBps) / (525 × 10000))`.
- `feeMinor = grossOutputMinor − outputMinor`. This is a demo difference **including the cent-rounding effect**, not a separately executable fee transfer.
- Slippage is an **informational price-impact estimate**: 5 / 8 / 12 bps. It is not subtracted a second time from the illustrative net output.
- Protection tolerance is a separate, explicit **50 bps** on each candidate. Each estimate is below that tolerance.
- Each candidate owns `minimumOutputMinor = floor(outputMinor × (10000 − toleranceBps) / 10000)`.
- Execution cost is separately illustrated as `2` USD cents, not deducted from token output. It is not a live gas estimate.

All positive financial division truncates **down** exactly once at the stated boundary. No `toFixed` or floating-point multiplication participates in quote or minimum-output arithmetic. The legacy numeric form adapter uses `toFixed(2)` only to validate and encode already-entered major-unit values, not to calculate execution amounts.

For R$ 25.000,00:

| Candidate | Fee | Output USDG | Minimum USDG |
|---|---:|---:|---:|
| Direct | 35 bps | 4,745.23 | 4,721.50 |
| Split | 48 bps | 4,739.04 | 4,715.34 |
| Multi-hop | 65 bps | 4,730.95 | 4,707.29 |

The old panel rounded its independent minimum; Phase 1.1 displays the selected candidate's already-floored value instead. No minimum exists on `PaymentQuote` itself. Selection persists when the user locks the route; settlement cannot silently switch to another route. Old browser receipts are normalized to integer strings on read while preserving their timestamp and route.

## Display and localization

`src/lib/i18n/format.ts` alone handles `Intl` currency, number and date presentation. Currency formatting is never persisted. USDG uses locale-aware decimal formatting with its unchanged symbol in the surrounding interface, not an ISO-USD currency formatter. Date-only invoice fields render in UTC without shifting the calendar date; timestamps explicitly say UTC.

## Phase 2 transition — not implemented

1. Change invoice/payment input and persistence contracts to integer BRL minor-unit strings. Remove the legacy numeric adapter; migrate saved database records explicitly.
2. Validate integer ranges, decimal scales, canonical encodings and arithmetic server-side; use fixed-point/rational math with documented rounding. Never trust browser-derived amounts.
3. Separate fiat precision, USD accounting precision and actual token base units. Validate chain ID, contract address, decimals, quote expiry and provider fees.
4. Use an authoritative quote ID, selected candidate ID, minimum output, deadline and token base-unit amounts for execution; verify on the backend and in audited contracts.
5. Integrate the real market/PSP/routing sources only after frontend approval. Reconcile realized execution against quotes, including fees, price impact, failures and reorgs.

Tests cover exact candidate outputs, fee reconciliation, per-route floors, JSON safety, range/cent boundaries, selected minimum display after language changes, and settlement of the locked route. This is a frontend readiness improvement, not a backend or contract implementation.
