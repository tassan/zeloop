import { describe, expect, it } from "vitest";
import {
  createRegistry,
  createOutboxDispatcher,
  createOutboxWorker,
  type OutboxEvent,
  type OutboxHandler,
} from "./index.js";

describe("@zeloop/outbox", () => {
  it("exports createRegistry", () => {
    expect(createRegistry).toBeDefined();
    expect(typeof createRegistry).toBe("function");
  });

  it("createRegistry returns registry with get and list", () => {
    const handler: OutboxHandler = async () => {};
    const registry = createRegistry({ "user.created.v1": handler });
    expect(registry.get("user.created.v1")).toBe(handler);
    expect(registry.list()).toContain("user.created.v1");
  });

  it("exports createOutboxDispatcher", () => {
    expect(createOutboxDispatcher).toBeDefined();
    expect(typeof createOutboxDispatcher).toBe("function");
  });

  it("createOutboxDispatcher returns a handler function", () => {
    const registry = createRegistry({});
    const handler = createOutboxDispatcher({ registry });
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
  });

  it("exports createOutboxWorker", () => {
    expect(createOutboxWorker).toBeDefined();
    expect(typeof createOutboxWorker).toBe("function");
  });

  it("createOutboxWorker returns a Worker", () => {
    const stubSource = {
      claimBatch: async () => ({ items: [] as OutboxEvent[], ack: undefined }),
      complete: async () => {},
      retry: async () => {},
      fail: async () => {},
    };
    const worker = createOutboxWorker(stubSource, {
      id: "outbox",
      retryPolicy: { nextDelay: () => null },
      dispatcher: async () => {},
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
  });
});
