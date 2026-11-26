import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { adminWrite } from "../tests-backend/helpers/admin-database";
import { adminPool } from "../tests-backend/helpers/database-identities";

/**
 * Playwright database setup.
 *
 * The destructive work here (`TRUNCATE`, `DELETE FROM rate_limits`) is
 * administrative: the application identity holds only column-scoped UPDATE on
 * `rate_limits` and no privilege on most fixture tables, so it cannot perform
 * either statement. Both operations therefore run through the administrative
 * helper, which elevates to `ponte_owner` inside a transaction-local scope and
 * never leaks the elevation back to the pool.
 *
 * The seed step that follows `resetFixtures` stays on the application identity
 * on purpose: `scripts/seed-fixtures.ts` exercises the real `execute()` service
 * path, which is the behaviour the UI tests are checking.
 */

export async function clearDevelopmentRateLimit() {
  const business = process.env.PONTE_DEV_BUSINESS_ID;
  const user = process.env.PONTE_DEV_USER_ID;
  if (!process.env.DATABASE_URL || !business || !user)
    throw new Error("Test database required");
  await adminWrite(adminPool(), async ({ db }) => {
    await db.query("DELETE FROM rate_limits WHERE identity=$1", [
      `${business}:${user}`,
    ]);
  });
}

/**
 * Primes pre-existing Routing and Settled fixture state through the
 * administrative helper.
 *
 * R1 makes Routing evidence persistence dormant and fail-closed by design: the
 * application identity holds no `UPDATE` on `quotes`/`memberships`, so every
 * Routing attempt is rejected at the membership lock with
 * `EVIDENCE_PERSISTENCE_FAILED`. The application seeder therefore cannot create
 * Routing or Settled fixtures.
 *
 * These fixtures are **synthetic pre-seeded test data**, not evidence generated
 * by a successful application Routing operation. They are inserted directly by
 * `ponte_owner` (via `adminWrite`) so the browser suite can exercise the
 * Routing-state UI (evidence panel, settlement, receipt) against realistic
 * pre-existing state. No application code path is used to create them, and no
 * privilege is widened.
 *
 * The fixtures reference references created by `scripts/seed-fixtures.ts`:
 * - `PNT-2026-1047` → Routing, split route (settlement/receipt UI)
 * - `PNT-2026-1045` → Routing, multi route (localization settlement UI)
 * - `PNT-2026-1046` → Settled (settlement completed)
 * - `PNT-2026-1043` → Settled (settlement completed)
 */
