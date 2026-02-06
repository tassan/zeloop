import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createWorker } from "./worker.js";
import type {
  BatchSource,
  ClaimedBatch,
  RetryPolicy,
  Worker,
  WorkerHooks,
  ZeloopContext,
} from "./types.js";

// --- helpers ---

interface TestItem {
  id: string;
}

type TestAck = string;

function createStubSource(
  overrides?: Partial<BatchSource<TestItem, TestAck>>,
): BatchSource<TestItem, TestAck> {
  return {
    claimBatch: vi.fn(async (): Promise<ClaimedBatch<TestItem, TestAck>> => ({
      items: [],
      ack: "ack-empty",
    })),
    complete: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    ...overrides,
  };
}

function createStubRetryPolicy(
  overrides?: Partial<RetryPolicy>,
): RetryPolicy {
  return {
    nextDelay: vi.fn(() => null),
    ...overrides,
  };
}

function defaultOpts(overrides?: Record<string, unknown>) {
  return {
    id: "test-worker",
    source: createStubSource(),
    handler: vi.fn(async () => {}),
    retryPolicy: createStubRetryPolicy(),
    batchSize: 10,
    itemConcurrency: 5,
    tickIntervalMs: 10,
    idleDelayMs: 10,
    shutdownTimeoutMs: 1000,
    ...overrides,
  };
}

async function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- tests ---

