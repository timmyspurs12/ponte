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
    await api(`/${i.id}/payments`, {});
    if (n === 3) continue;
    const q = (await api(`/${i.id}/quotes`, {})) as { id: string };
    await api(`/${i.id}/transitions`, {
      status: "Routing",
      route: "direct",
      quoteId: q.id,
    });
    if (n === 2) continue;
    await api(`/${i.id}/transitions`, { status: "Settled" });
  }
  await pool.end();
}
void main();
