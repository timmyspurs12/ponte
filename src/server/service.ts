import { sameOrigin } from "./security";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./repository";
import * as repository from "./repository";
import { quote } from "../lib/quotes";
import type { Invoice, PaymentQuote, Status } from "../lib/models";
export { ApiError } from "./errors";
import { fail } from "./errors";
import { authenticate, type Context } from "./auth";
import {
  createRoutingRequestFingerprint,
  idempotencyKeySchema,
  routingTransitionSchema,
} from "./routing-boundary";
import {
  orchestratePreparedRoutingCandidate,
  type RoutingOrchestrationTestHooks,
  type RoutingPreparationDependencies,
} from "./evidence/routing-orchestration";
import { mapEvidenceError } from "./evidence/error-boundary";
import { resolveLocalRoutingEvidencePreparationDependencies } from "./evidence/local-routing-config";
import { invoiceEvidenceStatus } from "./evidence/status";
const uuid = z.uuid();
const input = z
  .object({
    reference: z.string().trim().min(1).max(100),
    supplier: z.string().trim().min(2).max(200),
    wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    fundingMinor: z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .refine(
        (v) =>
          /^[1-9]\d{0,9}$/.test(v) &&
          BigInt(v) >= 100n &&
          BigInt(v) <= 1000000000n,
      ),
    due: z.iso.date(),
    description: z.string().max(2000),
  })
  .strict();
const state = z.enum([
  "Draft",
  "Pending payment",
  "Funded",
  "Routing",
  "Settled",
  "Failed",
]);
const change = z
  .object({
    status: state,
    route: z.enum(["direct", "split", "multi"]).optional(),
    quoteId: uuid.optional(),
  })
  .strict();
async function get(
  db: PoolClient,
  ctx: Context,
  id: string,
  lock = false,
): Promise<Invoice> {
  const r = await repository.findInvoice(db, ctx.business, id, lock);
  if (!r.rowCount) fail(404, "NOT_FOUND");
  return r.rows[0].data;
}
async function event(
  db: PoolClient,
  ctx: Context,
  i: Invoice,
  correlation: string,
  kind: string,
  previousState: Status | null,
) {
  await repository.appendEvent(db, [
    randomUUID(),
    ctx.business,
    i.id,
    ctx.user,
    correlation,
    kind,
    JSON.stringify({
      status: i.status,
      selectedRoute: i.selectedRoute,
      fundingMinor: i.fundingMinor,
      simulated: true,
    }),
    previousState,
    i.status,
  ]);
}

interface ExecuteTestDependencies {
  resolveRoutingPreparationDependencies?: () =>
    RoutingPreparationDependencies | Promise<RoutingPreparationDependencies>;
  routingOrchestrationHooks?: RoutingOrchestrationTestHooks;
}

/** Normal API entrypoint: Routing uses only the guarded local configuration. */
export async function execute(request: Request, parts: string[]) {
  return executeWithDependencies(request, parts);
}

/**
 * Test-only service entrypoint for deterministic provider/race coverage. It is
 * unavailable outside Node's test environment and is never used by the route
 * handler or local configuration boundary.
 */
export async function __testOnlyExecute(
  request: Request,
  parts: string[],
  dependencies: ExecuteTestDependencies,
) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("test-only service dependencies are unavailable");
  return executeWithDependencies(request, parts, dependencies);
}

