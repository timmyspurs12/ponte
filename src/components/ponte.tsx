"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  ArrowUpRight,
  Plus,
  X,
  CheckCircle2,
  FileText,
  Building2,
} from "lucide-react";
import { Invoice } from "@/lib/models";
import { invoiceService as service } from "@/lib/services";
import { Logo, Cta } from "./ui";
import { Marketing } from "./marketing";
import { Developers } from "./developers";
import { InvoiceTable } from "./invoice-table";
import { Overview } from "./overview";
import { CreateInvoice } from "./create-invoice";
import { InvoiceDetail } from "./invoice-detail";
export default function Ponte() {
  const pathname = usePathname();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [toast, setToast] = useState("");
  async function refresh() {
    setInvoices(await service.list());
  }
  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const isMarketing = pathname === "/";
  const developer = pathname === "/developers";
  const publicPage = pathname.startsWith("/pay/");
  const id = pathname.split("/").pop();
  const detail =
    publicPage || (pathname.startsWith("/app/invoices/") && id !== "new");
  const invoice = invoices?.find((i) => i.id === id);
  const valid =
    isMarketing ||
    developer ||
    publicPage ||
    pathname === "/app" ||
    pathname === "/app/invoices" ||
    pathname === "/app/invoices/new" ||
    detail;
  return (
    <MotionConfig reducedMotion="user">
      {isMarketing ? (
        <Marketing />
      ) : developer ? (
        <Developers />
      ) : valid ? (
        <>
          <header className="app-header">
            <div className="wrap">
              <Logo />
              {!publicPage && (
                <nav aria-label="Workspace navigation">
                  <Link
                    className={pathname === "/app" ? "active" : ""}
                    href="/app"
                  >
                    Overview
                  </Link>
                  <Link
                    className={pathname.includes("/invoices") ? "active" : ""}
                    href="/app/invoices"
                  >
                    Invoices
                  </Link>
                  <Link href="/developers">
                    Developers <ArrowUpRight size={12} />
                  </Link>
                </nav>
              )}
              <div className="workspace">
                <span className="workspace-icon">
                  <Building2 size={17} />
                </span>
                <span>
                  Aurora Comércio<small>Demo workspace</small>
                </span>
                <span className="avatar">AC</span>
              </div>
            </div>
          </header>
          <div className="demo-banner">
            <span className="live-dot" />
            <strong>Demo mode</strong>
            <span>
              Explore freely. No real funds, wallets or payment services are
              connected.
            </span>
          </div>
          <main className="app-main wrap" id="main">
            {!invoices ? (
              <div className="loading" role="status">
                <div className="skeleton" />
                <p>Loading demo workspace…</p>
              </div>
            ) : detail ? (
              invoice ? (
                <InvoiceDetail
                  key={invoice.id}
                  invoice={invoice}
                  refresh={refresh}
                  notify={setToast}
                  publicPage={publicPage}
                />
              ) : (
                <div className="empty">
                  <FileText />
                  <h1>Invoice not found</h1>
                  <p>
                    This demo link may belong to another browser. Demo records
                    are stored locally.
                  </p>
                  <Cta href="/app/invoices">Back to invoices</Cta>
                </div>
              )
            ) : pathname === "/app/invoices/new" ? (
              <CreateInvoice refresh={refresh} notify={setToast} />
            ) : pathname === "/app/invoices" ? (
              <>
                <div className="page-title">
                  <div>
                    <span className="section-label">
                      Payments, without the paperwork
                    </span>
                    <h1>Invoices</h1>
                    <p>Every supplier. Every payment. One clear view.</p>
                  </div>
                  <Cta href="/app/invoices/new">
                    <Plus size={16} /> Create invoice
                  </Cta>
                </div>
                <div className="list-summary">
                  <span>
                    <b>{invoices.length}</b> Total invoices
                  </span>
                  <span>
                    <b>
                      {
                        invoices.filter((i) => i.status === "Pending payment")
                          .length
                      }
                    </b>{" "}
                    Awaiting payment
                  </span>
                  <span>
                    <b>
                      {invoices.filter((i) => i.status === "Settled").length}
                    </b>{" "}
                    Settled
                  </span>
                  <span>All figures are demo data</span>
                </div>
                <InvoiceTable invoices={invoices} />
              </>
            ) : (
              <Overview invoices={invoices} />
            )}
          </main>
          <footer className="app-footer wrap">
            <span>PONTE · A better way across borders.</span>
            <span>Frontend prototype · Arbitrum Open House São Paulo</span>
          </footer>
        </>
      ) : (
        <main id="main" className="empty">
          <h1>Page not found</h1>
          <Cta href="/">Return home</Cta>
        </main>
      )}
      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
          >
            <CheckCircle2 size={19} />
            {toast}
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
