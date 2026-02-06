import { describe, expect, it } from "vitest";
import {
  createWorker,
  createNoopTelemetry,
  exponentialBackoff,
  type BatchSource,
  type RetryPolicy,
} from "./index.js";

describe("@zeloop/core exports", () => {
  it("exports createWorker", () => {
    expect(createWorker).toBeDefined();
    expect(typeof createWorker).toBe("function");
  });

  it("exports createNoopTelemetry", () => {
    expect(createNoopTelemetry).toBeDefined();
    const t = createNoopTelemetry();
    expect(t.logger).toBeDefined();
    expect(t.metrics).toBeDefined();
    expect(t.tracer).toBeDefined();
  });

  it("exports exponentialBackoff", () => {
    expect(exponentialBackoff).toBeDefined();
    const policy = exponentialBackoff({ baseMs: 100, maxMs: 10000 });
    expect(policy.nextDelay(0, new Error(), {} as never)).toBe(100);
  });

  it("createWorker returns a Worker with start, stop, isRunning", () => {
    const stubSource: BatchSource<unknown, unknown> = {
      claimBatch: async () => ({ items: [], ack: undefined }),
      complete: async () => {},
      retry: async () => {},
      fail: async () => {},
    };
    const stubRetry: RetryPolicy = {
      nextDelay: () => null,
    };
    const worker = createWorker({
      id: "test",
      source: stubSource,
      handler: async () => {},
      retryPolicy: stubRetry,
      batchSize: 10,
      itemConcurrency: 1,
      tickIntervalMs: 100,
      idleDelayMs: 50,
      shutdownTimeoutMs: 5000,
    });
    expect(worker).toBeDefined();
    expect(worker.start).toBeDefined();
    expect(worker.stop).toBeDefined();
    expect(worker.isRunning).toBeDefined();
    expect(worker.isRunning()).toBe(false);
  });
});
