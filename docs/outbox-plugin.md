# docs/outbox-plugin.md — @zeloop/outbox (design)

This package provides an outbox dispatcher and registry on top of `@zeloop/core`.

## Canonical event type

```ts
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
```

## Handlers and registry

```ts
export type OutboxHandler<TPayload = unknown> =
  (event: OutboxEvent<TPayload>, ctx: import("@zeloop/core").ZeloopContext) => Promise<void>;

export interface OutboxHandlerRegistry {
  get(eventType: string): OutboxHandler | undefined;
  list(): string[];
}
```

Recommended default: `createRegistry({ "user.created.v1": handler, ... })`.

## Error policy

```ts
export type OutboxErrorDecision =
  | { type: "retry" }
  | { type: "dead" }
  | { type: "throw" };

export interface OutboxErrorPolicy {
  decide(error: unknown, event: OutboxEvent, ctx: ZeloopContext): OutboxErrorDecision;
}
```

Default recommendation:
- Unhandled event type => `dead` immediately (do not burn attempts)
- All other errors => `throw` (let worker retry policy decide)

## Idempotency (optional)

```ts
export interface IdempotencyStore {
  tryBegin(key: string, ttlMs: number, ctx: ZeloopContext): Promise<"acquired" | "exists">;
  markCompleted(key: string, resultHash: string | null, ctx: ZeloopContext): Promise<void>;
}
```

The dispatcher may be configured with:
- `keyOf(event)` deterministic key
- `ttlMs` for `started` expiry
- optional `resultHashOf(event)` for observability

## Dispatcher

```ts
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
```

`createOutboxDispatcher(opts)` returns a `OutboxHandler` compatible with the core worker.

## Helper: createOutboxWorker
A convenience factory that wires: source + dispatcher + retryPolicy into `createWorker()`.
