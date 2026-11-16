"use client";
import { LanguageSelector, useLocale } from "@/lib/i18n/provider";
import { Logo, Cta } from "./ui";
export function Developers() {
  const { t } = useLocale();

  return (
    <>
      <header className="marketing-header wrap">
        <Logo />
        <div className="header-actions">
          <LanguageSelector />
          <Cta href="/app">{t("Open demo")}</Cta>
        </div>
      </header>
      <main id="main" className="wrap section docs">
        <span className="section-label">
          {t("Developer overview · Phase 2A")}
        </span>
        <h1>
          {" "}
          {t("One bridge.")} <br /> {t("Separate integration layers.")}{" "}
        </h1>
        <p>
          {" "}
          {t(
            "Invoices and simulated settlement are persisted through an authenticated PostgreSQL API. No contract, wallet or payment provider is connected.",
          )}{" "}
        </p>
        {[
          [
            t("Invoice API & persistence"),
            t(
              "The API validates inputs, enforces tenant isolation and records transactional lifecycle events. Production authentication remains a deployment gate.",
            ),
          ],
          [
            t("Pix payment provider"),
            t(
              "Integrate a sandbox PSP, verified webhook signatures, idempotent payment events and reconciliation.",
            ),
          ],
          [
            t("Wallet & USDG"),
            t(
              "Add wallet-provider and token adapters, network validation, recipient checks and explicit signing approval.",
            ),
          ],
          [
            t("Arbitrum & Stylus"),
            t(
              "Implement and test contracts separately. Benchmark the routing optimizer against deterministic fixtures before any onchain use.",
            ),
          ],
          [
            t("Security & operations"),
            t(
              "Define KYB/AML requirements with qualified providers, audit contracts, rate-limit APIs, add observability and failure recovery.",
            ),
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
        <Cta href="/app/invoices">{t("Try the simulated lifecycle")}</Cta>
      </main>
    </>
  );
}
