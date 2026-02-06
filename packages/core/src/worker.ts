import { mergeTelemetry } from "./telemetry.js";
import type {
  Worker,
  WorkerOptions,
  ZeloopContext,
} from "./types.js";

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<{ errors: Array<{ item: T; error: unknown }> }> {
  const errors: Array<{ item: T; error: unknown }> = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        await fn(item);
      } catch (error) {
        errors.push({ item, error });
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    next(),
  );
  await Promise.all(workers);
  return { errors };
}

export function createWorker<TItem, TAck>(
  options: WorkerOptions<TItem, TAck>,
): Worker {
  const {
    id,
    source,
    handler,
    retryPolicy,
    batchSize,
    itemConcurrency,
    tickIntervalMs,
    idleDelayMs,
    shutdownTimeoutMs,
    hooks,
  } = options;

  const telemetry = mergeTelemetry(options.telemetry);
  const runId = randomId();

  let running = false;
  let abortController: AbortController | null = null;
  let tickInProgress = false;
  let tickPending = false;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let inflightPromise: Promise<void> | null = null;
  let stopResolve: (() => void) | null = null;

  function createContext(): ZeloopContext {
    return {
      runId,
      loopId: id,
      now: () => new Date(),
      signal: abortController!.signal,
      telemetry,
    };
  }

  async function processTick(): Promise<void> {
    if (!running) return;

    tickInProgress = true;
    const ctx = createContext();

    try {
      hooks?.onTickStart?.(ctx);

      const batch = await source.claimBatch(batchSize, ctx);
      const { items, ack } = batch;

      if (items.length === 0) {
        hooks?.onClaimed?.(0, ctx);
        await sleep(idleDelayMs);
        return;
      }

      hooks?.onClaimed?.(items.length, ctx);

      const { errors } = await runWithConcurrency(
        items,
        itemConcurrency,
        async (item) => {
          hooks?.onItemStart?.(item, ctx);
          try {
            await handler(item, ctx);
            hooks?.onItemSuccess?.(item, ctx);
          } catch (error) {
            hooks?.onItemError?.(item, error, ctx);
            throw error;
          }
        },
      );

      if (errors.length === 0) {
        await source.complete(ack, ctx);
        hooks?.onBatchSuccess?.(ctx);
      } else {
        const firstError = errors[0].error;
        const delay = retryPolicy.nextDelay(0, firstError, ctx);

        if (delay !== null) {
          await source.retry(ack, firstError, delay, ctx);
        } else {
          await source.fail(ack, firstError, ctx);
        }
        hooks?.onBatchError?.(firstError, ctx);
      }
    } catch (error) {
      telemetry.logger.error("tick error", { error, loopId: id });
    } finally {
      tickInProgress = false;
      scheduleNextTick();
    }
  }

  function scheduleNextTick(): void {
    if (!running) {
      finishStop();
      return;
    }

    if (tickPending) {
      tickPending = false;
      inflightPromise = processTick();
      return;
    }

    tickTimer = setTimeout(() => {
      tickTimer = null;
      if (!running) {
        finishStop();
        return;
      }
      inflightPromise = processTick();
    }, tickIntervalMs);
  }

  function requestTick(): void {
    if (!running) return;

    if (tickInProgress) {
      tickPending = true;
      return;
    }

    if (tickTimer !== null) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }

    inflightPromise = processTick();
  }

  function finishStop(): void {
    if (stopResolve) {
      stopResolve();
      stopResolve = null;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (abortController) {
        abortController.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      abortController = new AbortController();
      requestTick();
    },

    async stop(reason?: string): Promise<void> {
      if (!running) return;
      running = false;

      if (tickTimer !== null) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }

      abortController?.abort();

      if (tickInProgress && inflightPromise) {
        await Promise.race([
          inflightPromise,
          sleep(shutdownTimeoutMs),
        ]);
      }

      hooks?.onStop?.(reason, createContext());
    },

    isRunning(): boolean {
      return running;
    },
  };
}
