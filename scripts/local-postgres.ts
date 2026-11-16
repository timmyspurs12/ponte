import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: ".cache/postgres",
    user: "ponte",
    password: "local-only",
    port: 54329,
    persistent: true,
    initdbFlags: ["--encoding=UTF8"],
  });
  if (!existsSync(".cache/postgres/PG_VERSION")) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("ponte");
  } catch {
    /* database may already exist */
  }
  console.log("DATABASE_URL=postgres://ponte:local-only@localhost:54329/ponte");
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, async () => {
      await pg.stop();
      process.exit(0);
    });
  setInterval(() => {}, 60000);
}
void main();
