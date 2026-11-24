import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  CommitOutcomeUnknownError,
  pool,
  transactionWithCommitOutcome,
} from "../../src/server/repository";

interface SyntheticTransactionPlan {
  commitError?: Error;
  rollbackError?: Error;
}

interface ObservedClientUse {
  queries: string[];
  releases: boolean[];
}

async function withSyntheticClient<T>(
  plan: SyntheticTransactionPlan,
  run: (observed: ObservedClientUse) => Promise<T>,
): Promise<T> {
  const originalConnect = pool.connect.bind(pool);
  const observed: ObservedClientUse = { queries: [], releases: [] };
  const client = {
    async query(command: string) {
      observed.queries.push(command);
      if (command === "COMMIT" && plan.commitError) throw plan.commitError;
      if (command === "ROLLBACK" && plan.rollbackError)
        throw plan.rollbackError;
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

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

test("evidence transaction returns only after an acknowledged COMMIT", async () => {
  await withSyntheticClient({}, async (observed) => {
    assert.equal(
      await transactionWithCommitOutcome(async () => "committed"),
      "committed",
    );
    assert.deepEqual(observed.queries, ["BEGIN", "COMMIT"]);
    assert.deepEqual(observed.releases, [false]);
  });
});

for (const [label, commitError] of [
  ["ECONNRESET", errorWithCode("ECONNRESET")],
  ["ETIMEDOUT", errorWithCode("ETIMEDOUT")],
  ["EPIPE", errorWithCode("EPIPE")],
  ["no code", new Error("synthetic transport loss")],
  ["SQLSTATE 40003", errorWithCode("40003")],
  ["SQLSTATE 08006", errorWithCode("08006")],
] as const) {
  test(`ambiguous COMMIT ${label} avoids ROLLBACK and destroys the client`, async () => {
    await withSyntheticClient({ commitError }, async (observed) => {
      await assert.rejects(
        transactionWithCommitOutcome(async () => "unknown"),
        (error: unknown) => error instanceof CommitOutcomeUnknownError,
      );
      assert.deepEqual(observed.queries, ["BEGIN", "COMMIT"]);
      assert.deepEqual(observed.releases, [true]);
    });
  });
}

test("definitive SQLSTATE rejection rolls back and preserves the original server error", async () => {
  const serverError = errorWithCode("23505");
  await withSyntheticClient({ commitError: serverError }, async (observed) => {
    await assert.rejects(
      transactionWithCommitOutcome(async () => "never returned"),
      (error: unknown) => error === serverError,
    );
    assert.deepEqual(observed.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.deepEqual(observed.releases, [false]);
  });
});

test("XQuery SQLSTATE 10608 is definitive and preserves the original server error", async () => {
  const serverError = errorWithCode("10608");
  await withSyntheticClient({ commitError: serverError }, async (observed) => {
    await assert.rejects(
      transactionWithCommitOutcome(async () => "never returned"),
      (error: unknown) => error === serverError,
    );
    assert.deepEqual(observed.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.deepEqual(observed.releases, [false]);
  });
});

test("callback failure preserves the callback error when rollback also fails and destroys the client", async () => {
  const callbackError = new Error("synthetic callback failure");
  const rollbackError = new Error("synthetic rollback failure");
  await withSyntheticClient({ rollbackError }, async (observed) => {
    await assert.rejects(
      transactionWithCommitOutcome(async () => {
        throw callbackError;
      }),
      (error: unknown) => error === callbackError,
    );
    assert.deepEqual(observed.queries, ["BEGIN", "ROLLBACK"]);
    assert.deepEqual(observed.releases, [true]);
  });
});
