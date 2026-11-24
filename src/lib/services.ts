import type {
  Invoice,
  InvoiceInput,
  InvoiceService,
  BusinessActivityEvent,
  InvoiceEvidenceStatus,
  Status,
  WorkspaceAuthentication,
} from "./models";
import { majorToMinor } from "./quotes";

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  resource = "invoices",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1/${resource}${path}`, {
    method: body === undefined ? "GET" : method,
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiRequestError(
      result.error?.code ?? "REQUEST_FAILED",
      response.status,
    );
  return result.data;
}

export async function workspaceAuthentication(): Promise<WorkspaceAuthentication> {
  const response = await fetch("/api/auth/context", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const result = await response.json();
  if (!response.ok) {
    // This UI-only status endpoint keeps the correct 403 semantics while
    // returning a safe account label for the access-denied presentation.
    if (
      response.status === 403 &&
      result.data?.authenticated === true &&
      result.data?.access === null
    )
      return result.data as WorkspaceAuthentication;
    throw new ApiRequestError(
      result.error?.code ?? "REQUEST_FAILED",
      response.status,
    );
  }
  return result.data;
}

export const invoiceService: InvoiceService = {
  activity() {
    return api<BusinessActivityEvent[]>(
      "?limit=3",
      undefined,
      "GET",
      "activity",
    );
  },
  async list() {
    const invoices: Invoice[] = [];
    for (let offset = 0; offset <= 100000; offset += 100) {
      const page = await api<Invoice[]>(`?limit=100&offset=${offset}`);
      invoices.push(...page);
      if (page.length < 100) break;
    }
    return invoices;
  },
  async create(input: InvoiceInput) {
    const { amount, ...fields } = input;
    const invoice = await api<Invoice>("", {
      ...fields,
      fundingMinor: majorToMinor(amount),
    });
    return api<Invoice>(`/${invoice.id}/transitions`, {
      status: "Pending payment",
    });
  },
  async transition(id: string, status: Status, route?: string) {
    let quoteId: string | undefined;
    if (status === "Routing")
      quoteId = (await api<{ id: string }>(`/${id}/quotes`, {})).id;
    return api<Invoice>(`/${id}/transitions`, {
      status,
      ...(route ? { route } : {}),
      ...(quoteId ? { quoteId } : {}),
    });
  },
  evidence(id: string, signal?: AbortSignal) {
    return api<InvoiceEvidenceStatus>(
      `/${id}/evidence`,
      undefined,
      "GET",
      "invoices",
      signal,
    );
  },
};