export async function primeRoutedState(): Promise<void> {
  const business = process.env.PONTE_DEV_BUSINESS_ID;
  const user = process.env.PONTE_DEV_USER_ID;
  if (!business || !user)
    throw new Error("PONTE_DEV_BUSINESS_ID and PONTE_DEV_USER_ID required");

  await adminWrite(adminPool(), async ({ db }) => {
    // Route code mapping: direct=1, split=2, multi=3.
    const routeCodes: Record<string, number> = {
      direct: 1,
      split: 2,
      multi: 3,
    };

    const fixtures: Array<{
      reference: string;
      route: "direct" | "split" | "multi";
      settled: boolean;
    }> = [
      { reference: "PNT-2026-1047", route: "split", settled: false },
      { reference: "PNT-2026-1045", route: "multi", settled: false },
      { reference: "PNT-2026-1046", route: "direct", settled: true },
      { reference: "PNT-2026-1043", route: "split", settled: true },
    ];

    for (const fixture of fixtures) {
      // Read the invoice row (status, funding_minor, data JSONB) and its quote.
      const invoiceRow = await db.query(
        `SELECT id, funding_minor, data FROM invoices
          WHERE business_id=$1 AND reference=$2`,
        [business, fixture.reference],
      );
      if (!invoiceRow.rowCount)
        throw new Error(
          `primeRoutedState: invoice ${fixture.reference} not found; run seed-fixtures first`,
        );
      const invoice = invoiceRow.rows[0] as {
        id: string;
        funding_minor: string;
        data: Record<string, unknown>;
      };

      const quoteRow = await db.query(
        `SELECT id, data FROM quotes
          WHERE business_id=$1 AND invoice_id=$2`,
        [business, invoice.id],
      );
      if (!quoteRow.rowCount)
        throw new Error(
          `primeRoutedState: quote for ${fixture.reference} not found; seed must create it`,
        );
      const quote = quoteRow.rows[0] as { id: string; data: Record<string, unknown> };

      const quoteObj = quote.data as {
        routes: Array<{ id: string; name: string; outputMinor: string }>;
        executionCostMinor: string;
      };
      const routeCandidate = quoteObj.routes.find((r) => r.id === fixture.route)!;
      const expectedMinor = BigInt(invoice.funding_minor);
      // Use a deterministic minimum (95% of expected) so the settlement
      // constraints are satisfied.
      const minimumMinor = expectedMinor - (expectedMinor / BigInt(20));
      const actualMinor = expectedMinor;

      // Build the synthetic evidence record. All bytea values are random
      // synthetic test bytes — no real KMS operation, no on-chain attestation.
      const evidenceId = randomUUID();
      const publicEvidenceId = randomBytes(32);
      const quoteSnapshotHash = randomBytes(32);
      const previousPayloadHash = Buffer.from(
        "00".repeat(32),
        "hex",
      );
      const payloadHash = randomBytes(32);
      const ciphertext = randomBytes(64);
      const nonce = randomBytes(12);
      const authenticationTag = randomBytes(16);
      const wrappedDek = randomBytes(32);
      const registryAddress = randomBytes(20);

      await db.query(
        `INSERT INTO route_decision_evidence(
           id, business_id, invoice_id, quote_id, created_by_user_id,
           routing_correlation_id, public_evidence_id,
           evidence_schema_version, quote_schema_version, chain_id,
           registry_address, sequence, evidence_kind, selected_route_code,
           quote_snapshot_hash, previous_payload_hash, payload_hash,
           envelope_version, content_algorithm, ciphertext, nonce,
           authentication_tag, wrapped_dek, kms_provider,
           wrapped_dek_algorithm, wrapped_dek_format, kms_key_reference,
           kms_key_version, aad_version
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                   $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
        [
          evidenceId,
          business,
          invoice.id,
          quote.id,
          user,
          randomUUID(),
          publicEvidenceId,
          1, // evidence_schema_version
          1, // quote_schema_version
          "421614", // chain_id (Arbitrum Sepolia)
          registryAddress,
          "1", // sequence
          1, // evidence_kind
          routeCodes[fixture.route],
          quoteSnapshotHash,
          previousPayloadHash,
          payloadHash,
          1, // envelope_version
          "AES-256-GCM",
          ciphertext,
          nonce,
          authenticationTag,
          wrappedDek,
          "local-test-only",
          "LOCAL_TEST_RANDOM_BYTES_V1",
          "local-test-random-bytes-v1",
          "local-test-only/fixture",
          "local-test-only/v1",
          1, // aad_version
        ],
      );

      // Pending outbox record. `submission_state` is omitted: migration 007
      // supplies the DEFAULT 'pending'. This is the same shape the application
      // would produce if persistence were enabled.
      await db.query(
        "INSERT INTO evidence_outbox(id, evidence_record_id) VALUES($1,$2)",
        [randomUUID(), evidenceId],
      );

      // Settlement record. Status is 'Routing' for unsettled fixtures and
      // 'Settled' (with actual_minor and settled_at) for settled fixtures.
      const settlementId = randomUUID();
      await db.query(
        `INSERT INTO settlements(
           id, business_id, invoice_id, quote_id, route_id,
           expected_minor, minimum_minor, actual_minor, status, settled_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          settlementId,
          business,
          invoice.id,
          quote.id,
          fixture.route,
          expectedMinor.toString(),
          minimumMinor.toString(),
          fixture.settled ? actualMinor.toString() : null,
          fixture.settled ? "Settled" : "Routing",
          fixture.settled ? new Date().toISOString() : null,
        ],
      );

      // Update the invoice row: status column and data JSONB.
      const updatedData = { ...invoice.data };
      updatedData.status = fixture.settled ? "Settled" : "Routing";
      updatedData.selectedRoute = fixture.route;
      if (fixture.settled) {
        updatedData.receipt = {
          invoiceId: invoice.id,
          sender: "PONTE simulation",
          recipient: updatedData.supplier,
          originalAmountMinor: expectedMinor.toString(),
          asset: "USDG",
          amountMinor: expectedMinor.toString(),
          route: routeCandidate.name,
          execution: {
            routeId: fixture.route,
            costMinor: quoteObj.executionCostMinor,
            identifier: `SIM-${settlementId}`,
            simulated: true,
          },
          timestamp: new Date().toISOString(),
        };
      }
      await db.query(
        `UPDATE invoices SET status=$3, data=$4::jsonb
          WHERE business_id=$1 AND id=$2`,
        [business, invoice.id, updatedData.status, JSON.stringify(updatedData)],
      );
    }
  });
}

export async function resetFixtures() {
  if (!process.env.DATABASE_URL || !process.env.PONTE_DEV_AUTH)
    throw new Error("Test database required");
  await adminWrite(adminPool(), async ({ db }) => {
    await db.query(
      "TRUNCATE idempotency,payment_events,evidence_outbox,route_decision_evidence,settlements,quotes,payments,invoices,rate_limits",
    );
  });
  execFileSync(
    process.execPath,
    [
      "--import",
      "./scripts/test-server-only-stub.mjs",
      "--import",
      "tsx",
      "scripts/seed-fixtures.ts",
    ],
    { env: process.env, stdio: "pipe" },
  );
  // After application seeding succeeds, prime the Routing/Settled fixtures
  // that R1 prevents the application identity from creating.
  await primeRoutedState();
}
