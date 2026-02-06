import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { ZeloopContext } from "@zeloop/core";
import { createNoopTelemetry } from "@zeloop/core";
import { createPgOutboxSource } from "../../outbox-source.js";
import type { PgAdapter } from "../../types.js";
import {
  startPostgres,
  stopPostgres,
  insertTestEvents,
  countByStatus,
  resetOutbox,
} from "./setup.js";

let pool: pg.Pool;
let adapter: PgAdapter;

function makeCtx(): ZeloopContext {
  return {
    runId: "test",
    loopId: "full-flow-test",
    now: () => new Date(),
    signal: new AbortController().signal,
    telemetry: createNoopTelemetry(),
  };
}

beforeAll(async () => {
  const pg = await startPostgres();
  pool = pg.pool;
  adapter = pg.adapter;
});

afterAll(async () => {
  await stopPostgres();
});

beforeEach(async () => {
  await resetOutbox(pool);
});

describe("outbox full flow", () => {
  it("claim → complete moves events to sent", async () => {
    await insertTestEvents(pool, 10);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    expect(batch.items.length).toBe(10);

    await source.complete(batch.ack, ctx);

    expect(await countByStatus(pool, "sent")).toBe(10);
    expect(await countByStatus(pool, "pending")).toBe(0);
    expect(await countByStatus(pool, "processing")).toBe(0);
  });

  it("claim → retry moves events back to pending with delay", async () => {
    await insertTestEvents(pool, 3);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    await source.retry(batch.ack, new Error("transient"), 5000, ctx);

    expect(await countByStatus(pool, "pending")).toBe(3);
    expect(await countByStatus(pool, "processing")).toBe(0);

    // Verify attempts incremented
    const result = await pool.query(
      "SELECT attempts, last_error FROM zeloop_outbox_events",
    );
    for (const row of result.rows) {
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("transient");
    }
  });

  it("claim → fail moves events to dead", async () => {
    await insertTestEvents(pool, 3);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    await source.fail(batch.ack, new Error("fatal"), ctx);

    expect(await countByStatus(pool, "dead")).toBe(3);
    expect(await countByStatus(pool, "pending")).toBe(0);
  });

  it("retry transitions to dead when max_attempts reached", async () => {
    // Insert event with max_attempts=1
    await pool.query(
      `INSERT INTO zeloop_outbox_events (event_type, payload, max_attempts)
       VALUES ('test', '{}', 1)`,
    );

    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    await source.retry(batch.ack, new Error("fail"), 1000, ctx);

    expect(await countByStatus(pool, "dead")).toBe(1);
    expect(await countByStatus(pool, "pending")).toBe(0);
  });

  it("fail with dead letters inserts into dead_letters table", async () => {
    await insertTestEvents(pool, 2, "important.event");
    const source = createPgOutboxSource(adapter, {
      deadLetter: { enabled: true },
    });
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    await source.fail(batch.ack, new Error("gone"), ctx);

    // Check dead letters table
    const dl = await pool.query(
      "SELECT source, event_type, last_error FROM zeloop_dead_letters ORDER BY id",
    );
    expect(dl.rows.length).toBe(2);
    expect(dl.rows[0].source).toBe("outbox");
    expect(dl.rows[0].event_type).toBe("important.event");
    expect(dl.rows[0].last_error).toBe("gone");
  });

  it("processes 100 events across multiple batches", async () => {
    await insertTestEvents(pool, 100);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    let totalProcessed = 0;
    while (totalProcessed < 100) {
      const batch = await source.claimBatch(25, ctx);
      if (batch.items.length === 0) break;
      await source.complete(batch.ack, ctx);
      totalProcessed += batch.items.length;
    }

    expect(totalProcessed).toBe(100);
    expect(await countByStatus(pool, "sent")).toBe(100);
  });
});
