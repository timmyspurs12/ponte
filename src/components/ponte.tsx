"use client";
import { LanguageSelector, useLocale } from "@/lib/i18n/provider";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  ArrowUpRight,
  Plus,
  X,
  CheckCircle2,
  FileText,
  Building2,
} from "lucide-react";
import {
  Invoice,
  BusinessActivityEvent,
  WorkspaceAuthentication,
} from "@/lib/models";
import {
  ApiRequestError,
  invoiceService as service,
  workspaceAuthentication,
} from "@/lib/services";
import { Logo, Cta } from "./ui";
import { Marketing } from "./marketing";
import { Developers } from "./developers";
import { InvoiceTable } from "./invoice-table";
import { Overview } from "./overview";
import { CreateInvoice } from "./create-invoice";
import { InvoiceDetail } from "./invoice-detail";
export default function Ponte() {
  const { t } = useLocale();

  const pathname = usePathname();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [activity, setActivity] = useState<BusinessActivityEvent[]>([]);
  const [authentication, setAuthentication] =
    useState<WorkspaceAuthentication | null>(null);
  const [loadError, setLoadError] = useState<
    "unavailable" | "unauthenticated" | "error" | null
  >(null);
  const [toast, setToast] = useState("");
  async function refresh() {
    try {
      const authContext = await workspaceAuthentication();
      setAuthentication(authContext);
      if (!authContext.access) {
        setInvoices(null);
        setActivity([]);
        setLoadError(null);
        return;
      }
      const [records, events] = await Promise.all([
        service.list(),
        service.activity(),
      ]);
      setInvoices(records);
      setActivity(events);
      setLoadError(null);
    } catch (error) {
      setAuthentication(null);
      setLoadError(
        error instanceof ApiRequestError && error.status === 401
          ? "unauthenticated"
          : error instanceof ApiRequestError && error.status === 503
            ? "unavailable"
            : "error",
      );
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      if (
        location.pathname.startsWith("/app") ||
        location.pathname.startsWith("/pay/")
      )
        void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const isMarketing = pathname === "/";
  const signInPage = pathname === "/sign-in";
  const localDevelopment = process.env.NODE_ENV !== "production";
  const developer = pathname === "/developers";
  const publicPage = pathname.startsWith("/pay/");
  const access = authentication?.access ?? null;
  const readOnly = access?.readOnly ?? false;
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
      ) : signInPage ? (
        <main id="main" className="auth-page wrap">
          <section className="auth-card" aria-labelledby="sign-in-title">
            <Logo />
            <span className="section-label">
              {t("Secure workspace access")}
            </span>
            <h1 id="sign-in-title">{t("Sign in to PONTE")}</h1>
            <p>
              {t(
                "Use GitHub to authenticate. Access is granted only by an active PONTE membership.",
              )}
            </p>
            <button
              className="button full-button"
              onClick={() => void signIn("github", { callbackUrl: "/app" })}
            >
              {t("Continue with GitHub")}
            </button>
            <small>
              {t(
                "GitHub authentication does not grant workspace access by itself.",
              )}
            </small>
            {localDevelopment && (
              <Link className="text-link" href="/dev-login">
                {t("Local sign in")}
              </Link>
            )}
          </section>
        </main>
      ) : developer ? (
        <Developers />
      ) : valid ? (
        <>
          <header className="app-header">
            <div className="wrap">
              <Logo />
              {!publicPage && (
                <nav aria-label={t("Workspace navigation")}>
                  <Link
                    className={pathname === "/app" ? "active" : ""}
                    href="/app"
                  >
                    {" "}
                    {t("Overview")}{" "}
                  </Link>
                  <Link
                    className={pathname.includes("/invoices") ? "active" : ""}
                    href="/app/invoices"
                  >
                    {" "}
                    {t("Invoices")}{" "}
                  </Link>
                  <Link href="/developers">
                    {" "}
                    {t("Developers")} <ArrowUpRight size={12} />
                  </Link>
                </nav>
              )}
              <LanguageSelector />
              {authentication?.authenticated && (
                <div className="workspace">
                  <span className="workspace-icon">
                    <Building2 size={17} />
                  </span>
                  <span>
                    {authentication.accountLabel}
                    <small>
                      {access?.publicDemo
                        ? t("Read-only demo access")
                        : access
                          ? t("Authenticated workspace")
                          : t("Access denied")}
                    </small>
                  </span>
                  {authentication.access &&
                    authentication.accountLabel.startsWith("GitHub") && (
                      <button
                        className="workspace-sign-out"
                        onClick={() => void signOut({ callbackUrl: "/" })}
                      >
                        {t("Sign out")}
                      </button>
                    )}
                </div>
              )}
            </div>
          </header>
          <div className="demo-banner">
            <span className="live-dot" />
            <strong>
              {t(
                access?.publicDemo
                  ? "Synthetic public demo"
                  : readOnly
                    ? "Read-only demo"
                    : "Demo mode",
              )}
            </strong>
            <span>
              {" "}
              {t(
                access?.publicDemo
                  ? "Sample invoices only. No Pix payment, wallet, KMS or blockchain transaction is connected, and viewers cannot change anything."
                  : readOnly
                    ? "You can view this synthetic demo workspace but cannot change invoices or Routing."
                    : "Explore freely. No real funds, wallets or payment services are connected.",
              )}{" "}
            </span>
          </div>
          <main className="app-main wrap" id="main">
            {loadError === "unauthenticated" ? (
              <section className="empty" role="alert">
                <h1>{t("Sign in required")}</h1>
                <p>{t("Sign in with GitHub to request workspace access.")}</p>
                <Link className="button" href="/sign-in">
                  {t("Sign in")}
                </Link>
              </section>
            ) : loadError === "unavailable" ? (
              <section className="empty" role="alert">
                <h1>{t("Sign-in is unavailable")}</h1>
                <p>
                  {t(
                    "Workspace authentication is not configured. Please try again later.",
                  )}
                </p>
              </section>
            ) : authentication && !access ? (
              <section className="empty" role="alert">
                <h1>{t("Workspace access denied")}</h1>
                <p>
                  {t(
                    "Your GitHub account is signed in, but it does not have an active membership for this workspace.",
                  )}
                </p>
                <button onClick={() => void signOut({ callbackUrl: "/" })}>
                  {t("Sign out")}
                </button>
              </section>
            ) : loadError === "error" ? (
              <section className="empty" role="alert">
                <p>{t("Could not load the workspace. Please try again.")}</p>
                <button onClick={() => void refresh()}>{t("Try again")}</button>
              </section>
            ) : !invoices ? (
              <div className="loading" role="status">
                <div className="skeleton" />
                <p>{t("Loading demo workspace…")}</p>
              </div>
            ) : detail ? (
              invoice ? (
                <InvoiceDetail
                  key={invoice.id}
                  invoice={invoice}
                  refresh={refresh}
                  notify={setToast}
                  publicPage={publicPage}
                  readOnly={readOnly}
                  publicDemo={access?.publicDemo ?? false}
                />
              ) : (
                <div className="empty">
                  <FileText />
                  <h1>{t("Invoice not found")}</h1>
                  <p>
                    {" "}
                    {t(
                      "This demo link may belong to another browser. Demo records are stored locally.",
                    )}{" "}
                  </p>
                  <Cta href="/app/invoices">{t("Back to invoices")}</Cta>
                </div>
              )
            ) : pathname === "/app/invoices/new" ? (
              readOnly ? (
                <section className="empty" role="status">
                  <h1>{t("Read-only demo access")}</h1>
                  <p>
                    {t(
                      "This synthetic demo workspace does not allow invoice changes.",
                    )}
                  </p>
                  <Link className="button" href="/app/invoices">
                    {t("Back to invoices")}
                  </Link>
                </section>
              ) : (
                <CreateInvoice refresh={refresh} notify={setToast} />
              )
            ) : pathname === "/app/invoices" ? (
              <>
                <div className="page-title">
                  <div>
                    <span className="section-label">
                      {" "}
                      {t("Payments, without the paperwork")}{" "}
                    </span>
                    <h1>{t("Invoices")}</h1>
                    <p>{t("Every supplier. Every payment. One clear view.")}</p>
                  </div>
                  {!readOnly && (
                    <Cta href="/app/invoices/new">
                      <Plus size={16} /> {t("Create invoice")}{" "}
                    </Cta>
                  )}
                </div>
                <div className="list-summary">
                  <span>
                    <b>{invoices.length}</b> {t("Total invoices")}{" "}
                  </span>
                  <span>
                    <b>
                      {
                        invoices.filter((i) => i.status === "Pending payment")
                          .length
                      }
                    </b>{" "}
                    {t("Awaiting payment")}{" "}
                  </span>
                  <span>
                    <b>
                      {invoices.filter((i) => i.status === "Settled").length}
                    </b>{" "}
                    {t("Settled")}{" "}
                  </span>
                  <span>
                    {t(
                      access?.publicDemo
                        ? "All figures are synthetic sample data"
                        : "All figures are demo data",
                    )}
                  </span>
                </div>
                <InvoiceTable invoices={invoices} />
              </>
            ) : (
              <Overview
                invoices={invoices}
                activity={activity}
                readOnly={readOnly}
                publicDemo={access?.publicDemo ?? false}
              />
            )}
          </main>
          <footer className="app-footer wrap">
            <span>{t("PONTE · A better way across borders.")}</span>
            <span>
              {t("Frontend prototype · Arbitrum Open House São Paulo")}
            </span>
          </footer>
        </>
      ) : (
        <main id="main" className="empty">
          <h1>{t("Page not found")}</h1>
          <Cta href="/">{t("Return home")}</Cta>
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
            {t(toast)}
            <button
              className="icon-button"
              aria-label={t("Dismiss notification")}
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
