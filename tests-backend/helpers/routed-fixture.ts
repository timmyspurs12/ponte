/**
 * Explicitly authorised administrative priming of the `Routing` state.
 *
 * Under R1 (Phase 2C.2B) the application identity holds SELECT+INSERT on
 * `quotes` with no UPDATE, and PostgreSQL requires UPDATE for every row-lock
 * mode. `POST /transitions` with `status:"Routing"` consequently fails closed
 * with 42501 and a sanitised `EVIDENCE_PERSISTENCE_FAILED`. See
 * docs/PHASE2C2B_R1_ROUTING_LIMITATION.md.
 *
 * Tests that need to *start* from an already-routed invoice (settlement
 * settlement persistence, settlement history, evidence reads) therefore prime
 * the exact rows the Routing transaction would have written. This helper is
 * deliberately owner-elevated: it is state priming, not application behaviour.
 *
 * Every later assertion in those tests — settling, replay, receipts, history,
 * evidence reads — still runs through the application API on the application
 * identity, so the behaviour under test remains the app's.
 */
import { randomUUID } from "node:crypto";
import { fixtures } from "./fixtures";
import { EVIDENCE_INSERT_SQL, evidenceFixtureValues } from "./evidence-fixture";

export interface RoutedFixtureInput {
  businessId: string;
  invoiceId: string;
  quoteId: string;
  userId: string;
  routeId: "direct" | "split" | "multi";
  /** The chosen route's `outputMinor`/`minimumOutputMinor` from the quote JSON. */
  expectedMinor: string;
  minimumMinor: string;
  /** True when the caller also wants the full evidence envelope + outbox row. */
  withEvidence?: boolean;
}

/**
 * Writes the settlement, sets the invoice to `Routing`, and appends the
 * `invoice.Routing` event — the three lifecycle-visible writes the Routing
 * transaction performs. Pass `withEvidence` to also insert the encrypted
 * envelope and its pending outbox row.
 */
export async function primeRoutedState(input: RoutedFixtureInput): Promise<void> {
  await fixtures(
    `INSERT INTO settlements(id,business_id,invoice_id,quote_id,route_id,expected_minor,minimum_minor,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,'Routing')`,
    [
      randomUUID(),
      input.businessId,
      input.invoiceId,
      input.quoteId,
      input.routeId,
      input.expectedMinor,
      input.minimumMinor,
    ],
  );

  if (input.withEvidence) {
    const evidenceId = randomUUID();
    await fixtures(
      EVIDENCE_INSERT_SQL,
      evidenceFixtureValues({
        id: evidenceId,
        businessId: input.businessId,
        invoiceId: input.invoiceId,
        quoteId: input.quoteId,
        userId: input.userId,
      }),
    );
    await fixtures(
      "INSERT INTO evidence_outbox(id,evidence_record_id) VALUES($1,$2)",
      [randomUUID(), evidenceId],
    );
  }

  await fixtures(
    `UPDATE invoices SET status='Routing',
       data=jsonb_set(jsonb_set(data,'{status}','"Routing"'::jsonb),'{selectedRoute}',to_jsonb($2::text))
     WHERE id=$1`,
    [input.invoiceId, input.routeId],
  );

  // The Routing transaction also appends its lifecycle event, and the activity
  // feed counts it. Priming must not silently subtract a row from that history.
  await fixtures(
    `INSERT INTO payment_events(id,business_id,invoice_id,actor_id,correlation_id,kind,data,previous_state,new_state)
     VALUES($1,$2,$3,$4,$5,'invoice.Routing',$6,'Funded','Routing')`,
    [
      randomUUID(),
      input.businessId,
      input.invoiceId,
      input.userId,
      randomUUID(),
      JSON.stringify({
        status: "Routing",
        selectedRoute: input.routeId,
        simulated: true,
      }),
    ],
  );
}
