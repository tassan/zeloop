import { describe, expect, it, vi } from "vitest";
import type { ZeloopContext, IdempotencyStore } from "@zeloop/core";
import { createOutboxDispatcher, DeadLetterError } from "./dispatcher.js";
import { createRegistry } from "./registry.js";
import type { OutboxEvent } from "./types.js";

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

const sampleEvent: OutboxEvent = {
  id: "1",
  eventType: "user.created",
  payload: { userId: "abc" },
  attempts: 0,
  maxAttempts: 25,
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

describe("createOutboxDispatcher", () => {
  it("routes event to correct handler by eventType", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createRegistry({ "user.created": handler });
    const dispatcher = createOutboxDispatcher({ registry });

    await dispatcher(sampleEvent, stubCtx);

    expect(handler).toHaveBeenCalledWith(sampleEvent, stubCtx);
  });

  it("throws DeadLetterError for unhandled eventType (default policy)", async () => {
    const registry = createRegistry({});
    const dispatcher = createOutboxDispatcher({ registry });

    await expect(dispatcher(sampleEvent, stubCtx)).rejects.toThrow(
      DeadLetterError,
    );
  });

  it("re-throws handler errors with default throw policy", async () => {
    const error = new Error("handler failed");
    const handler = vi.fn().mockRejectedValue(error);
    const registry = createRegistry({ "user.created": handler });
    const dispatcher = createOutboxDispatcher({ registry });

    await expect(dispatcher(sampleEvent, stubCtx)).rejects.toThrow(error);
  });

  it("applies custom error policy for handler errors", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("fail"));
    const registry = createRegistry({ "user.created": handler });
    const dispatcher = createOutboxDispatcher({
      registry,
      errorPolicy: {
        decide: () => ({ type: "dead" }),
      },
    });

    await expect(dispatcher(sampleEvent, stubCtx)).rejects.toThrow(
      DeadLetterError,
    );
  });

  it("skips already-processed events when idempotency returns exists", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createRegistry({ "user.created": handler });
    const store: IdempotencyStore = {
      tryBegin: vi.fn().mockResolvedValue("exists"),
      markCompleted: vi.fn(),
    };
    const dispatcher = createOutboxDispatcher({
      registry,
      idempotency: {
        store,
        keyOf: (e) => e.id,
        ttlMs: 15000,
      },
    });

    await dispatcher(sampleEvent, stubCtx);

    expect(handler).not.toHaveBeenCalled();
  });

  it("calls idempotency markCompleted after successful handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createRegistry({ "user.created": handler });
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const store: IdempotencyStore = {
      tryBegin: vi.fn().mockResolvedValue("acquired"),
      markCompleted,
    };
    const dispatcher = createOutboxDispatcher({
      registry,
      idempotency: {
        store,
        keyOf: (e) => e.id,
        ttlMs: 15000,
      },
    });

    await dispatcher(sampleEvent, stubCtx);

    expect(handler).toHaveBeenCalledWith(sampleEvent, stubCtx);
    expect(markCompleted).toHaveBeenCalledWith("1", null, stubCtx);
  });

  it("uses resultHashOf when provided for idempotency", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createRegistry({ "user.created": handler });
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const store: IdempotencyStore = {
      tryBegin: vi.fn().mockResolvedValue("acquired"),
      markCompleted,
    };
    const dispatcher = createOutboxDispatcher({
      registry,
      idempotency: {
        store,
        keyOf: (e) => e.id,
        ttlMs: 15000,
        resultHashOf: () => "hash-123",
      },
    });

    await dispatcher(sampleEvent, stubCtx);

    expect(markCompleted).toHaveBeenCalledWith("1", "hash-123", stubCtx);
  });

  it("does not mark completed when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const registry = createRegistry({ "user.created": handler });
    const markCompleted = vi.fn();
    const store: IdempotencyStore = {
      tryBegin: vi.fn().mockResolvedValue("acquired"),
      markCompleted,
    };
    const dispatcher = createOutboxDispatcher({
      registry,
      idempotency: {
        store,
        keyOf: (e) => e.id,
        ttlMs: 15000,
      },
    });

    await expect(dispatcher(sampleEvent, stubCtx)).rejects.toThrow("boom");
    expect(markCompleted).not.toHaveBeenCalled();
  });
});
