"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Check, ShieldCheck, ArrowLeft } from "lucide-react";
import { Invoice, InvoiceInput } from "@/lib/models";
import { invoiceService as service } from "@/lib/services";
import { Mark } from "./ui";
export function CreateInvoice({
  refresh,
  notify,
}: {
  refresh: () => void;
  notify: (s: string) => void;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const input: InvoiceInput = {
      supplier: String(data.get("supplier")).trim(),
      wallet: String(data.get("wallet")).trim(),
      reference: String(data.get("reference")).trim(),
      amount: Number(data.get("amount")),
      due: String(data.get("due")),
      description: String(data.get("description")).trim(),
    };
    const err: Record<string, string> = {};
    if (input.supplier.length < 2)
      err.supplier = "Enter a business name of at least 2 characters.";
    if (!/^0x[a-fA-F0-9]{40}$/.test(input.wallet))
      err.wallet = "Enter a 0x address with 40 hexadecimal characters.";
    if (!input.reference) err.reference = "Enter an invoice reference.";
    if (
      (await service.list()).some(
        (i) => i.reference.toLowerCase() === input.reference.toLowerCase(),
      )
    )
      err.reference = "This reference is already in use.";
    if (
      !Number.isFinite(input.amount) ||
      input.amount < 1 ||
      input.amount > 10000000
    )
      err.amount = "Enter an amount between R$1 and R$10,000,000.";
    if (!input.due || input.due < new Date().toISOString().slice(0, 10))
      err.due = "Choose today or a future date.";
    setErrors(err);
    if (Object.keys(err).length) {
      document.getElementById(Object.keys(err)[0])?.focus();
      return;
    }
    setBusy(true);
    await new Promise((r) => setTimeout(r, 450));
    try {
      const i = await service.create(input);
      await refresh();
      notify("Demo invoice created. Your payment link is ready.");
      router.push(`/app/invoices/${i.id}`);
    } catch {
      setErrors({
        form: "Could not save in browser storage. Check storage permissions and try again.",
      });
      setBusy(false);
    }
  }
  const field = (
    name: string,
    label: string,
    type = "text",
    placeholder = "",
    extra = {},
  ) => (
    <label className="field">
      {label}
      <input
        id={name}
        name={name}
        autoComplete="off"
        spellCheck={name !== "wallet"}
        type={type}
        placeholder={placeholder}
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        {...extra}
      />
      {errors[name] && (
        <span className="field-error" id={`${name}-error`}>
          {errors[name]}
        </span>
      )}
    </label>
  );
  return (
    <>
      <Link className="back-link" href="/app/invoices">
        <ArrowLeft size={15} /> All invoices
      </Link>
      <div className="page-title">
        <div>
          <h1>Create an invoice</h1>
          <p>Local funding. A clear path to your international supplier.</p>
        </div>
        <span className="badge draft">Demo invoice</span>
      </div>
      <div className="form-layout">
        <form className="invoice-form" onSubmit={submit} noValidate>
          <section>
            <div className="form-section-title">
              <span>01</span>
              <div>
                <h2>Who are you paying?</h2>
                <p>Supplier details for this demo invoice.</p>
              </div>
            </div>
            {field(
              "supplier",
              "Supplier / business name",
              "text",
              "e.g. Meridian Supply Co.",
              { maxLength: 100 },
            )}
            {field("wallet", "Supplier wallet address", "text", "0x…", {
              maxLength: 42,
            })}
            <small className="helper">
              Arbitrum-format address. No wallet connection or transfer occurs.
            </small>
          </section>
          <section>
            <div className="form-section-title">
              <span>02</span>
              <div>
                <h2>Invoice details</h2>
                <p>Set the funding amount and payment terms.</p>
              </div>
            </div>
            <div className="form-grid">
              {field(
                "reference",
                "Invoice reference",
                "text",
                "e.g. PNT-2026-1049",
                { maxLength: 60 },
              )}
              {field("due", "Due date", "date", "", {
                min: new Date().toISOString().slice(0, 10),
              })}
              {field("amount", "Invoice amount (BRL)", "number", "25,000.00", {
                min: 1,
                max: 10000000,
                step: ".01",
              })}
              <label className="field">
                Funding currency
                <select name="currency">
                  <option>BRL — Brazilian real</option>
                </select>
              </label>
              <label className="field full">
                Settlement asset
                <select name="asset">
                  <option>USDG — Digital dollar</option>
                </select>
              </label>
              <label className="field full">
                Description <small>(optional)</small>
                <textarea
                  name="description"
                  placeholder="What is this payment for?"
                  rows={3}
                  maxLength={500}
                />
              </label>
            </div>
          </section>
          {errors.form && (
            <p role="alert" className="field-error">
              {errors.form}
            </p>
          )}
          <div className="form-actions">
            <Link className="button secondary" href="/app/invoices">
              Cancel
            </Link>
            <button className="button" disabled={busy}>
              {busy ? "Creating invoice…" : "Create demo invoice"}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
        <aside className="form-aside">
          <div className="flow-logo">
            <Mark />
          </div>
          <h2>A clearer connection.</h2>
          <p>Your invoice brings the entire payment journey together.</p>
          <ol>
            <li>Share a demo payment link</li>
            <li>Simulate Pix confirmation</li>
            <li>Compare liquidity routes</li>
            <li>Generate a settlement receipt</li>
          </ol>
          <div className="notice">
            <ShieldCheck size={19} />
            <p>
              This is a frontend demonstration. Never send real funds to a demo
              address.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