async function executeWithDependencies(
  request: Request,
  parts: string[],
  dependencies?: ExecuteTestDependencies,
) {
  const ctx = await authenticate(request),
    url = new URL(request.url),
    method = request.method;
  if (parts.length === 1 && parts[0] === "activity" && method === "GET") {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(url.searchParams.get("limit") ?? 50);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(url.searchParams.get("offset") ?? 0);
    const kind = url.searchParams.get("type");
    if (kind !== null) z.string().min(1).max(100).parse(kind);
    return transaction(
      async (db) =>
        (
          await repository.businessActivity(
            db,
            ctx.business,
            limit,
            offset,
            kind,
          )
        ).rows,
    );
  }
  if (parts[0] !== "invoices") fail(404, "NOT_FOUND");
  const id = parts[1] ? uuid.parse(parts[1]) : undefined,
    resource = parts[2];
  if (
    parts.length > 4 ||
    (parts.length === 4 &&
      (method !== "GET" || !["quotes", "payments"].includes(resource)))
  )
    fail(404, "NOT_FOUND");
  if (method === "GET")
    return transaction(async (db) => {
      if (!id) {
        const limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(url.searchParams.get("limit") ?? 100),
          offset = z.coerce
            .number()
            .int()
            .min(0)
            .max(100000)
            .parse(url.searchParams.get("offset") ?? 0);
        const filter = url.searchParams.get("status");
        if (filter) state.parse(filter);
        return (
          await repository.listInvoices(db, [
            ctx.business,
            filter,
            limit,
            offset,
          ])
        ).rows.map((r) => r.data);
      }
      const i = await get(db, ctx, id);
      if (!resource) return i;
      if (resource === "evidence") {
        const result = await repository.findInvoiceEvidenceStatus(
          db,
          ctx.business,
          i.id,
        );
        return invoiceEvidenceStatus(i.id, result.rows[0]);
      }
      if (parts[3]) {
        const result = await repository.findResource(
          db,
          ctx.business,
          id,
          resource as "quotes" | "payments",
          uuid.parse(parts[3]),
        );
        if (!result.rowCount) fail(404, "NOT_FOUND");
        return result.rows[0];
      }
      if (resource === "quotes")
        return (await repository.listQuotes(db, [ctx.business, id])).rows;
      if (!["payments", "settlements", "activity"].includes(resource))
        fail(404, "NOT_FOUND");
      const history = (
        await repository.history(
          db,
          ctx.business,
          id,
          resource as "payments" | "settlements" | "activity",
        )
      ).rows;
      // This schema and lifecycle support only simulation. If real settlements
      // are ever introduced, replace this with verified persisted provenance.
      return resource === "settlements"
        ? history.map((record) => ({ ...record, simulated: true }))
        : history;
    });
  if (!["POST", "PATCH"].includes(method)) fail(405, "METHOD_NOT_ALLOWED");
  if (ctx.role === "viewer") fail(403, "FORBIDDEN");
  if (!sameOrigin(request)) fail(403, "ORIGIN_REJECTED");
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    fail(415, "UNSUPPORTED_MEDIA_TYPE");
  const reader = request.body?.getReader();
  let text = "";
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        fail(413, "BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(400, "INVALID_JSON");
  }
  const key = idempotencyKeySchema.parse(
    request.headers.get("idempotency-key"),
  );
  const fingerprint = createRoutingRequestFingerprint({
    method,
    pathname: url.pathname,
    text,
  });
  const routingCommand =
    id && resource === "transitions" && method === "POST"
      ? routingTransitionSchema.safeParse(body)
      : undefined;
  if (id && routingCommand?.success) {
    try {
      const result = await orchestratePreparedRoutingCandidate(
        {
          businessId: ctx.business,
          actorUserId: ctx.user,
          invoiceId: id,
          quoteId: routingCommand.data.quoteId,
          idempotencyKey: key,
          requestFingerprint: fingerprint,
          selectedRouteId: routingCommand.data.route,
          resolvePreparationDependencies:
            dependencies?.resolveRoutingPreparationDependencies ??
            resolveLocalRoutingEvidencePreparationDependencies,
        },
        dependencies?.routingOrchestrationHooks,
      );
      return result.response;
    } catch (error) {
      const mapped = mapEvidenceError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }
  return transaction(async (db) => {
    await repository.lockIdempotencyKey(db, [`${ctx.business}:${key}`]);
    const old = await repository.findIdempotency(db, [ctx.business, key]);
    if (old.rowCount) {
      if (old.rows[0].fingerprint !== fingerprint)
        fail(409, "IDEMPOTENCY_CONFLICT");
      return old.rows[0].response;
    }
    let result: unknown;
    if (!id && method === "POST") {
      const parsed = input.parse(body);
      if (parsed.due < new Date().toISOString().slice(0, 10))
        fail(422, "INVALID_DUE_DATE");
      const { fundingMinor, ...fields } = parsed;
      const i: Invoice = {
        ...fields,
        id: randomUUID(),
        amount: Number(fundingMinor) / 100,
        fundingCurrency: "BRL",
        settlementCurrency: "USDG",
        created: new Date().toISOString().slice(0, 10),
        status: "Draft",
        fundingMinor,
        quote: quote({ fundingMinor }),
      };
      await repository.insertInvoice(db, [
        i.id,
        ctx.business,
        i.reference,
        fundingMinor,
        i.status,
        JSON.stringify(i),
      ]);
      await event(db, ctx, i, randomUUID(), "invoice.created", null);
      result = await get(db, ctx, i.id);
    } else if (id) {
      const i = await get(db, ctx, id, true);
      if (resource === "quotes" && method === "POST") {
        z.object({}).strict().parse(body);
        if (!["Pending payment", "Funded"].includes(i.status))
          fail(409, "INVALID_TRANSITION");
        const q = quote({ fundingMinor: i.fundingMinor! }),
          qid = randomUUID(),
          expires = new Date(Date.now() + 15 * 60000).toISOString();
        await repository.insertQuote(db, [
          qid,
          ctx.business,
          id,
          JSON.stringify(q),
          expires,
        ]);
        await event(db, ctx, i, qid, "quote.created", i.status);
        result = { id: qid, data: q, expires_at: expires };
      } else if (
        (resource === "transitions" && method === "POST") ||
        (resource === "payments" && method === "POST")
      ) {
        const command =
          resource === "payments"
            ? (z.object({}).strict().parse(body), { status: "Funded" as const })
            : change.parse(body);
        const allowed: Record<Status, Status[]> = {
          Draft: ["Pending payment", "Failed"],
          "Pending payment": ["Funded", "Failed"],
          Funded: ["Routing", "Failed"],
          Routing: ["Settled", "Failed"],
          Settled: [],
          Failed: [],
        };
        if (!allowed[i.status].includes(command.status))
          fail(409, "INVALID_TRANSITION");
        const previousState = i.status;
        let correlation = randomUUID();
        if (command.status === "Funded") {
          const paymentId = randomUUID();
          correlation = paymentId;
          await repository.insertPayment(db, [
            paymentId,
            ctx.business,
            id,
            `SIM-${paymentId}`,
            i.fundingMinor,
          ]);
          i.payment = {
            invoiceId: id,
            currency: "BRL",
            amount: i.amount,
            simulated: true,
            receivedAt: new Date().toISOString(),
          };
        }
        if (command.status === "Routing") {
          // A structurally complete Routing command was delegated before this
          // generic transaction began. Retain the established validation for a
          // missing field, but never let this legacy path create a settlement.
          if (!command.quoteId || !command.route)
            fail(422, "QUOTE_AND_ROUTE_REQUIRED");
          fail(500, "INTERNAL_ERROR");
        }
        if (command.status === "Settled") {
          const s = await repository.lockValidSettlement(db, [
            ctx.business,
            id,
          ]);
          if (!s.rowCount) fail(409, "QUOTE_EXPIRED_OR_MISSING");
          const row = s.rows[0];
          correlation = row.id;
          if (command.route && command.route !== row.route_id)
            fail(409, "ROUTE_LOCKED");
          await repository.completeSettlement(db, [row.id]);
          i.receipt = {
            invoiceId: id,
            sender: "PONTE simulation",
            recipient: i.supplier,
            originalAmountMinor: i.fundingMinor!,
            asset: "USDG",
            amountMinor: row.expected_minor,
            route: (row.quote as PaymentQuote).routes.find(
              (r) => r.id === row.route_id,
            )!.name,
            execution: {
              routeId: row.route_id,
              costMinor: row.quote.executionCostMinor,
              identifier: `SIM-${row.id}`,
              simulated: true,
            },
            timestamp: new Date().toISOString(),
          };
        }
        if (command.status === "Failed")
          await repository.failSettlement(db, [ctx.business, id]);
        i.status = command.status;
        await repository.saveInvoiceState(db, [
          ctx.business,
          id,
          i.status,
          JSON.stringify(i),
        ]);
        await event(
          db,
          ctx,
          i,
          correlation,
          `invoice.${command.status}`,
          previousState,
        );
        result = await get(db, ctx, id);
      } else if (!resource && method === "PATCH") {
        if (i.status !== "Draft") fail(409, "INVOICE_LOCKED");
        const parsed = input.parse(body);
        if (parsed.due < new Date().toISOString().slice(0, 10))
          fail(422, "INVALID_DUE_DATE");
        Object.assign(i, parsed, {
          amount: Number(parsed.fundingMinor) / 100,
          quote: quote({ fundingMinor: parsed.fundingMinor }),
        });
        await repository.updateDraft(db, [
          ctx.business,
          id,
          i.reference,
          i.fundingMinor,
          JSON.stringify(i),
        ]);
        await event(db, ctx, i, randomUUID(), "invoice.updated", "Draft");
        result = await get(db, ctx, id);
      } else fail(404, "NOT_FOUND");
    } else fail(404, "NOT_FOUND");
    await repository.saveIdempotency(db, [
      ctx.business,
      key,
      fingerprint,
      JSON.stringify(result),
    ]);
    return result;
  });
}
