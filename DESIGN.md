# PONTE — design specification

## Positioning
A proposed financial bridge for Brazilian businesses and international suppliers. Precision over hype. Frontend demonstration, not a bank or operational payment service.

## Research, 16 November 2026
Reviewed fetched content from Stripe Invoicing (payment-first invoice hierarchy), Wise Business (plain-language currency and fee presentation), Ramp accounts payable (operational task focus), Linear (compact navigation and product-led storytelling). stripe.design is an **independent study**, not Stripe's official design team: useful for restrained spacing and motion. Godly redirected to Recent; reviewed its index and Land-book's index, not individual visual projects. All four requested Pinterest searches returned HTTP 403; no claims based on inaccessible pins.

Installed and read frontend-design, ui-ux-pro-max, animate and web-design-guidelines under .claude/skills. UI/UX Pro Max financial typography search supports IBM Plex for institutional data; reject its generated purple/gold dark palette because it conflicts with the brief. Choose Manrope for a more distinctive headline voice and Plex Mono for exact values.

## Concept: a clear passage
A large left-aligned editorial headline meets a purpose-built routing atlas. Fine horizontal rules and connection lines imply movement across borders. Not every surface is a card. A dark routing panel earns its contrast by explaining execution.

## Tokens
Ink #17272E; forest #102A2B; teal #167A70; jade #DCEBE3; chalk #F4F6F2; white #FFFFFF; slate #596C70 (darkened for contrast); brass #D6A15F (decorative only). Error #A53636; pending #825719. Borders #DCE2DD.

## Type
Self-hosted Manrope: body 14–16/1.6, labels 12–13, h2 36–48/1.12, hero 64–82/1.04, weights 400–650. IBM Plex Mono: amounts, route quotes, identifiers 11–14; tabular numbers. Product h1 32. No wide uppercase labels except compact wordmark.

## Structure
4px base; 8/12/16/24/32/48/72/112 spacing. Max content 1240px. Desktop 2-column hero, 12-column product layout. Borders 1px, radius 6px controls, 12px raised panels, subtle shadow only on floating payment artifacts. Lucide icons, 18px, decorative icons hidden from AT. Custom paired-arch bridge symbol.

## Motion
One orchestrated hero entrance; route tracing explains the corridor. Motion React handles route-selection and payment-state entrances. CSS handles 150ms press/hover. ease-out for entrance, no UI bounce. Reduced-motion disables travel and path drawing. Animation never blocks invoice access.

## Responsive
1440/1280: horizontal nav and side-by-side routing. 768: condensed layout and two metrics per row. 390/360: disclosure nav, stacked hero and forms, invoice table scrolls within its own labeled container. Minimum 44px touch targets; no page horizontal overflow.

## Accessibility
Semantic headings/landmarks, skip link, visible focus, labeled inputs and inline errors, status text not just color, polite live feedback, native selects/dialog confirmation where applicable, reduced motion, readable contrast. Financial chart includes textual totals.

## Review
Avoid the default three-card repetition: use a route atlas, horizontal lifecycle, split dark routing workspace, numbered process only where sequential, and editorial security columns. No fabricated traction, audits, customers or deployed integration claims.

## Phase 1.1 — localization, not redesign

The approved mineral-green/chalk palette, Manrope/Plex Mono, route SVG, editorial grid, compact navigation, financial tables and Motion vocabulary are unchanged. A native keyboard-accessible globe/language select offers **Português (Brasil)** and **English** in marketing, developer and application headers. Portuguese is the default. On narrow screens, optional header actions give way to the language control; the invoice/payment CTAs remain in the page content.

English source messages form stable translation keys in `src/lib/i18n/pt-BR.ts`, used through a shared provider rather than duplicate page components. Whole-message interpolation is used for amounts, pagination and confirmation sentences. Status codes, business names, user-entered content, addresses, hashes, token/protocol names and code identifiers remain locale-neutral. Language preference is a first-party cookie (no account/backend); initial server markup, HTML lang and client switching stay aligned. Switching updates metadata, labels, errors, status text and toasts without resetting the journey.

Formatting uses `Intl` with pt-BR/en-US, including Brazilian grouping/decimal separators and localized dates. Date-only values do not shift by timezone; settlement timestamps explicitly indicate UTC. Financial amount and timestamp data remain unformatted in storage. A modest Portuguese hero type-size adjustment accommodates longer copy without changing the grid. The selector and bilingual page widths are tested at 1440/1280/768/390/360px. See `docs/FINANCIAL_MODEL.md` for integer quote precision and rounding rules.
