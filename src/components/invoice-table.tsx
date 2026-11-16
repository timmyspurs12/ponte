"use client";
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
import { money } from "@/lib/demo-service";
import { Badge, statuses } from "./ui";
export function InvoiceTable({
  invoices,
  compact = false,
}: {
  invoices: Invoice[];
  compact?: boolean;
}) {
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
              aria-label="Search invoices"
              placeholder="Search supplier or invoice…"
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
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option>All statuses</option>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select
              aria-label="Sort invoices"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="amount">Highest amount</option>
              <option value="due">Due date</option>
            </select>
          </div>
        </div>
      )}
      <div
        className="table-scroll"
        role="region"
        aria-label="Invoices"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Invoice / Supplier</th>
              <th className="number">Amount</th>
              <th>Corridor</th>
              <th>Status</th>
              {!compact && <th>Created</th>}
              <th>Due date</th>
              <th>
                <span className="sr-only">Open invoice</span>
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
                {!compact && <td className="date">{i.created}</td>}
                <td className="date">{i.due}</td>
                <td>
                  <Link
                    className="icon-button"
                    href={`/app/invoices/${i.id}`}
                    aria-label={`Open ${i.reference}`}
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
          <h3>No invoices found</h3>
          <p>Try another supplier, reference or status.</p>
          <button
            className="button secondary"
            onClick={() => {
              setSearch("");
              setStatus("All statuses");
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {!compact && (
        <div className="pagination">
          <small>
            {rows.length} demo invoices · Page {page + 1} of{" "}
            {Math.max(1, Math.ceil(rows.length / 6))}
          </small>
          <div>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button
              disabled={(page + 1) * 6 >= rows.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
