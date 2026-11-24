import { createHash } from "node:crypto";
import type { Invoice, PaymentQuote, Status } from "../lib/models";

/**
 * Deterministic synthetic tenant content for the public, read-only demo.
 *
 * Every value here is deliberately unmistakable as sample data: the tenant
 * name, supplier names, references, wallets and descriptions all say
 * "synthetic", "sample", "example" or "demo". Nothing in this file is real
 * customer data, a real payment, a wallet, a KMS operation, or a blockchain
 * transaction.
 *
 * Invoice, quote, payment and settlement identifiers are UUIDv5 values derived
 * from a fixed namespace and a stable slug (RFC 4122 name-based UUIDs). They
 * contain no account, person or secret input, and repeating the provisioning
 * command therefore addresses the same rows instead of inserting duplicates.
 */

/** Fixed, repository-owned namespace for the synthetic demo identifiers. */
export const PUBLIC_DEMO_NAMESPACE = "8bd1f0f2-4c3a-4f6e-9b57-2f5f1a7c9d01";

function namespaceBytes(namespace: string): Buffer {
  return Buffer.from(namespace.replaceAll("-", ""), "hex");
}

/**
 * RFC 4122 name-based UUID (version 5) using SHA-1. Used only to make the
 * synthetic identifiers stable and reproducible; it is not a security
 * primitive and no secret ever enters it.
 */
