> **Phase 2A update (16 November 2026):** the backend now owns funding validation, quote generation, locked routes, expiry and settlement simulation in PostgreSQL. The Phase 1 descriptions below document the retained arithmetic/display model; browser-local receipt normalization has been removed and old localStorage data is not imported. See the delivered boundary at the end and [API.md](API.md).

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

## Phase 2A delivered boundary

- API creation/update accepts **canonical integer BRL cent strings only**, 100–1000000000. Floats, scientific notation, leading zeros, unknown fields and client outputs are rejected. PostgreSQL bigint stores authoritative funding; JSON transports strings.
- `Invoice.amount` and `Payment.amount` remain numeric **display compatibility** fields for the approved UI. The form adapter validates/encodes its input; the server independently validates the minor string and calculates outputs. API never accepts the numeric display fields, client receipts or status in invoice fields.
- Server quote snapshots persist all candidates, rational rate, fee units/bps, minima, tolerance, simulated=true/source, and a 15-minute expiry. The invoice also stores a server-generated display preview; locking requires a current persisted quote ID, never the preview alone.
- Routing locks a candidate and quote for the same tenant/invoice. Settlement checks expiry again, uses the locked server candidate, writes expected/minimum/actual demo output and produces a server timestamp/receipt atomically with its event and idempotency record. Output below minimum is constrained by PostgreSQL; the simulation deterministically sets actual=expected.
- Quote/receipt financial arithmetic remains **BigInt** with the exact floors above. Currency formatting is never a persistence format.
- BRL cents, **USD accounting cents** for illustrative execution cost, and **two-decimal demo USDG units** are explicitly different units. Actual token base units, decimals, chain address and market FX remain unknown/unverified. NULL transaction hash is enforced; SIM identifiers are not blockchain evidence.
- Expired routing cannot execute or silently change its quote/route. Mark Failed; explicit recovery/requote orchestration is future work.

The authoritative state machine, replay/idempotency/concurrency and tenant constraints are tested against real PostgreSQL. No PSP, market quote, wallet, onchain token metadata or contract execution is implied. Further token/market adapters must introduce verified units and independent reconciliation rather than reuse this demo precision as actual token metadata.
