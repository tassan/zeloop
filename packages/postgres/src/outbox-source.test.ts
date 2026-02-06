import { describe, expect, it } from "vitest";
import type { ZeloopContext } from "@zeloop/core";
import type { PgExecutor, PgAdapter } from "./types.js";
import { createPgOutboxSource } from "./outbox-source.js";

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

const sampleDbRow = {
  id: "42",
  event_type: "order.created",
  payload: { orderId: 123 },
  headers: { traceId: "abc" },
  attempts: 0,
  max_attempts: 25,
  aggregate_type: "order",
  aggregate_id: "123",
  created_at: new Date("2024-01-01T00:00:00Z"),
};

describe("createPgOutboxSource", () => {
  describe("claimBatch", () => {
    it("executes claim SQL with FOR UPDATE SKIP LOCKED", async () => {
      const mock = createMockPg();
      mock.pushResult([sampleDbRow]);
      const source = createPgOutboxSource(mock.adapter);

      await source.claimBatch(10, stubCtx);

      expect(mock.queries.length).toBe(1);
      const sql = mock.queries[0].sql;
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("available_at <= now()");
      expect(sql).toContain("LIMIT");
    });

    it("passes limit as parameter", async () => {
      const mock = createMockPg();
      mock.pushResult([]);
      const source = createPgOutboxSource(mock.adapter);

      await source.claimBatch(25, stubCtx);

      expect(mock.queries[0].params).toContain(25);
    });

    it("maps DB rows to OutboxRow with camelCase", async () => {
      const mock = createMockPg();
      mock.pushResult([sampleDbRow]);
      const source = createPgOutboxSource(mock.adapter);

      const batch = await source.claimBatch(10, stubCtx);

      expect(batch.items).toHaveLength(1);
      const item = batch.items[0];
      expect(item.id).toBe("42");
      expect(item.eventType).toBe("order.created");
      expect(item.payload).toEqual({ orderId: 123 });
      expect(item.headers).toEqual({ traceId: "abc" });
      expect(item.attempts).toBe(0);
      expect(item.maxAttempts).toBe(25);
      expect(item.aggregateType).toBe("order");
      expect(item.aggregateId).toBe("123");
      expect(item.createdAt).toEqual(new Date("2024-01-01T00:00:00Z"));
    });

    it("returns ack with claimed ids", async () => {
      const mock = createMockPg();
      mock.pushResult([sampleDbRow, { ...sampleDbRow, id: "43" }]);
      const source = createPgOutboxSource(mock.adapter);

      const batch = await source.claimBatch(10, stubCtx);

      expect(batch.ack.ids).toEqual(["42", "43"]);
    });

    it("returns empty batch when no rows", async () => {
      const mock = createMockPg();
      mock.pushResult([]);
      const source = createPgOutboxSource(mock.adapter);

      const batch = await source.claimBatch(10, stubCtx);

      expect(batch.items).toHaveLength(0);
      expect(batch.ack.ids).toEqual([]);
    });

    it("uses custom table name", async () => {
      const mock = createMockPg();
      mock.pushResult([]);
      const source = createPgOutboxSource(mock.adapter, {
        table: "custom_outbox",
      });

      await source.claimBatch(10, stubCtx);

      expect(mock.queries[0].sql).toContain('"custom_outbox"');
    });
  });

  describe("complete", () => {
    it("updates status to sent for given ids", async () => {
      const mock = createMockPg();
      const source = createPgOutboxSource(mock.adapter);
      const ack = { ids: ["1", "2", "3"] };

      await source.complete(ack, stubCtx);

      expect(mock.queries.length).toBe(1);
      const sql = mock.queries[0].sql;
      expect(sql).toContain("status = 'sent'");
      expect(sql).toContain("processed_at");
      expect(mock.queries[0].params).toEqual([["1", "2", "3"]]);
    });
  });

  describe("retry", () => {
    it("executes retry SQL with delay and error message", async () => {
      const mock = createMockPg();
      mock.pushResult([]); // retry returns no dead items
      const source = createPgOutboxSource(mock.adapter);
      const ack = { ids: ["1"] };
      const error = new Error("timeout");

      await source.retry(ack, error, 5000, stubCtx);

      expect(mock.queries.length).toBeGreaterThanOrEqual(1);
      const sql = mock.queries[0].sql;
      expect(sql).toContain("attempts + 1 >= max_attempts");
      expect(sql).toContain("RETURNING");
      expect(mock.queries[0].params[0]).toEqual(["1"]);
      expect(mock.queries[0].params[1]).toBe(5000);
      expect(mock.queries[0].params[2]).toBe("timeout");
    });
  });

  describe("fail", () => {
    it("sets status to dead immediately", async () => {
      const mock = createMockPg();
      const source = createPgOutboxSource(mock.adapter);
      const ack = { ids: ["1", "2"] };
      const error = new Error("unrecoverable");

      await source.fail(ack, error, stubCtx);

      const sql = mock.queries[0].sql;
      expect(sql).toContain("status = 'dead'");
      expect(sql).toContain("last_error");
      expect(mock.queries[0].params[0]).toEqual(["1", "2"]);
      expect(mock.queries[0].params[1]).toBe("unrecoverable");
    });

    it("inserts dead letter when enabled", async () => {
      const mock = createMockPg();
      mock.pushResult([]); // dead letter insert result
      mock.pushResult([]); // fail update result
      const source = createPgOutboxSource(mock.adapter, {
        deadLetter: { enabled: true },
      });
      const ack = { ids: ["1"] };
      const error = new Error("fatal");

      await source.fail(ack, error, stubCtx);

      expect(mock.queries.length).toBe(2);
      const dlSql = mock.queries[0].sql;
      expect(dlSql).toContain("zeloop_dead_letters");
      expect(dlSql).toContain("INSERT");
    });

    it("does not insert dead letter when disabled", async () => {
      const mock = createMockPg();
      const source = createPgOutboxSource(mock.adapter);
      const ack = { ids: ["1"] };

      await source.fail(ack, new Error("err"), stubCtx);

      expect(mock.queries.length).toBe(1);
      expect(mock.queries[0].sql).not.toContain("dead_letters");
    });
  });

  describe("retry with dead letters", () => {
    it("inserts dead letter for items that went dead", async () => {
      const mock = createMockPg();
      // retry RETURNING shows id=1 went dead
      mock.pushResult([{ id: "1", status: "dead", attempts: 25 }]);
      mock.pushResult([]); // dead letter insert
      const source = createPgOutboxSource(mock.adapter, {
        deadLetter: { enabled: true },
      });
      const ack = { ids: ["1"] };

      await source.retry(ack, new Error("err"), 5000, stubCtx);

      expect(mock.queries.length).toBe(2);
      const dlSql = mock.queries[1].sql;
      expect(dlSql).toContain("dead_letters");
      expect(dlSql).toContain("INSERT");
    });

    it("skips dead letter insert when no items went dead", async () => {
      const mock = createMockPg();
      // retry RETURNING shows id=1 went back to pending
      mock.pushResult([{ id: "1", status: "pending", attempts: 1 }]);
      const source = createPgOutboxSource(mock.adapter, {
        deadLetter: { enabled: true },
      });
      const ack = { ids: ["1"] };

      await source.retry(ack, new Error("err"), 5000, stubCtx);

      // Only the retry query, no dead letter insert
      expect(mock.queries.length).toBe(1);
    });

    it("uses custom dead letter table name", async () => {
      const mock = createMockPg();
      mock.pushResult([{ id: "1", status: "dead", attempts: 25 }]);
      mock.pushResult([]);
      const source = createPgOutboxSource(mock.adapter, {
        deadLetter: { enabled: true, table: "custom_dl", sourceName: "myapp" },
      });
      const ack = { ids: ["1"] };

      await source.retry(ack, new Error("err"), 5000, stubCtx);

      const dlSql = mock.queries[1].sql;
      expect(dlSql).toContain('"custom_dl"');
    });
  });
});