describe("createWorker", () => {
  let worker: Worker;

  afterEach(async () => {
    if (worker?.isRunning()) {
      await worker.stop();
    }
  });

  it("calls claimBatch on each tick", async () => {
    const source = createStubSource();
    const opts = defaultOpts({ source, tickIntervalMs: 10, idleDelayMs: 5 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(60);
    await worker.stop();

    expect(source.claimBatch).toHaveBeenCalled();
    const callCount = (source.claimBatch as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("calls handler for each item in batch", async () => {
    const items: TestItem[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items, ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });
    const handler = vi.fn(async () => {});
    const opts = defaultOpts({ source, handler, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(50);
    await worker.stop();

    expect(handler).toHaveBeenCalledTimes(3);
    const handledIds = handler.mock.calls.map(
      (call: [TestItem, ZeloopContext]) => call[0].id,
    );
    expect(handledIds).toContain("a");
    expect(handledIds).toContain("b");
    expect(handledIds).toContain("c");
  });

  it("calls complete after all items succeed", async () => {
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items: [{ id: "x" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });
    const opts = defaultOpts({ source, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(50);
    await worker.stop();

    expect(source.complete).toHaveBeenCalledWith(
      "ack-1",
      expect.objectContaining({ loopId: "test-worker" }),
    );
  });

  it("calls retry when handler throws and retryPolicy returns delay", async () => {
    const error = new Error("handler failed");
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items: [{ id: "x" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });
    const handler = vi.fn(async () => {
      throw error;
    });
    const retryPolicy = createStubRetryPolicy({
      nextDelay: vi.fn(() => 5000),
    });
    const opts = defaultOpts({ source, handler, retryPolicy, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(50);
    await worker.stop();

    expect(retryPolicy.nextDelay).toHaveBeenCalled();
    expect(source.retry).toHaveBeenCalledWith(
      "ack-1",
      error,
      5000,
      expect.objectContaining({ loopId: "test-worker" }),
    );
    expect(source.complete).not.toHaveBeenCalledWith(
      "ack-1",
      expect.anything(),
    );
  });

  it("calls fail when retryPolicy returns null", async () => {
    const error = new Error("fatal");
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items: [{ id: "x" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });
    const handler = vi.fn(async () => {
      throw error;
    });
    const retryPolicy = createStubRetryPolicy({
      nextDelay: vi.fn(() => null),
    });
    const opts = defaultOpts({ source, handler, retryPolicy, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(50);
    await worker.stop();

    expect(source.fail).toHaveBeenCalledWith(
      "ack-1",
      error,
      expect.objectContaining({ loopId: "test-worker" }),
    );
    expect(source.complete).not.toHaveBeenCalledWith(
      "ack-1",
      expect.anything(),
    );
    expect(source.retry).not.toHaveBeenCalled();
  });

  it("respects itemConcurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let claimCount = 0;
    const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));

    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items, ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });

    const handler = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await waitMs(20);
      concurrent--;
    });

    const opts = defaultOpts({
      source,
      handler,
      itemConcurrency: 3,
      tickIntervalMs: 10,
    });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(200);
    await worker.stop();

    expect(handler).toHaveBeenCalledTimes(10);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("sleeps idleDelayMs on empty batch", async () => {
    const claimTimes: number[] = [];
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimTimes.push(Date.now());
        return { items: [], ack: "ack-empty" };
      }),
    });

    const opts = defaultOpts({
      source,
      tickIntervalMs: 5,
      idleDelayMs: 50,
    });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(180);
    await worker.stop();

    // With idleDelayMs=50, in 180ms we expect ~3-4 claims, not 30+
    expect(claimTimes.length).toBeGreaterThanOrEqual(2);
    expect(claimTimes.length).toBeLessThanOrEqual(6);
  });

  it("does not overlap ticks (backpressure)", async () => {
    let ticksRunning = 0;
    let maxTicksRunning = 0;
    let claimCount = 0;

    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        ticksRunning++;
        maxTicksRunning = Math.max(maxTicksRunning, ticksRunning);
        await waitMs(30);
        ticksRunning--;
        claimCount++;
        return { items: [{ id: String(claimCount) }], ack: `ack-${claimCount}` };
      }),
    });

    const opts = defaultOpts({
      source,
      tickIntervalMs: 5,
    });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(150);
    await worker.stop();

    // Should never have more than 1 tick running at a time
    expect(maxTicksRunning).toBe(1);
  });

  it("stops claiming on stop() and waits for inflight", async () => {
    let handlerStarted = false;
    let handlerFinished = false;
    let claimCount = 0;

    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items: [{ id: "slow" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });

    const handler = vi.fn(async () => {
      handlerStarted = true;
      await waitMs(100);
      handlerFinished = true;
    });

    const opts = defaultOpts({
      source,
      handler,
      tickIntervalMs: 5,
      shutdownTimeoutMs: 2000,
    });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(30);
    expect(handlerStarted).toBe(true);

    // stop() should wait for the inflight handler
    await worker.stop();
    expect(handlerFinished).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });

  it("fires hooks at correct lifecycle points", async () => {
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1)
          return { items: [{ id: "a" }, { id: "b" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });

    const hooks: WorkerHooks<TestItem> = {
      onTickStart: vi.fn(),
      onClaimed: vi.fn(),
      onItemStart: vi.fn(),
      onItemSuccess: vi.fn(),
      onItemError: vi.fn(),
      onBatchSuccess: vi.fn(),
      onBatchError: vi.fn(),
      onStop: vi.fn(),
    };

    const opts = defaultOpts({ source, hooks, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(50);
    await worker.stop("test-reason");

    expect(hooks.onTickStart).toHaveBeenCalled();
    expect(hooks.onClaimed).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ loopId: "test-worker" }),
    );
    expect(hooks.onItemStart).toHaveBeenCalledTimes(2);
    expect(hooks.onItemSuccess).toHaveBeenCalledTimes(2);
    expect(hooks.onItemError).not.toHaveBeenCalled();
    expect(hooks.onBatchSuccess).toHaveBeenCalled();
    expect(hooks.onBatchError).not.toHaveBeenCalled();
    expect(hooks.onStop).toHaveBeenCalledWith(
      "test-reason",
      expect.objectContaining({ loopId: "test-worker" }),
    );
  });

  it("fires onItemError and onBatchError when handler fails", async () => {
    const error = new Error("item-err");
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items: [{ id: "x" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });

    const hooks: WorkerHooks<TestItem> = {
      onItemError: vi.fn(),
      onBatchError: vi.fn(),
      onBatchSuccess: vi.fn(),
    };

    const handler = vi.fn(async () => {
      throw error;
    });

    const opts = defaultOpts({ source, handler, hooks, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(50);
    await worker.stop();

    expect(hooks.onItemError).toHaveBeenCalledWith(
      { id: "x" },
      error,
      expect.objectContaining({ loopId: "test-worker" }),
    );
    expect(hooks.onBatchError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ loopId: "test-worker" }),
    );
    expect(hooks.onBatchSuccess).not.toHaveBeenCalled();
  });

  it("provides abort signal in context that aborts on stop", async () => {
    let signalAborted = false;
    let claimCount = 0;
    const source = createStubSource({
      claimBatch: vi.fn(async () => {
        claimCount++;
        if (claimCount === 1) return { items: [{ id: "x" }], ack: "ack-1" };
        return { items: [], ack: "ack-empty" };
      }),
    });

    const handler = vi.fn(async (_item: TestItem, ctx: ZeloopContext) => {
      ctx.signal.addEventListener("abort", () => {
        signalAborted = true;
      });
      await waitMs(200);
    });

    const opts = defaultOpts({
      source,
      handler,
      tickIntervalMs: 5,
      shutdownTimeoutMs: 5000,
    });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(30);
    const stopPromise = worker.stop();
    await waitMs(10);
    expect(signalAborted).toBe(true);
    await stopPromise;
  });

  it("sets isRunning correctly", async () => {
    const opts = defaultOpts({ tickIntervalMs: 50 });
    worker = createWorker(opts);

    expect(worker.isRunning()).toBe(false);
    await worker.start();
    expect(worker.isRunning()).toBe(true);
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it("passes batchSize to claimBatch", async () => {
    const source = createStubSource();
    const opts = defaultOpts({ source, batchSize: 42, tickIntervalMs: 10 });
    worker = createWorker(opts);

    await worker.start();
    await waitMs(30);
    await worker.stop();

    expect(source.claimBatch).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ loopId: "test-worker" }),
    );
  });
});
