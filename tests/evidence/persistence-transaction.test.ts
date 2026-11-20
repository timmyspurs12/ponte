import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  CommitOutcomeUnknownError,
  pool,
  transactionWithCommitOutcome,
} from "../../src/server/repository";

type QueryOutcome = "acknowledged" | "definitive-rejection" | "ambiguous-loss";

async function withSyntheticClient<T>(
  outcome: QueryOutcome,
  run: (observed: { queries: string[]; releases: boolean[] }) => Promise<T>,
): Promise<T> {
  const originalConnect = pool.connect.bind(pool);
  const observed = { queries: [] as string[], releases: [] as boolean[] };
  const client = {
    async query(command: string) {
      observed.queries.push(command);
      if (command === "COMMIT" && outcome === "definitive-rejection")
        throw Object.assign(new Error("definitive rejection"), {
          code: "23505",
        });
      if (command === "COMMIT" && outcome === "ambiguous-loss")
        throw Object.assign(new Error("transport acknowledgement lost"), {
          code: "08006",
        });
      return { rowCount: 0, rows: [] };
    },
    release(destroy?: boolean) {
      observed.releases.push(Boolean(destroy));
    },
  } as unknown as PoolClient;

  (pool as unknown as { connect: typeof pool.connect }).connect = (async () =>
    client) as typeof pool.connect;
  try {
    return await run(observed);
  } finally {
    (pool as unknown as { connect: typeof pool.connect }).connect =
      originalConnect as typeof pool.connect;
  }
}

test("evidence transaction returns only after an acknowledged COMMIT", async () => {
  await withSyntheticClient("acknowledged", async (observed) => {
    assert.equal(
      await transactionWithCommitOutcome(async () => "committed"),
      "committed",
    );
    assert.deepEqual(observed.queries, ["BEGIN", "COMMIT"]);
    assert.deepEqual(observed.releases, [false]);
  });
});

test("definitive COMMIT rejection rolls back and preserves the definitive error", async () => {
  await withSyntheticClient("definitive-rejection", async (observed) => {
    await assert.rejects(
      transactionWithCommitOutcome(async () => "never returned"),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
    assert.deepEqual(observed.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.deepEqual(observed.releases, [false]);
  });
});

test("ambiguous COMMIT loss avoids ROLLBACK and destroys the uncertain client", async () => {
  await withSyntheticClient("ambiguous-loss", async (observed) => {
    await assert.rejects(
      transactionWithCommitOutcome(async () => "unknown"),
      (error: unknown) => error instanceof CommitOutcomeUnknownError,
    );
    assert.deepEqual(observed.queries, ["BEGIN", "COMMIT"]);
    assert.deepEqual(observed.releases, [true]);
  });
});
