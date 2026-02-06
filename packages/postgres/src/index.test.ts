import { describe, expect, it } from "vitest";
import {
  createPgOutboxSource,
  createPgOutboxReaperTask,
  createPgIdempotencyStore,
  advisoryKey,
  tryAdvisoryXactLock,
  assertSafeIdent,
  quoteIdent,
  type PgAdapter,
  type PgExecutor,
  type OutboxRow,
} from "./index.js";

describe("@zeloop/postgres exports", () => {
  it("exports createPgOutboxSource", () => {
    expect(createPgOutboxSource).toBeDefined();
    expect(typeof createPgOutboxSource).toBe("function");
  });

  it("createPgOutboxSource returns a BatchSource-shaped object", () => {
    const stubPg: PgAdapter = {
      withTransaction: async (fn) =>
        fn({ query: async () => ({ rows: [] }) } as PgExecutor),
    };
    const source = createPgOutboxSource(stubPg);
    expect(source.claimBatch).toBeDefined();
    expect(source.complete).toBeDefined();
    expect(source.retry).toBeDefined();
    expect(source.fail).toBeDefined();
  });

  it("exports createPgOutboxReaperTask and createPgIdempotencyStore", () => {
    expect(createPgOutboxReaperTask).toBeDefined();
    expect(createPgIdempotencyStore).toBeDefined();
  });

  it("exports advisoryKey and tryAdvisoryXactLock", () => {
    expect(advisoryKey).toBeDefined();
    expect(tryAdvisoryXactLock).toBeDefined();
    const key = advisoryKey("job");
    expect(key).toHaveProperty("k1");
    expect(key).toHaveProperty("k2");
  });

  it("exports assertSafeIdent and quoteIdent", () => {
    expect(assertSafeIdent).toBeDefined();
    expect(quoteIdent).toBeDefined();
  });

  it("exports OutboxRow type (structural check via source)", () => {
    const stubPg: PgAdapter = {
      withTransaction: async (fn) =>
        fn({ query: async () => ({ rows: [] }) } as PgExecutor),
    };
    const source = createPgOutboxSource(stubPg);
    // Type check: source returns OutboxRow items
    const _typeCheck: Promise<{
      items: ReadonlyArray<OutboxRow>;
      ack: { ids: readonly string[] };
    }> = source.claimBatch(1, {} as never);
    expect(_typeCheck).toBeDefined();
  });
});
