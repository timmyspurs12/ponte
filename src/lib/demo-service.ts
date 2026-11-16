import { demoQuote, majorToMinor } from "./quotes";
import { Invoice, InvoiceInput, InvoiceService, Status } from "./models";
const key = "ponte-demo-v1";
const names = [
  "Meridian Supply Co.",
  "Atlas Components",
  "Norte Studio",
  "Pacific Trading",
  "Forma Industrial",
  "Cedar Logistics",
  "Lume Design",
  "Orion Materials",
];
const statuses: Status[] = [
  "Pending payment",
  "Settled",
  "Routing",
  "Funded",
  "Draft",
  "Settled",
  "Failed",
  "Pending payment",
];
const fixture: Invoice[] = names.map((supplier, i) => ({
  id: `demo-${i + 1}`,
  reference: `PNT-2026-${String(1048 - i)}`,
  supplier,
  wallet: `0x${String(i + 1).repeat(40)}`,
  amount: [25000, 48200, 12800, 36500, 8750, 19200, 6300, 15400][i],
  fundingCurrency: "BRL",
  settlementCurrency: "USDG",
  due: `2026-11-${20 + i}`,
  created: `2026-11-${16 - Math.floor(i / 2)}`,
  description: "International supplier invoice • illustrative demo record",
  status: statuses[i],
}));
function receipt(invoice: Invoice, routeId = "direct") {
  const r = demoQuote(invoice.amount).routes.find((r) => r.id === routeId)!;
  return {
    invoiceId: invoice.id,
    sender: "Aurora Comércio Ltda.",
    recipient: invoice.wallet,
    originalAmountMinor: majorToMinor(invoice.amount),
    asset: "USDG" as const,
    amountMinor: r.outputMinor,
    route: r.name,
    execution: {
      routeId: r.id,
      costMinor: "2",
      identifier: `DEMO-${invoice.id}-SETTLED`,
      simulated: true as const,
    },
    timestamp: new Date().toISOString(),
  };
}
export const demoInvoiceService: InvoiceService = {
  async list() {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          Array.isArray(parsed) &&
          parsed.every(
            (i) =>
              i.id && Number.isFinite(i.amount) && statuses.includes(i.status),
          )
        )
          return parsed.map((invoice: Invoice) =>
            invoice.receipt
              ? {
                  ...invoice,
                  receipt: {
                    ...receipt(invoice, invoice.receipt.execution.routeId),
                    timestamp: invoice.receipt.timestamp,
                  },
                }
              : invoice,
          );
      }
    } catch {
      /* Corrupt storage falls back to safe fixtures. */
    }
    return fixture.map((i) =>
      i.status === "Settled"
        ? {
            ...i,
            receipt: { ...receipt(i), timestamp: "2026-11-16T09:30:00.000Z" },
          }
        : i,
    );
  },
  async create(input: InvoiceInput) {
    const items = await this.list();
    const invoice: Invoice = {
      ...input,
      id: crypto.randomUUID(),
      created: new Date().toISOString().slice(0, 10),
      fundingCurrency: "BRL",
      settlementCurrency: "USDG",
      status: "Pending payment",
    };
    localStorage.setItem(key, JSON.stringify([invoice, ...items]));
    return invoice;
  },
  async transition(id, status, route) {
    const items = await this.list();
    const i = items.find((i) => i.id === id);
    if (!i) throw new Error("Invoice not found.");
    const allowed: Record<Status, Status[]> = {
      Draft: ["Pending payment"],
      "Pending payment": ["Funded"],
      Funded: ["Routing"],
      Routing: ["Settled"],
      Settled: [],
      Failed: ["Pending payment"],
    };
    if (!allowed[i.status].includes(status))
      throw new Error("This payment state has changed. Refresh and try again.");
    const candidateId = route || i.selectedRoute || "direct";
    if (!demoQuote(i.amount).routes.some((r) => r.id === candidateId))
      throw new Error("Invalid demo route.");
    if (i.status === "Routing" && candidateId !== (i.selectedRoute || "direct"))
      throw new Error(
        "The selected route is locked. Start a new demo invoice to choose another route.",
      );
    i.status = status;
    if (status === "Routing") i.selectedRoute = candidateId;
    if (status === "Funded")
      i.payment = {
        invoiceId: id,
        currency: "BRL",
        amount: i.amount,
        simulated: true,
        receivedAt: new Date().toISOString(),
      };
    if (status === "Settled") i.receipt = receipt(i, i.selectedRoute);
    localStorage.setItem(key, JSON.stringify(items));
    return i;
  },
};
