import { execute } from "../src/server/service";
import { pool } from "../src/server/repository";
import type { Invoice } from "../src/lib/models";
async function main() {
  const business = process.env.PONTE_DEV_BUSINESS_ID!;
  if (process.env.NODE_ENV === "production")
    throw new Error("Local fixtures only");
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
  async function api(path: string, body: unknown) {
    return execute(
      new Request(`http://localhost/api/v1/invoices${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.PONTE_DEV_TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
      ["invoices", ...path.split("/").filter(Boolean)],
    );
  }
  for (let n = 0; n < 8; n++) {
    const reference = `PNT-2026-${1048 - n}`;
    if (
      (
        await pool.query(
          "SELECT 1 FROM invoices WHERE business_id=$1 AND reference=$2",
          [business, reference],
        )
      ).rowCount
    )
      continue;
    const i = (await api("", {
      reference,
      supplier: names[n],
      wallet: `0x${String(n + 1).repeat(40)}`,
      fundingMinor: String(
        [2500000, 4820000, 1280000, 3650000, 875000, 1920000, 630000, 1540000][
          n
        ],
      ),
      due: "2027-12-20",
      description: "Illustrative database seed — simulation only",
    })) as Invoice;
    if (n === 4) continue;
    await api(`/${i.id}/transitions`, { status: "Pending payment" });
    if (n === 0 || n === 7) continue;
    if (n === 6) {
      await api(`/${i.id}/transitions`, { status: "Failed" });
      continue;
    }
    // Application-supported operations only. Routing evidence persistence is
    // dormant and fail-closed by design (R1): the application identity holds no
    // UPDATE on `quotes`/`memberships`, so the persistence path's membership
    // lock rejects every Routing attempt with EVIDENCE_PERSISTENCE_FAILED.
    // The seeder therefore creates the payment and the quote but does **not**
    // attempt a Routing or Settled transition. Routing/Settled fixtures are
    // primed directly by `tests/setup-database.ts` through the administrative
    // helper, which is the approved path for pre-existing Routing state.
    await api(`/${i.id}/payments`, {});
    // Create the quote so the admin-primed Routing/Settled fixtures have a
    // valid quote to reference (route_decision_evidence and settlements both
    // foreign-key to quotes). The quote is created through the application
    // identity, which is a supported operation.
    await api(`/${i.id}/quotes`, {});
  }
  await pool.end();
}
void main();

