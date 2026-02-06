import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { ZeloopContext } from "@zeloop/core";
import { createNoopTelemetry } from "@zeloop/core";
import { createPgOutboxSource } from "../../outbox-source.js";
import type { PgAdapter } from "../../types.js";
import {
  startPostgres,
  stopPostgres,
  createPgAdapterFromPool,
  insertTestEvents,
  resetOutbox,
} from "./setup.js";

let pool: pg.Pool;
let adapter: PgAdapter;

function makeCtx(): ZeloopContext {
  return {
    runId: "test",
    loopId: "claim-test",
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

describe("outbox claim (SKIP LOCKED)", () => {
  it("two concurrent claims do not overlap", async () => {
    await insertTestEvents(pool, 20);

    const source1 = createPgOutboxSource(adapter);
    const source2 = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    // Claim simultaneously from two sources
    const [batch1, batch2] = await Promise.all([
      source1.claimBatch(10, ctx),
      source2.claimBatch(10, ctx),
    ]);

    // Total claimed should be 20 (all events), no overlap
    const ids1 = new Set(batch1.items.map((i) => i.id));
    const ids2 = new Set(batch2.items.map((i) => i.id));

    expect(batch1.items.length + batch2.items.length).toBe(20);
    for (const id of ids1) {
      expect(ids2.has(id)).toBe(false);
    }
  });

  it("claims respect batch size limit", async () => {
    await insertTestEvents(pool, 30);

    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    expect(batch.items.length).toBe(10);
    expect(batch.ack.ids.length).toBe(10);
  });

  it("claimed items have processing status", async () => {
    await insertTestEvents(pool, 5);

    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    await source.claimBatch(10, ctx);

    const result = await pool.query(
      "SELECT status::text FROM zeloop_outbox_events",
    );
    for (const row of result.rows) {
      expect(row.status).toBe("processing");
    }
  });

  it("maps outbox rows correctly", async () => {
    await insertTestEvents(pool, 1, "order.created");

    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();

    const batch = await source.claimBatch(10, ctx);
    const item = batch.items[0];

    expect(item.id).toBeDefined();
    expect(item.eventType).toBe("order.created");
    expect(item.payload).toEqual({ index: 0 });
    expect(item.attempts).toBe(0);
    expect(item.maxAttempts).toBe(25);
    expect(item.aggregateId).toBe("agg-0");
    expect(item.createdAt).toBeInstanceOf(Date);
  });
});
