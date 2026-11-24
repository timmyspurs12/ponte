import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GET as liveness,
  runtime as livenessRuntime,
} from "../src/app/api/health/live/route";
import {
  GET as readiness,
  runtime as readinessRuntime,
} from "../src/app/api/health/ready/route";
import { databaseReadinessResponse } from "../src/server/health";
import { pool } from "../src/server/repository";

after(async () => {
  await pool.end();
});

test("health handlers and the committed runtime pin declare the tested Node path", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { engines?: { node?: unknown } };
  const nodeVersion = readFileSync(
    new URL("../.node-version", import.meta.url),
    "utf8",
  ).trim();

  assert.equal(livenessRuntime, "nodejs");
  assert.equal(readinessRuntime, "nodejs");
  assert.equal(nodeVersion, "24.22.1");
  assert.equal(manifest.engines?.node, ">=24.22.1 <25");
});

test("liveness is a generic Node.js process response without database work", async () => {
  assert.equal(livenessRuntime, "nodejs");
  const response = await liveness();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("readiness uses the Node.js runtime and succeeds after a minimal database query", async () => {
  assert.equal(readinessRuntime, "nodejs");
  const response = await readiness();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ready" });
});

test("readiness reports database unavailability without leaking a database error", async () => {
  const sensitiveDiagnostic =
    "postgresql://private-user:private-password@private-db.internal:5432/ponte";
  const response = await databaseReadinessResponse(async () => {
    throw new Error(sensitiveDiagnostic);
  });
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body, '{"status":"unavailable"}');
  assert.doesNotMatch(body, /postgres|private|password|internal/i);
});
