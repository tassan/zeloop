import { describe, expect, it } from "vitest";
import type { PgExecutor } from "./types.js";
import { advisoryKey, tryAdvisoryXactLock } from "./advisory.js";

describe("advisoryKey", () => {
  it("returns deterministic k1/k2 for same input", () => {
    const a = advisoryKey("my-job");
    const b = advisoryKey("my-job");
    expect(a).toEqual(b);
  });

  it("returns different values for different inputs", () => {
    const a = advisoryKey("job-a");
    const b = advisoryKey("job-b");
    expect(a).not.toEqual(b);
  });

  it("incorporates bucket when provided", () => {
    const a = advisoryKey("my-job", 1);
    const b = advisoryKey("my-job", 2);
    expect(a).not.toEqual(b);
  });

  it("returns 32-bit integers for k1 and k2", () => {
    const { k1, k2 } = advisoryKey("test-job");
    expect(Number.isInteger(k1)).toBe(true);
    expect(Number.isInteger(k2)).toBe(true);
    expect(k1).toBeGreaterThanOrEqual(-2147483648);
    expect(k1).toBeLessThanOrEqual(2147483647);
    expect(k2).toBeGreaterThanOrEqual(-2147483648);
    expect(k2).toBeLessThanOrEqual(2147483647);
  });

  it("uses bucket=0 by default (different from no-bucket)", () => {
    const withoutBucket = advisoryKey("job");
    const withBucket0 = advisoryKey("job", 0);
    // Without bucket and with bucket=0 should differ
    expect(withoutBucket).not.toEqual(withBucket0);
  });
});

describe("tryAdvisoryXactLock", () => {
  it("calls pg_try_advisory_xact_lock with k1 and k2", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const mockTx: PgExecutor = {
      async query<T>(sql: string, params?: readonly unknown[]) {
        queries.push({ sql, params: params ?? [] });
        return { rows: [{ acquired: true }] as T[] };
      },
    };

    await tryAdvisoryXactLock(mockTx, 123, 456);

    expect(queries.length).toBe(1);
    expect(queries[0].sql).toContain("pg_try_advisory_xact_lock");
    expect(queries[0].params).toContain(123);
    expect(queries[0].params).toContain(456);
  });

  it("returns true when lock acquired", async () => {
    const mockTx: PgExecutor = {
      async query<T>() {
        return { rows: [{ acquired: true }] as T[] };
      },
    };

    const result = await tryAdvisoryXactLock(mockTx, 1, 2);
    expect(result).toBe(true);
  });

  it("returns false when lock not acquired", async () => {
    const mockTx: PgExecutor = {
      async query<T>() {
        return { rows: [{ acquired: false }] as T[] };
      },
    };

    const result = await tryAdvisoryXactLock(mockTx, 1, 2);
    expect(result).toBe(false);
  });
});
