"use client";
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
import { money, quote } from "@/lib/demo-service";
import { invoiceService as service } from "@/lib/services";
import { Badge } from "./ui";
export function InvoiceDetail({
  invoice,
  refresh,
  notify,
  publicPage = false,
}: {
  invoice: Invoice;
  refresh: () => void;
  notify: (s: string) => void;
  publicPage?: boolean;
}) {
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
  const q = quote(invoice.amount);
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
    setBusy(true);
    setError("");
    await new Promise((r) => setTimeout(r, 650));
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
        e instanceof Error
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
            notice: "SIMULATED SETTLEMENT — NO REAL FUNDS MOVED",
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
        {publicPage ? "PONTE home" : "All invoices"}
      </Link>
      <div className="page-title">
        <div>
          <span className="section-label">
            {publicPage ? "Demo payment request" : invoice.reference}
          </span>
          <h1>{invoice.supplier}</h1>
          <p>
            {publicPage
              ? "Requested by Aurora Comércio Ltda."
              : "International supplier payment"}{" "}
            · Created {invoice.created}
          </p>
        </div>
        <Badge status={invoice.status} />
      </div>
      <div className="journey">
        {[
          "Invoice created",
          "Payment requested",
          "Pix confirmed",
          "Route selected",
          "Receipt generated",
        ].map((s, i) => (
          <div className={i <= active ? "done" : ""} key={s}>
            <span>{i < active ? <Check size={13} /> : i + 1}</span>
            <small>{s}</small>
          </div>
        ))}
      </div>
      <div className="detail-grid">
        <div>
          <section className="payment-summary panel">
            <div className="row">
              <h2>Payment details</h2>
              <span className="subtle">Demo invoice</span>
            </div>
            <div className="payment-amount">
              {money(invoice.amount)}
              <span>BRL funding → USDG settlement</span>
            </div>
            <dl>
              <div>
                <dt>Invoice reference</dt>
                <dd>{invoice.reference}</dd>
              </div>
              <div>
                <dt>Supplier</dt>
                <dd>{invoice.supplier}</dd>
              </div>
              <div>
                <dt>Due date</dt>
                <dd>{invoice.due}</dd>
              </div>
              <div>
                <dt>Recipient · Arbitrum format</dt>
                <dd className="mono wallet">{invoice.wallet}</dd>
              </div>
              {invoice.description && (
                <div>
                  <dt>Description</dt>
                  <dd>{invoice.description}</dd>
                </div>
              )}
            </dl>
          </section>
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
                  {invoice.status === "Settled"
                    ? "Settlement receipt"
                    : invoice.status === "Routing"
                      ? "Ready for settlement"
                      : invoice.status === "Funded"
                        ? "Compare liquidity routes"
                        : "Pix demo payment"}
                </h2>
                {invoice.status === "Settled" ? (
                  <CheckCircle2 size={22} />
                ) : (
                  <GitBranch size={20} />
                )}
              </div>
              {["Pending payment", "Draft", "Failed"].includes(
                invoice.status,
              ) ? (
                <>
                  <p>
                    {invoice.status === "Draft"
                      ? "Create a payment request to continue."
                      : invoice.status === "Failed"
                        ? "The sample payment failed. Retry the demo request; no funds were moved."
                        : "A familiar local payment. A transparent global journey."}
                  </p>
                  <div className="pix-sandbox">
                    <div className="pix-demo-symbol">
                      ◇<small>DEMO</small>
                    </div>
                    <div>
                      <strong>Pix sandbox</strong>
                      <p>
                        No bank QR code is generated.
                        <br />
                        No real payment will be requested.
                      </p>
                    </div>
                  </div>
                  {invoice.status === "Pending payment" ? (
                    <button
                      disabled={busy}
                      className="button full-button"
                      onClick={() => transition("Funded")}
                    >
                      {busy
                        ? "Confirming demo payment…"
                        : "Simulate Pix payment received"}
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => transition("Pending payment")}
                    >
                      {busy
                        ? "Preparing…"
                        : invoice.status === "Failed"
                          ? "Retry demo payment request"
                          : "Create demo payment request"}
                    </button>
                  )}
                </>
              ) : ["Funded", "Routing"].includes(invoice.status) ? (
                <>
                  <p>
                    {invoice.status === "Funded"
                      ? "Pix confirmation simulated. Compare deterministic quote fixtures below."
                      : "Route locked for this demo. Review the output before simulating settlement."}
                  </p>
                  <div className="quote-meta">
                    <span>Sample FX: 1 USDG = R$5.25</span>
                    <span>No live market data</span>
                  </div>
                  <div
                    className="route-options"
                    role="radiogroup"
                    aria-label="Liquidity routes"
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
                        disabled={invoice.status === "Routing" || busy}
                        className={`route-option ${route === r.id ? "chosen" : ""}`}
                        key={r.id}
                        onClick={() => setRoute(r.id)}
                      >
                        <span className="radio-circle">
                          {route === r.id && <span />}
                        </span>
                        <span>
                          <strong>{r.name}</strong>
                          <small>
                            {(r.fee * 100).toFixed(2)}% fee · {r.slippage}%
                            slippage
                          </small>
                        </span>
                        <span className="mono">
                          {r.output.toFixed(2)}
                          <small>USDG</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <dl className="execution-stats">
                    <div>
                      <dt>Minimum acceptable output</dt>
                      <dd className="mono">
                        {(selected.output * 0.995).toFixed(2)} USDG
                      </dd>
                    </div>
                    <div>
                      <dt>Sample execution cost</dt>
                      <dd className="mono">$0.02 (illustrative)</dd>
                    </div>
                  </dl>
                  <button
                    id="settlement-action"
                    className="button full-button"
                    disabled={busy}
                    onClick={() =>
                      invoice.status === "Funded"
                        ? transition("Routing")
                        : setConfirm(true)
                    }
                  >
                    {busy
                      ? "Updating demo payment…"
                      : invoice.status === "Funded"
                        ? "Select route & continue"
                        : "Simulate settlement"}
                    <ArrowRight size={16} />
                  </button>
                </>
              ) : invoice.receipt ? (
                <div className="receipt">
                  <div className="success-symbol">
                    <Check size={26} />
                  </div>
                  <p>Simulated settlement complete</p>
                  <strong className="big-number">
                    {invoice.receipt.amount.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                    })}
                    <small> USDG</small>
                  </strong>
                  <p>No blockchain transaction occurred.</p>
                  <dl>
                    {[
                      ["Invoice ID", invoice.id],
                      ["Sender", invoice.receipt.sender],
                      ["Recipient", invoice.receipt.recipient],
                      [
                        "Original amount",
                        money(invoice.receipt.originalAmount),
                      ],
                      ["Settlement asset", "USDG"],
                      ["Selected route", invoice.receipt.route],
                      ["Execution cost", "$0.02 · illustrative"],
                      [
                        "Demo transaction ID",
                        invoice.receipt.execution.identifier,
                      ],
                      [
                        "Timestamp",
                        new Date(invoice.receipt.timestamp).toLocaleString(
                          "en-GB",
                          { timeZone: "UTC" },
                        ) + " UTC",
                      ],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd
                          className={
                            k.includes("ID") || k === "Recipient"
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
                    <Download size={16} /> Export demo receipt
                  </button>
                </div>
              ) : null}
            </motion.section>
          </AnimatePresence>
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
        </div>
        <aside>
          <section className="panel">
            <h2>Payment link</h2>
            <p>
              Open the public-facing demo checkout. Only available in this
              browser’s local demo store.
            </p>
            <div className="link-box">
              <span>/pay/{invoice.id.slice(0, 16)}</span>
              <button
                className="icon-button"
                aria-label="Copy demo payment link"
                onClick={copy}
              >
                <Copy size={16} />
              </button>
            </div>
            <Link className="text-link" href={`/pay/${invoice.id}`}>
              Open demo payment page <ArrowUpRight size={15} />
            </Link>
          </section>
          <section className="notice">
            <ShieldCheck size={22} />
            <div>
              <strong>A safe space to explore.</strong>
              <p>
                All payment confirmations, liquidity routes and settlements are
                simulated. Never transfer real funds to this prototype.
              </p>
            </div>
          </section>
          <div className="help-note">
            <CircleHelp size={17} />
            <p>
              Want to understand the foundations?
              <br />
              <Link href="/developers">See the integration roadmap</Link>
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
          <h2 id="confirmation-title">Simulate this settlement?</h2>
          <p>
            {selected.output.toFixed(2)} USDG will be recorded as a demo
            settlement to {invoice.supplier}. No funds move and no wallet
            signature is requested.
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              autoFocus
              onClick={closeConfirmation}
            >
              Cancel
            </button>
            <button
              className="button"
              onClick={() => {
                closeConfirmation();
                transition("Settled");
              }}
            >
              Confirm simulation
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
