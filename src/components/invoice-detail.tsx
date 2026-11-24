"use client";
import { isMessageKey } from "@/lib/i18n/messages";
import { useLocale } from "@/lib/i18n/provider";
import Link from "next/link";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ShieldCheck,
  Copy,
  Download,
  ArrowLeft,
  CheckCircle2,
  GitBranch,
  CircleHelp,
} from "lucide-react";
import { Invoice, Status } from "@/lib/models";
import { minorToDisplayNumber } from "@/lib/quotes";
import { invoiceService as service } from "@/lib/services";
import { Badge } from "./ui";
import { InvoiceEvidencePanel } from "./invoice-evidence-panel";
import { SyntheticDemoNotice } from "./synthetic-demo-notice";
export function InvoiceDetail({
  invoice,
  refresh,
  notify,
  publicPage = false,
  readOnly = false,
  publicDemo = false,
}: {
  invoice: Invoice;
  refresh: () => void;
  notify: (s: string) => void;
  publicPage?: boolean;
  readOnly?: boolean;
  publicDemo?: boolean;
}) {
  const { t, money, number, date } = useLocale();

  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState(invoice.selectedRoute || "direct");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  function closeConfirmation() {
    document.querySelector("dialog")?.close();
    setConfirm(false);
    document
      .getElementById("settlement-action")
      ?.focus({ preventScroll: true });
  }
  const dialogRef = (node: HTMLDialogElement | null) => {
    if (node && !node.open) node.showModal();
  };
  const q = invoice.quote!;
  const selected = q.routes.find((r) => r.id === route)!;
  const active =
    invoice.status === "Settled"
      ? 4
      : invoice.status === "Routing"
        ? 3
        : invoice.status === "Funded"
          ? 2
          : invoice.status === "Pending payment"
            ? 1
            : 0;
  async function transition(status: Status) {
    if (readOnly) {
      setError("This demo workspace is read-only.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await service.transition(invoice.id, status, route);
      await refresh();
      notify(
        status === "Funded"
          ? "Demo Pix payment confirmed."
          : status === "Routing"
            ? "Sample route selected. Ready for simulated settlement."
            : status === "Settled"
              ? "Simulated settlement complete. Receipt generated."
              : "Payment request ready.",
      );
    } catch (e) {
      setError(
        e instanceof Error && isMessageKey(e.message)
          ? e.message
          : "Could not save demo state. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/pay/${invoice.id}`,
      );
      notify("Demo payment link copied.");
    } catch {
      notify("Copy unavailable. Open the payment page and copy its URL.");
    }
  }
  function download() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            notice: t("SIMULATED SETTLEMENT — NO REAL FUNDS MOVED"),
            ...invoice.receipt,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ponte-demo-${invoice.reference}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Simulated receipt exported.");
  }
  return (
    <>
      <Link className="back-link" href={publicPage ? "/" : "/app/invoices"}>
        <ArrowLeft size={15} />
        {publicPage ? t("PONTE home") : t("All invoices")}
      </Link>
      <div className="page-title">
        <div>
          <span className="section-label">
            {publicPage ? t("Demo payment request") : invoice.reference}
          </span>
          <h1>{invoice.supplier}</h1>
          <p>
            {publicDemo
              ? t("Synthetic sample invoice")
              : publicPage
                ? t("Requested by Aurora Comércio Ltda.")
                : t("International supplier payment")}{" "}
            {t("· Created")} {date(invoice.created)}
          </p>
        </div>
        <div className="detail-statuses">
          {readOnly && (
            <span className="subtle">{t("Read-only demo access")}</span>
          )}
          <Badge status={invoice.status} />
        </div>
      </div>
      <div className="journey">
        {[
          t("Invoice created"),
          t("Payment requested"),
          t("Pix confirmed"),
          t("Route selected"),
          t("Receipt generated"),
        ].map((s, i) => (
          <div className={i <= active ? "done" : ""} key={s}>
            <span>{i < active ? <Check size={13} /> : i + 1}</span>
            <small>{s}</small>
          </div>
        ))}
      </div>
      <div className="detail-grid">
        <div>
          {publicDemo && <SyntheticDemoNotice />}
          <section className="payment-summary panel">
            <div className="row">
              <h2>{t("Payment details")}</h2>
              <span className="subtle">{t("Demo invoice")}</span>
            </div>
            <div className="payment-amount">
              {money(invoice.amount)}
              <span>{t("BRL funding → USDG settlement")}</span>
            </div>
            <dl>
              <div>
                <dt>{t("Invoice reference")}</dt>
                <dd>{invoice.reference}</dd>
              </div>
              <div>
                <dt>{t("Supplier")}</dt>
                <dd>{invoice.supplier}</dd>
              </div>
              <div>
                <dt>{t("Due date")}</dt>
                <dd>{date(invoice.due)}</dd>
              </div>
              <div>
                <dt>{t("Recipient · Arbitrum format")}</dt>
                <dd className="mono wallet">{invoice.wallet}</dd>
              </div>
              {invoice.description && (
                <div>
                  <dt>{t("Description")}</dt>
                  <dd>
                    {invoice.id.startsWith("demo-")
                      ? t(invoice.description)
                      : invoice.description}
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <InvoiceEvidencePanel
            key={`${invoice.id}-${invoice.status}`}
            invoiceId={invoice.id}
            refreshKey={invoice.status}
          />
          <AnimatePresence mode="wait">
            <motion.section
              key={invoice.status}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="panel execution"
            >
              <div className="row">
                <h2>
                  {invoice.status === "Failed"
                    ? t("Invoice failed")
                    : invoice.status === "Settled"
                      ? t("Settlement receipt")
                      : invoice.status === "Routing"
                        ? t("Ready for settlement")
                        : invoice.status === "Funded"
                          ? t("Compare illustrative routes")
                          : t("Pix demo payment")}
                </h2>
                {invoice.status === "Settled" ? (
                  <CheckCircle2 size={22} />
                ) : (
                  <GitBranch size={20} />
                )}
              </div>
              {invoice.status === "Failed" ? (
                <>
                  <p>
                    {t(
                      "This failed invoice cannot be retried. Its record and activity history are preserved.",
                    )}
                  </p>
                  <Link className="button full-button" href="/app/invoices/new">
                    {t("Create replacement invoice")} <ArrowRight size={16} />
                  </Link>
                </>
              ) : ["Pending payment", "Draft"].includes(invoice.status) ? (
                <>
                  <p>
                    {invoice.status === "Draft"
                      ? t("Create a payment request to continue.")
                      : t(
                          "A familiar local payment. A transparent global journey.",
                        )}
                  </p>
                  <div className="pix-sandbox">
                    <div className="pix-demo-symbol">
                      ◇<small>DEMO</small>
                    </div>
                    <div>
                      <strong>{t("Pix sandbox")}</strong>
                      <p>
                        {" "}
                        {t("No bank QR code is generated.")} <br />{" "}
                        {t("No real payment will be requested.")}{" "}
                      </p>
                    </div>
                  </div>
                  {invoice.status === "Pending payment" ? (
                    <button
                      disabled={busy || readOnly}
                      className="button full-button"
                      onClick={() => transition("Funded")}
                    >
                      {busy
                        ? t("Confirming demo payment…")
                        : t("Simulate Pix payment received")}
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={busy || readOnly}
                      onClick={() => transition("Pending payment")}
                    >
                      {busy
                        ? t("Preparing…")
                        : t("Create demo payment request")}
                    </button>
                  )}
                </>
              ) : ["Funded", "Routing"].includes(invoice.status) ? (
                <>
                  <p>
                    {invoice.status === "Funded"
                      ? t(
                          "Pix confirmation simulated. Compare deterministic quote fixtures below.",
                        )
                      : t(
                          "Route locked for this demo. Review the output before simulating settlement.",
                        )}
                  </p>
                  <div className="quote-meta">
                    <span>
                      {t("Sample FX: 1 USDG = {rate}", {
                        rate: money(
                          Number(q.rate.numerator) / Number(q.rate.denominator),
                        ),
                      })}
                    </span>
                    <span>{t("No live market data")}</span>
                  </div>
                  <div
                    className="route-options"
                    role="radiogroup"
                    aria-label={t("Liquidity routes")}
                  >
                    {q.routes.map((r) => (
                      <button
                        role="radio"
                        tabIndex={route === r.id ? 0 : -1}
                        onKeyDown={(e) => {
                          if (
                            [
                              "ArrowDown",
                              "ArrowRight",
                              "ArrowUp",
                              "ArrowLeft",
                            ].includes(e.key) &&
                            invoice.status === "Funded"
                          ) {
                            e.preventDefault();
                            const next =
                              (q.routes.findIndex((x) => x.id === route) +
                                (["ArrowDown", "ArrowRight"].includes(e.key)
                                  ? 1
                                  : 2)) %
                              3;
                            setRoute(q.routes[next].id);
                            const group = e.currentTarget.parentElement;
                            (
                              group?.children[next] as HTMLButtonElement
                            )?.focus();
                          }
                        }}
                        aria-checked={route === r.id}
                        disabled={
                          invoice.status === "Routing" || busy || readOnly
                        }
                        className={`route-option ${route === r.id ? "chosen" : ""}`}
                        key={r.id}
                        onClick={() => setRoute(r.id)}
                      >
                        <span className="radio-circle">
                          {route === r.id && <span />}
                        </span>
                        <span>
                          <strong>{t(r.name)}</strong>
                          <small>
                            {t("{fee}% fee · {slippage}% slippage", {
                              fee: number(r.feeBps / 100),
                              slippage: number(r.slippageBps / 100),
                            })}{" "}
                          </small>
                        </span>
                        <span className="mono">
                          {number(minorToDisplayNumber(r.outputMinor))}
                          <small>USDG</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <dl className="execution-stats">
                    <div>
                      <dt>{t("Minimum acceptable output")}</dt>
                      <dd className="mono">
                        {number(
                          minorToDisplayNumber(selected.minimumOutputMinor),
                        )}{" "}
                        USDG
                      </dd>
                    </div>
                    <div>
                      <dt>{t("Sample execution cost")}</dt>
                      <dd className="mono">
                        {t("{amount} (illustrative)", {
                          amount: money(
                            minorToDisplayNumber(q.executionCostMinor),
                            "USD",
                          ),
                        })}
                      </dd>
                    </div>
                  </dl>
                  <button
                    id="settlement-action"
                    className="button full-button"
                    disabled={busy || readOnly}
                    onClick={() =>
                      invoice.status === "Funded"
                        ? transition("Routing")
                        : setConfirm(true)
                    }
                  >
                    {busy
                      ? t("Updating demo payment…")
                      : invoice.status === "Funded"
                        ? t("Select route & continue")
                        : t("Simulate settlement")}
                    <ArrowRight size={16} />
                  </button>
                </>
              ) : invoice.receipt ? (
                <div className="receipt">
                  <div className="success-symbol">
                    <Check size={26} />
                  </div>
                  <p>{t("Simulated settlement complete")}</p>
                  <strong className="big-number">
                    {number(minorToDisplayNumber(invoice.receipt.amountMinor))}
                    <small> USDG</small>
                  </strong>
                  <p>{t("No blockchain transaction occurred.")}</p>
                  <dl>
                    {[
                      [t("Invoice ID"), invoice.id],
                      [t("Sender"), invoice.receipt.sender],
                      [t("Recipient"), invoice.receipt.recipient],
                      [
                        t("Original amount"),
                        money(
                          minorToDisplayNumber(
                            invoice.receipt.originalAmountMinor,
                          ),
                        ),
                      ],
                      [t("Settlement asset"), "USDG"],
                      [t("Selected route"), t(invoice.receipt.route)],
                      [
                        t("Execution cost"),
                        t("{amount} · illustrative", {
                          amount: money(
                            minorToDisplayNumber(
                              invoice.receipt.execution.costMinor,
                            ),
                            "USD",
                          ),
                        }),
                      ],
                      [
                        t("Demo transaction ID"),
                        invoice.receipt.execution.identifier,
                      ],
                      [t("Timestamp"), date(invoice.receipt.timestamp, true)],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd
                          className={
                            k.includes("ID") || k === t("Recipient")
                              ? "mono wallet"
                              : ""
                          }
                        >
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <button
                    className="button secondary full-button"
                    onClick={download}
                  >
                    <Download size={16} /> {t("Export demo receipt")}{" "}
                  </button>
                </div>
              ) : null}
            </motion.section>
          </AnimatePresence>
          {error && (
            <div role="alert" className="notice error">
              {t(error)}
              <button onClick={() => setError("")}>{t("Dismiss")}</button>
            </div>
          )}
        </div>
        <aside>
          <section className="panel">
            <h2>{t("Workspace-restricted payment link")}</h2>
            <p>
              {t(
                "This link is restricted to this workspace and is for internal demonstrations only.",
              )}
            </p>
            <p>
              {t(
                "Sign in with an account that already has access to this workspace to view this invoice.",
              )}
            </p>
            <p>{t("External supplier access is not implemented yet.")}</p>
            <div className="link-box">
              <span>/pay/{invoice.id.slice(0, 16)}</span>
              <button
                className="icon-button"
                aria-label={t("Copy demo payment link")}
                onClick={copy}
              >
                <Copy size={16} />
              </button>
            </div>
            <Link className="text-link" href={`/pay/${invoice.id}`}>
              {" "}
              {t("Open demo payment page")} <ArrowUpRight size={15} />
            </Link>
          </section>
          <section className="notice">
            <ShieldCheck size={22} />
            <div>
              <strong>{t("A safe space to explore.")}</strong>
              <p>
                {" "}
                {t(
                  "All payment confirmations, illustrative routes and settlements are simulated. Never transfer real funds to this prototype.",
                )}{" "}
              </p>
            </div>
          </section>
          <div className="help-note">
            <CircleHelp size={17} />
            <p>
              {" "}
              {t("Want to understand the foundations?")} <br />
              <Link href="/developers">{t("See the integration roadmap")}</Link>
            </p>
          </div>
        </aside>
      </div>
      {confirm && (
        <dialog
          ref={dialogRef}
          aria-labelledby="confirmation-title"
          onCancel={(e) => {
            e.preventDefault();
            closeConfirmation();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeConfirmation();
          }}
        >
          <h2 id="confirmation-title">{t("Simulate this settlement?")}</h2>
          <p>
            {t(
              "{amount} USDG will be recorded as a demo settlement to {supplier}. No funds move and no wallet signature is requested.",
              {
                amount: number(minorToDisplayNumber(selected.outputMinor)),
                supplier: invoice.supplier,
              },
            )}{" "}
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              autoFocus
              onClick={closeConfirmation}
            >
              {" "}
              {t("Cancel")}{" "}
            </button>
            <button
              className="button"
              disabled={readOnly}
              onClick={() => {
                closeConfirmation();
                transition("Settled");
              }}
            >
              {" "}
              {t("Confirm simulation")}{" "}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
