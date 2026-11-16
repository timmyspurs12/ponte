"use client";
import { useLocale } from "@/lib/i18n/provider";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  SlidersHorizontal,
  FileText,
} from "lucide-react";
import { Invoice, Status } from "@/lib/models";

import { Badge, statuses } from "./ui";
export function InvoiceTable({
  invoices,
  compact = false,
}: {
  invoices: Invoice[];
  compact?: boolean;
}) {
  const { t, money, number, date } = useLocale();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(0);
  const rows = invoices
    .filter(
      (i) =>
        (i.supplier + " " + i.reference)
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (status === "All statuses" || i.status === status),
    )
    .sort((a, b) =>
      sort === "amount"
        ? b.amount - a.amount
        : sort === "due"
          ? a.due.localeCompare(b.due)
          : b.created.localeCompare(a.created),
    );
  const visible = compact
    ? rows.slice(0, 5)
    : rows.slice(page * 6, page * 6 + 6);
  return (
    <section className="table-panel">
      {!compact && (
        <div className="table-tools">
          <label className="search">
            <Search size={17} />
            <input
              aria-label={t("Search invoices")}
              placeholder={t("Search supplier or invoice…")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <div className="filters">
            <SlidersHorizontal size={16} />
            <select
              aria-label={t("Filter by status")}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option value="All statuses">{t("All statuses")}</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {t(s)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("Sort invoices")}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="newest">{t("Newest first")}</option>
              <option value="amount">{t("Highest amount")}</option>
              <option value="due">{t("Due date")}</option>
            </select>
          </div>
        </div>
      )}
      <div
        className="table-scroll"
        role="region"
        aria-label={t("Invoices")}
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>{t("Invoice / Supplier")}</th>
              <th className="number">{t("Amount")}</th>
              <th>{t("Corridor")}</th>
              <th>Status</th>
              {!compact && <th>{t("Created")}</th>}
              <th>{t("Due date")}</th>
              <th>
                <span className="sr-only">{t("Open invoice")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr key={i.id}>
                <td>
                  <Link
                    className="supplier-link"
                    href={`/app/invoices/${i.id}`}
                  >
                    <span className="supplier-avatar">
                      {i.supplier.slice(0, 1)}
                    </span>
                    <span>
                      <strong>{i.supplier}</strong>
                      <small>{i.reference}</small>
                    </span>
                  </Link>
                </td>
                <td className="number mono">
                  {money(i.amount)}
                  <small>BRL</small>
                </td>
                <td>
                  <span className="corridor">
                    BRL <ArrowRight size={12} /> USDG
                  </span>
                </td>
                <td>
                  <Badge status={i.status} />
                </td>
                {!compact && <td className="date">{date(i.created)}</td>}
                <td className="date">{date(i.due)}</td>
                <td>
                  <Link
                    className="icon-button"
                    href={`/app/invoices/${i.id}`}
                    aria-label={t("Open {reference}", {
                      reference: i.reference,
                    })}
                  >
                    <ArrowUpRight size={16} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && (
        <div className="empty">
          <FileText />
          <h3>{t("No invoices found")}</h3>
          <p>{t("Try another supplier, reference or status.")}</p>
          <button
            className="button secondary"
            onClick={() => {
              setSearch("");
              setStatus("All statuses");
            }}
          >
            {" "}
            {t("Clear filters")}{" "}
          </button>
        </div>
      )}
      {!compact && (
        <div className="pagination">
          <small>
            {t("{count} demo invoices · Page {page} of {pages}", {
              count: number(rows.length, 0),
              page: number(page + 1, 0),
              pages: number(Math.max(1, Math.ceil(rows.length / 6)), 0),
            })}
          </small>
          <div>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              {" "}
              {t("Previous")}{" "}
            </button>
            <button
              disabled={(page + 1) * 6 >= rows.length}
              onClick={() => setPage(page + 1)}
            >
              {" "}
              {t("Next")}{" "}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
