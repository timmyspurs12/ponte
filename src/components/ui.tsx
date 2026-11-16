"use client";
import { useLocale } from "@/lib/i18n/provider";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Status } from "@/lib/models";
export function Mark() {
  return (
    <svg
      width="32"
      height="30"
      viewBox="0 0 32 30"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 25V14a9 9 0 0 1 18 0v11M11 25V14a9 9 0 0 1 18 0v11"
        stroke="currentColor"
        strokeWidth="3.2"
      />
      <path d="M1 25h30" stroke="currentColor" strokeWidth="3.2" />
    </svg>
  );
}
export function Logo() {
  const { t } = useLocale();

  return (
    <Link className="logo" href="/" aria-label={t("PONTE home")}>
      <Mark />
      PONTE<span className="logo-dot">.</span>
    </Link>
  );
}
export const statuses: Status[] = [
  "Draft",
  "Pending payment",
  "Funded",
  "Routing",
  "Settled",
  "Failed",
];
export function Badge({ status }: { status: Status }) {
  const { t } = useLocale();
  return (
    <span className={`badge ${status.toLowerCase().replace(" ", "-")}`}>
      <span />
      {t(status)}
    </span>
  );
}
export function Cta({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: React.ReactNode;
  secondary?: boolean;
}) {
  return (
    <Link className={`button ${secondary ? "secondary" : ""}`} href={href}>
      {children}
      <ArrowUpRight size={16} />
    </Link>
  );
}
