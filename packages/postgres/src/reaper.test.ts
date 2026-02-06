import { describe, expect, it } from "vitest";
import type { ZeloopContext } from "@zeloop/core";
import type { PgExecutor, PgAdapter } from "./types.js";
import { createPgOutboxReaperTask } from "./reaper.js";

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

describe("createPgOutboxReaperTask", () => {
  it("executes reaper SQL with FOR UPDATE SKIP LOCKED", async () => {
    const mock = createMockPg();
    mock.pushResult([{ id: "1" }, { id: "2" }]);
    const reaper = createPgOutboxReaperTask(mock.adapter, {
      visibilityTimeoutSec: 300,
      limit: 100,
    });

    await reaper(stubCtx);

    expect(mock.queries.length).toBe(1);
    const sql = mock.queries[0].sql;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'processing'");
    expect(sql).toContain("processing_at");
    expect(sql).toContain("status = 'pending'");
  });

  it("passes visibilityTimeoutSec and limit as parameters", async () => {
    const mock = createMockPg();
    mock.pushResult([]);
    const reaper = createPgOutboxReaperTask(mock.adapter, {
      visibilityTimeoutSec: 600,
      limit: 50,
    });

    await reaper(stubCtx);

    expect(mock.queries[0].params).toContain(600);
    expect(mock.queries[0].params).toContain(50);
  });

  it("returns count of requeued items", async () => {
    const mock = createMockPg();
    mock.pushResult([{ id: "1" }, { id: "2" }, { id: "3" }]);
    const reaper = createPgOutboxReaperTask(mock.adapter, {
      visibilityTimeoutSec: 300,
      limit: 100,
    });

    const count = await reaper(stubCtx);

    expect(count).toBe(3);
  });

  it("returns 0 when no stuck items", async () => {
    const mock = createMockPg();
    mock.pushResult([]);
    const reaper = createPgOutboxReaperTask(mock.adapter, {
      visibilityTimeoutSec: 300,
      limit: 100,
    });

    const count = await reaper(stubCtx);

    expect(count).toBe(0);
  });

  it("uses custom table name", async () => {
    const mock = createMockPg();
    mock.pushResult([]);
    const reaper = createPgOutboxReaperTask(mock.adapter, {
      table: "custom_outbox",
      visibilityTimeoutSec: 300,
      limit: 100,
    });

    await reaper(stubCtx);

    expect(mock.queries[0].sql).toContain('"custom_outbox"');
  });
});