export function publicDemoUuid(name: string): string {
  const hash = createHash("sha1")
    .update(namespaceBytes(PUBLIC_DEMO_NAMESPACE))
    .update(name, "utf8")
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Stable slug per example; the persisted identifiers are derived from it. */
export type PublicDemoInvoiceSlug =
  | "created-example"
  | "awaiting-funding-example"
  | "funded-example"
  | "route-decision-example"
  | "settled-example"
  | "failed-example";

export type PublicDemoInvoiceSpec = {
  slug: PublicDemoInvoiceSlug;
  reference: string;
  supplier: string;
  /** Placeholder pattern; not a real wallet and not derived from a real key. */
  wallet: string;
  fundingMinor: string;
  due: string;
  description: string;
  status: Status;
  /** Recorded only where the simulated lifecycle would have chosen a route. */
  selectedRoute?: "direct" | "split" | "multi";
  /** Fixed synthetic creation instant (UTC). */
  createdAt: string;
};

const EXAMPLE_INVOICES: readonly Omit<PublicDemoInvoiceSpec, "createdAt">[] = [
  {
    slug: "created-example",
    reference: "DEMO-SYN-1001",
    supplier: "Synthetic Example Supplier BV",
    wallet: "0x1111111111111111111111111111111111111111",
    fundingMinor: "1250000",
    due: "2027-06-30",
    description:
      "Synthetic sample invoice — newly created example. Not a real payment.",
    status: "Draft",
  },
  {
    slug: "awaiting-funding-example",
    reference: "DEMO-SYN-1002",
    supplier: "Sample Components Ltda (not a real company)",
    wallet: "0x2222222222222222222222222222222222222222",
    fundingMinor: "4820000",
    due: "2027-07-15",
    description:
      "Synthetic sample invoice — awaiting simulated Pix funding. No funds move.",
    status: "Pending payment",
  },
  {
    slug: "funded-example",
    reference: "DEMO-SYN-1003",
    supplier: "Example Industrial Parts (fictional)",
    wallet: "0x3333333333333333333333333333333333333333",
    fundingMinor: "875000",
    due: "2027-08-20",
    description:
      "Synthetic sample invoice — simulated funding confirmed. No real Pix payment occurred.",
    status: "Funded",
  },
  {
    slug: "route-decision-example",
    reference: "DEMO-SYN-1004",
    supplier: "Demonstration Materials GmbH (fictional)",
    wallet: "0x4444444444444444444444444444444444444444",
    fundingMinor: "1920000",
    due: "2027-09-10",
    description:
      "Synthetic sample invoice — simulated route decision recorded. Evidence is not anchored.",
    status: "Routing",
    selectedRoute: "split",
  },
  {
    slug: "settled-example",
    reference: "DEMO-SYN-1005",
    supplier: "Fictional Trading House S.A. (sample)",
    wallet: "0x5555555555555555555555555555555555555555",
    fundingMinor: "630000",
    due: "2027-10-05",
    description:
      "Synthetic sample invoice — simulated settlement completed. No blockchain transaction occurred.",
    status: "Settled",
    selectedRoute: "direct",
  },
  {
    slug: "failed-example",
    reference: "DEMO-SYN-1006",
    supplier: "Sample Logistics Co. (example only)",
    wallet: "0x6666666666666666666666666666666666666666",
    fundingMinor: "1540000",
    due: "2027-11-01",
    description:
      "Synthetic sample invoice — example of a failed demo request. No funds move.",
    status: "Failed",
  },
];

/**
 * Fixed synthetic creation instants, so a repeat run can compare persisted
 * rows without inventing a new clock value. They are intentionally in the
 * past; the runbook states that demo timestamps are illustrative.
 */
const CREATED_AT: Record<PublicDemoInvoiceSlug, string> = {
  "created-example": "2026-11-02T12:00:00.000Z",
  "awaiting-funding-example": "2026-11-05T12:00:00.000Z",
  "funded-example": "2026-11-08T12:00:00.000Z",
  "route-decision-example": "2026-11-11T12:00:00.000Z",
  "settled-example": "2026-11-14T12:00:00.000Z",
  "failed-example": "2026-11-16T12:00:00.000Z",
};

export const PUBLIC_DEMO_INVOICES: readonly PublicDemoInvoiceSpec[] =
  EXAMPLE_INVOICES.map((invoice) => ({
    ...invoice,
    createdAt: CREATED_AT[invoice.slug],
  }));

/** Deterministic UUID of one example invoice. */
export function publicDemoInvoiceId(slug: PublicDemoInvoiceSlug): string {
  return publicDemoUuid(`invoice:${slug}`);
}

/** Deterministic UUID of the single synthetic quote for an example invoice. */
export function publicDemoQuoteId(slug: PublicDemoInvoiceSlug): string {
  return publicDemoUuid(`quote:${slug}`);
}

/** Deterministic UUID of the simulated payment record for an example. */
export function publicDemoPaymentId(slug: PublicDemoInvoiceSlug): string {
  return publicDemoUuid(`payment:${slug}`);
}

/** Deterministic UUID of the simulated settlement record for an example. */
export function publicDemoSettlementId(slug: PublicDemoInvoiceSlug): string {
  return publicDemoUuid(`settlement:${slug}`);
}

/**
 * One deterministic, simulated quote per invoice. It mirrors the application's
 * own fixed demonstration pricing model and is never a live market quote.
 */
export function publicDemoQuote(spec: PublicDemoInvoiceSpec): PaymentQuote {
  const funding = BigInt(spec.fundingMinor);
  const gross = (funding * 100n) / 525n;
  return {
    fundingMinor: spec.fundingMinor,
    asset: "USDG",
    demoAssetDecimals: 2,
    rate: { numerator: "525", denominator: "100" },
    executionCostMinor: "2",
    simulated: true,
    routes: (
      [
        { id: "direct", name: "Direct liquidity", feeBps: 35, slippageBps: 5 },
        { id: "split", name: "Split liquidity", feeBps: 48, slippageBps: 8 },
        { id: "multi", name: "Multi-hop route", feeBps: 65, slippageBps: 12 },
      ] as const
    ).map(({ id, name, feeBps, slippageBps }) => {
      const output =
        (funding * 100n * BigInt(10000 - feeBps)) / (525n * 10000n);
      return {
        id,
        name,
        feeBps,
        feeMinor: (gross - output).toString(),
        slippageBps,
        toleranceBps: 50,
        outputMinor: output.toString(),
        minimumOutputMinor: ((output * 9950n) / 10000n).toString(),
      };
    }),
  };
}

/** True when the lifecycle state implies a confirmed simulated funding row. */
export function isFundedStatus(status: Status): boolean {
  return ["Funded", "Routing", "Settled"].includes(status);
}

/** True when the example carries a simulated route/settlement record. */
export function hasSimulatedSettlement(status: Status): boolean {
  return status === "Routing" || status === "Settled";
}

/**
 * The exact `invoices.data` JSON for an example. It is derived from the
 * specification so provisioning can compare an existing row against the
 * expected value instead of overwriting it.
 */
export function publicDemoInvoiceData(spec: PublicDemoInvoiceSpec): Invoice {
  const quote = publicDemoQuote(spec);
  const data: Invoice = {
    id: publicDemoInvoiceId(spec.slug),
    reference: spec.reference,
    supplier: spec.supplier,
    wallet: spec.wallet,
    amount: Number(spec.fundingMinor) / 100,
    fundingCurrency: "BRL",
    settlementCurrency: "USDG",
    due: spec.due,
    created: spec.createdAt.slice(0, 10),
    description: spec.description,
    status: spec.status,
    fundingMinor: spec.fundingMinor,
    quote,
  };
  if (spec.selectedRoute) data.selectedRoute = spec.selectedRoute;
  if (isFundedStatus(spec.status))
    data.payment = {
      invoiceId: data.id,
      currency: "BRL",
      amount: data.amount,
      simulated: true,
      receivedAt: spec.createdAt,
    };
  if (spec.status === "Settled") {
    const route = quote.routes.find(
      (candidate) => candidate.id === (spec.selectedRoute ?? "direct"),
    );
    if (!route) throw new Error("synthetic demo route is missing");
    data.receipt = {
      invoiceId: data.id,
      sender: "PONTE synthetic public demo",
      recipient: spec.supplier,
      originalAmountMinor: spec.fundingMinor,
      asset: "USDG",
      amountMinor: route.outputMinor,
      route: route.name,
      execution: {
        routeId: route.id,
        costMinor: quote.executionCostMinor,
        identifier: "SIM-PUBLIC-DEMO-SETTLED",
        simulated: true,
      },
      timestamp: spec.createdAt,
    };
  }
  return data;
}

/**
 * Deterministic timestamps for the simulated quote/settlement rows. A quote
 * keeps the application's 15-minute validity window and settlement completes
 * one hour after creation; both are historical sample values.
 */
export function publicDemoQuoteExpiry(spec: PublicDemoInvoiceSpec): Date {
  return new Date(new Date(spec.createdAt).getTime() + 15 * 60_000);
}

export function publicDemoSettledAt(spec: PublicDemoInvoiceSpec): Date {
  return new Date(new Date(spec.createdAt).getTime() + 60 * 60_000);
}

/** Expected quote/route output for the example's recorded route decision. */
export function publicDemoSelectedRoute(spec: PublicDemoInvoiceSpec) {
  const quote = publicDemoQuote(spec);
  return quote.routes.find(
    (candidate) => candidate.id === (spec.selectedRoute ?? "direct"),
  )!;
}
