import { describe, expect, it } from "vitest";
import type { ZeloopContext } from "@zeloop/core";
import type { PgExecutor, PgAdapter } from "./types.js";
import { createPgIdempotencyStore } from "./idempotency.js";

function createMockPg() {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const resultQueue: Array<{ rows: unknown[] }> = [];

  const executor: PgExecutor = {
    async query<T>(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, params: params ?? [] });
      const result = resultQueue.shift() ?? { rows: [] };
      return result as { rows: T[] };
    },
  };

  const adapter: PgAdapter = {
    async withTransaction<T>(fn: (tx: PgExecutor) => Promise<T>) {
      return fn(executor);
    },
  };

  return {
    queries,
    pushResult(rows: unknown[]) {
      resultQueue.push({ rows });
    },
    executor,
    adapter,
  };
}

const stubCtx: ZeloopContext = {
  runId: "test-run",
  loopId: "test-loop",
  now: () => new Date("2024-01-01T00:00:00Z"),
  signal: new AbortController().signal,
  telemetry: {
    logger: { info() {}, warn() {}, error() {} },
    metrics: { count() {}, gauge() {}, histogram() {} },
    tracer: {
      async withSpan<T>(_: string, fn: (s: never) => Promise<T>) {
        return fn({ setField() {}, end() {} } as never);
      },
    },
  },
};

describe("createPgIdempotencyStore", () => {
  describe("tryBegin", () => {
    it("inserts key and returns acquired on success", async () => {
      const mock = createMockPg();
      // INSERT succeeds (1 row inserted)
      mock.pushResult([{ key: "evt-123" }]);
      const store = createPgIdempotencyStore(mock.adapter, {
        startedTtlMs: 900_000,
      });

      const result = await store.tryBegin("evt-123", 900_000, stubCtx);

      expect(result).toBe("acquired");
      expect(mock.queries.length).toBeGreaterThanOrEqual(1);
      expect(mock.queries[0].sql).toContain("INSERT");
      expect(mock.queries[0].params).toContain("evt-123");
    });

    it("returns acquired when stealing a stale started key", async () => {
      const mock = createMockPg();
      // INSERT fails (0 rows - conflict)
      mock.pushResult([]);
      // Steal attempt succeeds (1 row updated)
      mock.pushResult([{ key: "evt-123" }]);
      const store = createPgIdempotencyStore(mock.adapter, {
        startedTtlMs: 900_000,
      });

      const result = await store.tryBegin("evt-123", 900_000, stubCtx);

      expect(result).toBe("acquired");
      expect(mock.queries.length).toBe(2);
      // Second query should be an UPDATE (steal)
      expect(mock.queries[1].sql).toContain("UPDATE");
      expect(mock.queries[1].sql).toContain("started");
    });

    it("returns exists when key is completed", async () => {
      const mock = createMockPg();
      // INSERT fails (0 rows - conflict)
      mock.pushResult([]);
      // Steal also fails (0 rows - key is completed, not stale started)
      mock.pushResult([]);
      const store = createPgIdempotencyStore(mock.adapter, {
        startedTtlMs: 900_000,
      });

      const result = await store.tryBegin("evt-123", 900_000, stubCtx);

      expect(result).toBe("exists");
    });

    it("uses custom table name", async () => {
      const mock = createMockPg();
      mock.pushResult([{ key: "k" }]);
      const store = createPgIdempotencyStore(mock.adapter, {
        table: "custom_idem",
        startedTtlMs: 900_000,
      });

      await store.tryBegin("k", 900_000, stubCtx);

      expect(mock.queries[0].sql).toContain('"custom_idem"');
    });
  });

  describe("markCompleted", () => {
    it("updates key status to completed", async () => {
      const mock = createMockPg();
      const store = createPgIdempotencyStore(mock.adapter, {
        startedTtlMs: 900_000,
      });

      await store.markCompleted("evt-123", "hash-abc", stubCtx);

      expect(mock.queries.length).toBe(1);
      const sql = mock.queries[0].sql;
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("completed");
      expect(mock.queries[0].params).toContain("evt-123");
      expect(mock.queries[0].params).toContain("hash-abc");
    });

    it("handles null resultHash", async () => {
      const mock = createMockPg();
      const store = createPgIdempotencyStore(mock.adapter, {
        startedTtlMs: 900_000,
      });

      await store.markCompleted("evt-123", null, stubCtx);

      expect(mock.queries[0].params).toContain(null);
    });
  });
});
