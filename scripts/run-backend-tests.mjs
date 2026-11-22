import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

if (process.env.NODE_ENV === "production")
  throw new Error("Backend integration tests refuse a production runtime");

const env = {
  ...process.env,
  // The application config still requires these explicit values at runtime.
  // This runner supplies them only to the disposable local integration suite.
  NODE_ENV: "test",
  PONTE_LOCAL_EVIDENCE_TEST_PROVIDER: "1",
  PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS:
    process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS ??
    "0x1111111111111111111111111111111111111111",
};
const testFiles = readdirSync("tests-backend")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests-backend/${name}`);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/test-server-only-stub.mjs",
    "--import",
    "tsx",
    "--test",
    // Tests intentionally change process-level auth policy and share one
    // disposable PostgreSQL database, so parallel files would race both.
    "--test-concurrency=1",
    ...testFiles,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
