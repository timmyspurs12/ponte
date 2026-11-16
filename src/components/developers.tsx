"use client";
import { Invoice } from "@/lib/models";
import { demoInvoiceService as service } from "@/lib/demo-service";
import { Logo, Cta } from "./ui";
export function Developers() {
  return (
    <>
      <header className="marketing-header wrap">
        <Logo />
        <Cta href="/app">Open demo</Cta>
      </header>
      <main id="main" className="wrap section docs">
        <span className="section-label">Developer overview · Phase 1</span>
        <h1>
          One bridge.
          <br />
          Separate integration layers.
        </h1>
        <p>
          The current application uses a browser-local demo invoice service. No
          endpoint, contract, wallet or payment provider is connected.
        </p>
        {[
          [
            "Invoice API & persistence",
            "Replace InvoiceService with an authenticated API adapter; validate inputs server-side and reconcile invoice events.",
          ],
          [
            "Pix payment provider",
            "Integrate a sandbox PSP, verified webhook signatures, idempotent payment events and reconciliation.",
          ],
          [
            "Wallet & USDG",
            "Add wallet-provider and token adapters, network validation, recipient checks and explicit signing approval.",
          ],
          [
            "Arbitrum & Stylus",
            "Implement and test contracts separately. Benchmark the routing optimizer against deterministic fixtures before any onchain use.",
          ],
          [
            "Security & operations",
            "Define KYB/AML requirements with qualified providers, audit contracts, rate-limit APIs, add observability and failure recovery.",
          ],
        ].map(([t, d], i) => (
          <article className="doc-row" key={t}>
            <span className="mono">0{i + 1}</span>
            <div>
              <h2>{t}</h2>
              <p>{d}</p>
            </div>
          </article>
        ))}
        <Cta href="/app/invoices/demo-1">Try the simulated lifecycle</Cta>
      </main>
    </>
  );
}
