import type { IdempotencyStore, ZeloopContext } from "@zeloop/core";

export interface OutboxEvent<TPayload = unknown> {
  id: string;
  eventType: string;

  payload: TPayload;
  headers?: Record<string, unknown> | null;

  attempts: number;
  maxAttempts: number;

  aggregateType?: string | null;
  aggregateId?: string | null;

  createdAt: Date;
}

export type OutboxHandler<TPayload = unknown> = (
  event: OutboxEvent<TPayload>,
  ctx: ZeloopContext,
) => Promise<void>;

export interface OutboxHandlerRegistry {
  get(eventType: string): OutboxHandler | undefined;
  list(): string[];
}

export type OutboxErrorDecision =
  | { type: "retry" }
  | { type: "dead" }
  | { type: "throw" };

export interface OutboxErrorPolicy {
  decide(
    error: unknown,
    event: OutboxEvent,
    ctx: ZeloopContext,
  ): OutboxErrorDecision;
}

export interface OutboxDispatcherOptions {
  registry: OutboxHandlerRegistry;
  errorPolicy?: OutboxErrorPolicy;

  idempotency?: {
    store: IdempotencyStore;
    keyOf: (e: OutboxEvent) => string;
    ttlMs: number;
    resultHashOf?: (e: OutboxEvent) => string | null;
  };
}
