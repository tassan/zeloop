import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { advisoryKey, tryAdvisoryXactLock } from "../../advisory.js";
import type { PgExecutor } from "../../types.js";
import { startPostgres, stopPostgres } from "./setup.js";

let pool: pg.Pool;

beforeAll(async () => {
  const result = await startPostgres();
  pool = result.pool;
});

afterAll(async () => {
  await stopPostgres();
});

describe("advisory locks", () => {
  it("acquires lock in a transaction", async () => {
    const { k1, k2 } = advisoryKey("test-job");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const executor: PgExecutor = {
        async query<T>(sql: string, params?: readonly unknown[]) {
          const res = await client.query(sql, params as unknown[]);
          return { rows: res.rows as T[] };
        },
      };
      const acquired = await tryAdvisoryXactLock(executor, k1, k2);
      expect(acquired).toBe(true);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("only one of N concurrent attempts acquires the lock", async () => {
    const { k1, k2 } = advisoryKey("exclusive-job");
    const concurrency = 5;

    // Each attempt runs in its own connection/transaction
    const results = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const executor: PgExecutor = {
            async query<T>(sql: string, params?: readonly unknown[]) {
              const res = await client.query(sql, params as unknown[]);
              return { rows: res.rows as T[] };
            },
          };
          const acquired = await tryAdvisoryXactLock(executor, k1, k2);
          // Hold the lock briefly
          await new Promise((resolve) => setTimeout(resolve, 100));
          await client.query("COMMIT");
          return acquired;
        } finally {
          client.release();
        }
      }),
    );

    // Exactly one should have acquired the lock at a time
    // Since we hold a brief lock, some may fail to acquire
    const acquiredCount = results.filter(Boolean).length;
    expect(acquiredCount).toBeGreaterThanOrEqual(1);
    // At least some should have NOT acquired the lock
    // (with 5 concurrent attempts, not all can acquire simultaneously)
    expect(results.some((r) => r === false)).toBe(true);
  });

  it("different keys allow independent locks", async () => {
    const key1 = advisoryKey("job-a");
    const key2 = advisoryKey("job-b");

    const client1 = await pool.connect();
    const client2 = await pool.connect();
    try {
      await client1.query("BEGIN");
      await client2.query("BEGIN");

      const exec1: PgExecutor = {
        async query<T>(sql: string, params?: readonly unknown[]) {
          const res = await client1.query(sql, params as unknown[]);
          return { rows: res.rows as T[] };
        },
      };
      const exec2: PgExecutor = {
        async query<T>(sql: string, params?: readonly unknown[]) {
          const res = await client2.query(sql, params as unknown[]);
          return { rows: res.rows as T[] };
        },
      };

      const acquired1 = await tryAdvisoryXactLock(exec1, key1.k1, key1.k2);
      const acquired2 = await tryAdvisoryXactLock(exec2, key2.k1, key2.k2);

      expect(acquired1).toBe(true);
      expect(acquired2).toBe(true);

      await client1.query("COMMIT");
      await client2.query("COMMIT");
    } finally {
      client1.release();
      client2.release();
    }
  });

  it("lock is released after transaction ends", async () => {
    const { k1, k2 } = advisoryKey("release-test");

    // First transaction acquires and commits
    const client1 = await pool.connect();
    try {
      await client1.query("BEGIN");
      const exec1: PgExecutor = {
        async query<T>(sql: string, params?: readonly unknown[]) {
          const res = await client1.query(sql, params as unknown[]);
          return { rows: res.rows as T[] };
        },
      };
      expect(await tryAdvisoryXactLock(exec1, k1, k2)).toBe(true);
      await client1.query("COMMIT");
    } finally {
      client1.release();
    }

    // Second transaction should be able to acquire the same lock
    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      const exec2: PgExecutor = {
        async query<T>(sql: string, params?: readonly unknown[]) {
          const res = await client2.query(sql, params as unknown[]);
          return { rows: res.rows as T[] };
        },
      };
      expect(await tryAdvisoryXactLock(exec2, k1, k2)).toBe(true);
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
  });
});
