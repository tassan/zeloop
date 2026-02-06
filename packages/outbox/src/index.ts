import { createWorker } from "@zeloop/core";
import type {
  BatchSource,
  RetryPolicy,
  Worker,
} from "@zeloop/core";
import { DeadLetterError } from "./dispatcher.js";
import type { OutboxEvent, OutboxHandler } from "./types.js";

export type {
  OutboxEvent,
  OutboxHandler,
  OutboxHandlerRegistry,
  OutboxErrorDecision,
  OutboxErrorPolicy,
  OutboxDispatcherOptions,
} from "./types.js";

export { createRegistry } from "./registry.js";
export { createOutboxDispatcher, DeadLetterError } from "./dispatcher.js";

export function createOutboxWorker(
  source: BatchSource<OutboxEvent, unknown>,
  opts: {
    id: string;
    retryPolicy: RetryPolicy;
    dispatcher: OutboxHandler;
    batchSize: number;
    itemConcurrency: number;
    tickIntervalMs: number;
    idleDelayMs: number;
    shutdownTimeoutMs: number;
  },
): Worker {
  // Wrap retryPolicy to handle DeadLetterError → fail immediately
  const wrappedRetryPolicy: RetryPolicy = {
    nextDelay(attempt, error, ctx) {
      if (error instanceof DeadLetterError) return null;
      return opts.retryPolicy.nextDelay(attempt, error, ctx);
    },
  };

  return createWorker({
    id: opts.id,
    source,
    handler: opts.dispatcher,
    retryPolicy: wrappedRetryPolicy,
    batchSize: opts.batchSize,
    itemConcurrency: opts.itemConcurrency,
    tickIntervalMs: opts.tickIntervalMs,
    idleDelayMs: opts.idleDelayMs,
    shutdownTimeoutMs: opts.shutdownTimeoutMs,
  });
}
