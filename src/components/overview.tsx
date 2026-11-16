"use client";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ArrowDownLeft,
  GitBranch,
  FileText,
} from "lucide-react";
import { Invoice } from "@/lib/models";
import { money } from "@/lib/demo-service";
import { Mark, Badge, Cta } from "./ui";
import { InvoiceTable } from "./invoice-table";
export function Overview({ invoices }: { invoices: Invoice[] }) {
  const total = invoices.reduce((s, i) => s + i.amount, 0);
  const settled = invoices.filter((i) => i.status === "Settled");
  const outstanding = invoices.filter(
    (i) => !["Settled", "Failed", "Draft"].includes(i.status),
  );
  return (
    <>
      <div className="page-title">
        <div>
          <span className="section-label">Your business, connected</span>
          <h1>A clear view of what’s moving.</h1>
          <p>Welcome back to Aurora Comércio.</p>
        </div>
        <Cta href="/app/invoices/new">Create invoice</Cta>
      </div>
      <div className="metrics">
        <article>
          <span>
            Total invoiced <FileText size={17} />
          </span>
          <strong>{money(total)}</strong>
          <small>{invoices.length} invoices · demo workspace</small>
        </article>
        <article>
          <span>
            Settled payments <ArrowDownLeft size={17} />
          </span>
          <strong>
            {money(
              settled.reduce((s, i) => s + (i.receipt?.amount || 0), 0),
              "USDG",
            )}{" "}
            <em>USDG</em>
          </strong>
          <small>{settled.length} simulated settlements</small>
        </article>
        <article>
          <span>
            Outstanding <GitBranch size={17} />
          </span>
          <strong>
            {money(outstanding.reduce((s, i) => s + i.amount, 0))}
          </strong>
          <small>{outstanding.length} payments in progress</small>
        </article>
      </div>
      <div className="overview-mid">
        <div className="flow-panel">
          <div className="row">
            <h2>Your payment corridor</h2>
            <span className="subtle">Illustrative workflow</span>
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
              Brazilian reais <small>Pix funding</small>
            </span>
            <span className="center">
              Intelligent routing <small>3 sample routes</small>
            </span>
            <span className="align-right">
              Digital dollars <small>USDG settlement</small>
            </span>
          </div>
        </div>
        <div className="next-step">
          <span className="dark-pill">Start here</span>
          <h2>
            Meet your next
            <br />
            payment journey.
          </h2>
          <p>
            Take a demo invoice from Pix confirmation to a settlement receipt.
          </p>
          <Link href="/app/invoices/demo-1">
            Explore the payment flow <ArrowUpRight size={16} />
          </Link>
        </div>
      </div>
      <div className="section-title">
        <h2>Recent invoices</h2>
        <Link className="text-link" href="/app/invoices">
          View all invoices <ArrowRight size={15} />
        </Link>
      </div>
      <InvoiceTable invoices={invoices} compact />
      <div className="activity-grid">
        <section>
          <h2>Recent settlements</h2>
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
                <small>{i.reference} · Simulated</small>
              </span>
              <b className="mono">
                {money(i.receipt?.amount || 0, "USDG")} <small>USDG</small>
              </b>
            </Link>
          ))}
        </section>
        <section>
          <h2>Workspace activity</h2>
          {invoices.slice(0, 3).map((i) => (
            <Link
              className="activity-row"
              key={i.id}
              href={`/app/invoices/${i.id}`}
            >
              <span className="activity-icon">
                <FileText size={17} />
              </span>
              <span>
                <strong>{i.reference}</strong>
                <small>
                  {i.supplier} · {i.created}
                </small>
              </span>
              <Badge status={i.status} />
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}
