import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { ZeloopContext } from "@zeloop/core";
import { createNoopTelemetry } from "@zeloop/core";
import { createPgOutboxReaperTask } from "../../reaper.js";
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
    loopId: "reaper-test",
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

describe("reaper", () => {
  it("requeues stuck processing items past visibility timeout", async () => {
    // Insert events and claim them
    await insertTestEvents(pool, 5);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();
    await source.claimBatch(10, ctx);

    // Simulate stuck: set processing_at to 10 minutes ago
    await pool.query(
      "UPDATE zeloop_outbox_events SET processing_at = now() - interval '10 minutes'",
    );

    // Run reaper with 5 minute visibility timeout
    const reaper = createPgOutboxReaperTask(adapter, {
      visibilityTimeoutSec: 300,
      limit: 100,
    });
    const count = await reaper(ctx);

    expect(count).toBe(5);
    expect(await countByStatus(pool, "pending")).toBe(5);
    expect(await countByStatus(pool, "processing")).toBe(0);
  });

  it("does not requeue items within visibility timeout", async () => {
    await insertTestEvents(pool, 5);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();
    await source.claimBatch(10, ctx);

    // processing_at is now() — within visibility timeout
    const reaper = createPgOutboxReaperTask(adapter, {
      visibilityTimeoutSec: 300,
      limit: 100,
    });
    const count = await reaper(ctx);

    expect(count).toBe(0);
    expect(await countByStatus(pool, "processing")).toBe(5);
  });

  it("respects limit parameter", async () => {
    await insertTestEvents(pool, 10);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();
    await source.claimBatch(10, ctx);

    await pool.query(
      "UPDATE zeloop_outbox_events SET processing_at = now() - interval '10 minutes'",
    );

    const reaper = createPgOutboxReaperTask(adapter, {
      visibilityTimeoutSec: 300,
      limit: 3,
    });
    const count = await reaper(ctx);

    expect(count).toBe(3);
    expect(await countByStatus(pool, "pending")).toBe(3);
    expect(await countByStatus(pool, "processing")).toBe(7);
  });

  it("requeued items can be claimed again", async () => {
    await insertTestEvents(pool, 3);
    const source = createPgOutboxSource(adapter);
    const ctx = makeCtx();
    await source.claimBatch(10, ctx);

    await pool.query(
      "UPDATE zeloop_outbox_events SET processing_at = now() - interval '10 minutes'",
    );

    const reaper = createPgOutboxReaperTask(adapter, {
      visibilityTimeoutSec: 300,
      limit: 100,
    });
    await reaper(ctx);

    // Now claim again
    const batch2 = await source.claimBatch(10, ctx);
    expect(batch2.items.length).toBe(3);

    await source.complete(batch2.ack, ctx);
    expect(await countByStatus(pool, "sent")).toBe(3);
  });
});
