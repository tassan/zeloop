import type { ZeloopContext } from "@zeloop/core";
import type {
  OutboxEvent,
  OutboxHandler,
  OutboxErrorPolicy,
  OutboxDispatcherOptions,
} from "./types.js";

export class DeadLetterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeadLetterError";
  }
}

const defaultErrorPolicy: OutboxErrorPolicy = {
  decide(error: unknown, _event: OutboxEvent, _ctx: ZeloopContext) {
    if (
      error instanceof Error &&
      error.message.startsWith("No handler registered")
    ) {
      return { type: "dead" };
    }
    return { type: "throw" };
  },
};

export function createOutboxDispatcher(
  opts: OutboxDispatcherOptions,
): OutboxHandler {
  const { registry, idempotency } = opts;
  const errorPolicy = opts.errorPolicy ?? defaultErrorPolicy;

  return async (event: OutboxEvent, ctx: ZeloopContext): Promise<void> => {
    // 1. Check idempotency
    if (idempotency) {
      const key = idempotency.keyOf(event);
      const result = await idempotency.store.tryBegin(
        key,
        idempotency.ttlMs,
        ctx,
      );
      if (result === "exists") {
        return; // Already processed
      }
    }

    // 2. Find handler
    const handler = registry.get(event.eventType);

    if (!handler) {
      const unhandledError = new Error(
        `No handler registered for event type: ${event.eventType}`,
      );
      const decision = errorPolicy.decide(unhandledError, event, ctx);
      if (decision.type === "dead") {
        throw new DeadLetterError(unhandledError.message, {
          cause: unhandledError,
        });
      }
      throw unhandledError;
    }

    // 3. Call handler
    try {
      await handler(event, ctx);
    } catch (error) {
      const decision = errorPolicy.decide(error, event, ctx);
      if (decision.type === "dead") {
        throw new DeadLetterError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      // "throw" or "retry" → re-throw for worker to handle
      throw error;
    }

    // 4. Mark idempotency completed
    if (idempotency) {
      const key = idempotency.keyOf(event);
      const hash = idempotency.resultHashOf?.(event) ?? null;
      await idempotency.store.markCompleted(key, hash, ctx);
    }
  };
}
