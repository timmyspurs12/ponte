import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { quote } from "../src/lib/quotes";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(await readFile("migrations/001_foundation.sql", "utf8"));
    const business = randomUUID(),
      user = randomUUID(),
      id = randomUUID();
    await db.query("INSERT INTO businesses VALUES($1,$2)", [
      business,
      "Preserved business",
    ]);
    await db.query("INSERT INTO users VALUES($1,$2)", [
      user,
      `${user}@example.invalid`,
    ]);
    await db.query("INSERT INTO memberships VALUES($1,$2,'admin','active')", [
      business,
      user,
    ]);
    const data = {
      id,
      reference: "UPGRADE-001",
      supplier: "Preserved supplier",
      wallet: `0x${"a".repeat(40)}`,
      amount: 25000.01,
      fundingMinor: "2500001",
      fundingCurrency: "BRL",
      settlementCurrency: "USDG",
      due: "2027-12-20",
      description: "Preserve me",
      status: "Draft",
      created: "2026-11-16",
      quote: quote({ fundingMinor: "2500001" }),
    };
    await db.query(
      "INSERT INTO invoices VALUES($1,$2,$3,2500001,'Draft',$4,now())",
      [id, business, data.reference, JSON.stringify(data)],
    );
    await db.query(
      "INSERT INTO payment_events VALUES($1,$2,$3,$4,$5,'invoice.created',$6,now())",
      [
        randomUUID(),
        business,
        id,
        user,
        randomUUID(),
        JSON.stringify({ status: "Draft", simulated: true }),
      ],
    );
    await db.query("BEGIN");
    await db.query(await readFile("migrations/002_audit_metadata.sql", "utf8"));
    await db.query("COMMIT");
    const preserved = (
      await db.query(
        "SELECT data,supplier_name,funding_currency,created_at,updated_at FROM invoices WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.deepEqual(preserved.data, data);
    assert.equal(preserved.supplier_name, data.supplier);
    assert.equal(preserved.funding_currency, "BRL");
    assert.ok(preserved.updated_at);
    const event = (
      await db.query(
        "SELECT previous_state,new_state FROM payment_events WHERE invoice_id=$1",
        [id],
      )
    ).rows[0];
    assert.deepEqual(event, { previous_state: null, new_state: "Draft" });
    await assert.rejects(
      db.query("UPDATE payment_events SET kind='tamper'"),
      /append only/,
    );
    // Exercise the actual multi-file runner on a separate empty schema, twice.
    const fresh = `${schema}_fresh`;
    await db.query(`CREATE SCHEMA ${fresh}`);
    try {
      const env = { ...process.env, PGOPTIONS: `-c search_path=${fresh}` };
      for (let run = 0; run < 2; run++)
        execFileSync(
          process.execPath,
          ["--import", "tsx", "scripts/database.ts", "--seed"],
          { env, stdio: "pipe" },
        );
      const applied = await db.query(
        `SELECT name FROM ${fresh}.schema_migrations ORDER BY name`,
      );
      assert.deepEqual(
        applied.rows.map((r) => r.name),
        ["001_foundation", "002_audit_metadata"],
      );
    } finally {
      await db.query(`DROP SCHEMA ${fresh} CASCADE`);
    }
    console.log(
      "Migration integration passed: existing data/events preserved; clean multi-file runner and repeat apply verified.",
    );
  } finally {
    await db.query("ROLLBACK");
    await db.query("SET search_path TO public");
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    db.release();
    await pool.end();
  }
}
void main();
