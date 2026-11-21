"use client";
import { useLocale } from "@/lib/i18n/provider";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ArrowDownLeft,
  GitBranch,
  FileText,
} from "lucide-react";
import { minorToDisplayNumber } from "@/lib/quotes";
import { Invoice, BusinessActivityEvent } from "@/lib/models";

import { Mark, Badge, Cta } from "./ui";
import { InvoiceTable } from "./invoice-table";
export function Overview({
  invoices,
  activity,
  readOnly = false,
}: {
  invoices: Invoice[];
  activity: BusinessActivityEvent[];
  readOnly?: boolean;
}) {
  const { t, money, date } = useLocale();

  const total = invoices.reduce((s, i) => s + i.amount, 0);
  const settled = invoices.filter((i) => i.status === "Settled");
  const outstanding = invoices.filter(
    (i) => !["Settled", "Failed", "Draft"].includes(i.status),
  );
  return (
    <>
      <div className="page-title">
        <div>
          <span className="section-label">{t("Your business, connected")}</span>
          <h1>{t("A clear view of what’s moving.")}</h1>
          <p>{t("Welcome back to Aurora Comércio.")}</p>
        </div>
        {!readOnly && <Cta href="/app/invoices/new">{t("Create invoice")}</Cta>}
      </div>
      <div className="metrics">
        <article>
          <span>
            {" "}
            {t("Total invoiced")} <FileText size={17} />
          </span>
          <strong>{money(total)}</strong>
          <small>
            {invoices.length} {t("invoices · demo workspace")}
          </small>
        </article>
        <article>
          <span>
            {" "}
            {t("Settled payments")} <ArrowDownLeft size={17} />
          </span>
          <strong>
            {money(
              settled.reduce(
                (s, i) =>
                  s + minorToDisplayNumber(i.receipt?.amountMinor || "0"),
                0,
              ),
              "USDG",
            )}{" "}
            <em>USDG</em>
          </strong>
          <small>
            {settled.length} {t("simulated settlements")}
          </small>
        </article>
        <article>
          <span>
            {" "}
            {t("Outstanding")} <GitBranch size={17} />
          </span>
          <strong>
            {money(outstanding.reduce((s, i) => s + i.amount, 0))}
          </strong>
          <small>
            {outstanding.length} {t("payments in progress")}
          </small>
        </article>
      </div>
      <div className="overview-mid">
        <div className="flow-panel">
          <div className="row">
            <h2>{t("Your payment corridor")}</h2>
            <span className="subtle">{t("Illustrative workflow")}</span>
          </div>
          <div className="mini-flow">
            <div className="currency-symbol brazil">R$</div>
            <span className="flow-line" />
            <div className="flow-logo">
              <Mark />
            </div>
            <span className="flow-line" />
            <div className="currency-symbol">$</div>
          </div>
          <div className="row">
            <span>
              {" "}
              {t("Brazilian reais")} <small>{t("Pix funding")}</small>
            </span>
            <span className="center">
              {" "}
              {t("Intelligent routing")} <small>{t("3 sample routes")}</small>
            </span>
            <span className="align-right">
              {" "}
              {t("Digital dollars")} <small>{t("USDG settlement")}</small>
            </span>
          </div>
        </div>
        <div className="next-step">
          <span className="dark-pill">{t("Start here")}</span>
          <h2>
            {" "}
            {t("Meet your next")} <br /> {t("payment journey.")}{" "}
          </h2>
          <p>
            {" "}
            {t(
              "Take a demo invoice from Pix confirmation to a settlement receipt.",
            )}{" "}
          </p>
          <Link
            href={
              invoices.find((i) => i.status === "Pending payment")
                ? `/app/invoices/${invoices.find((i) => i.status === "Pending payment")!.id}`
                : "/app/invoices/new"
            }
          >
            {" "}
            {t("Explore the payment flow")} <ArrowUpRight size={16} />
          </Link>
        </div>
      </div>
      <div className="section-title">
        <h2>{t("Recent invoices")}</h2>
        <Link className="text-link" href="/app/invoices">
          {" "}
          {t("View all invoices")} <ArrowRight size={15} />
        </Link>
      </div>
      <InvoiceTable invoices={invoices} compact />
      <div className="activity-grid">
        <section>
          <h2>{t("Recent settlements")}</h2>
          {settled.slice(0, 3).map((i) => (
            <Link
              className="activity-row"
              key={i.id}
              href={`/app/invoices/${i.id}`}
            >
              <span className="activity-icon">
                <Check size={17} />
              </span>
              <span>
                <strong>{i.supplier}</strong>
                <small>
                  {i.reference} {t("· Simulated")}
                </small>
              </span>
              <b className="mono">
                {money(
                  minorToDisplayNumber(i.receipt?.amountMinor || "0"),
                  "USDG",
                )}{" "}
                <small>USDG</small>
              </b>
            </Link>
          ))}
        </section>
        <section>
          <h2>{t("Workspace activity")}</h2>
          {activity.map((event) => {
            const i = invoices.find(
              (invoice) => invoice.id === event.invoice_id,
            );
            if (!i) return null;
            return (
              <Link
                className="activity-row"
                key={event.id}
                href={`/app/invoices/${event.invoice_id}`}
              >
                <span className="activity-icon">
                  <FileText size={17} />
                </span>
                <span>
                  <strong>{i.reference}</strong>
                  <small>
                    {i.supplier} · {date(event.created_at)}
                  </small>
                </span>
                <Badge status={event.new_state} />
              </Link>
            );
          })}
        </section>
      </div>
    </>
  );
}
