# docs/core-api.md — @zeloop/core public API (design)

This document defines the intended public API for the core worker engine.
The core package is DB-agnostic.

## Core types

### Execution context

```ts
export interface ZeloopContext {
  readonly runId: string;          // process lifetime id
  readonly loopId: string;         // logical worker id
  readonly now: () => Date;        // injectable clock
  readonly signal: AbortSignal;    // shutdown/cancel
  readonly telemetry: Telemetry;   // null-object by default
}
```

### Telemetry (optional)

```ts
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  count(name: string, value?: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
}

export interface Tracer {
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>, fields?: Record<string, unknown>): Promise<T>;
}

export interface Span {
  setField(key: string, value: unknown): void;
  end(): void;
}

export interface Telemetry {
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
}
```

### Retry policy

```ts
export interface RetryPolicy {
  nextDelay(attempt: number, error: unknown, ctx: ZeloopContext): number | null;
}
```

### Batch source

The core processes *batches* obtained from a `BatchSource`. The source encapsulates DB details.

```ts
export interface ClaimedBatch<TItem, TAck = unknown> {
  items: ReadonlyArray<TItem>;
  ack: TAck;            // opaque token for complete/retry/fail
}

export interface BatchSource<TItem, TAck = unknown> {
  claimBatch(limit: number, ctx: ZeloopContext): Promise<ClaimedBatch<TItem, TAck>>;
  complete(ack: TAck, ctx: ZeloopContext): Promise<void>;
  retry(ack: TAck, error: unknown, delayMs: number, ctx: ZeloopContext): Promise<void>;
  fail(ack: TAck, error: unknown, ctx: ZeloopContext): Promise<void>;
}
```

## Worker engine

### Hooks (optional)

```ts
export interface WorkerHooks<TItem> {
  onTickStart?: (ctx: ZeloopContext) => void;
  onClaimed?: (count: number, ctx: ZeloopContext) => void;

  onItemStart?: (item: TItem, ctx: ZeloopContext) => void;
  onItemSuccess?: (item: TItem, ctx: ZeloopContext) => void;
  onItemError?: (item: TItem, error: unknown, ctx: ZeloopContext) => void;

  onBatchSuccess?: (ctx: ZeloopContext) => void;
  onBatchError?: (error: unknown, ctx: ZeloopContext) => void;

  onStop?: (reason: string | undefined, ctx: ZeloopContext) => void;
}
```

### Worker options

```ts
export interface WorkerOptions<TItem, TAck> {
  id: string;

  source: BatchSource<TItem, TAck>;
  handler: (item: TItem, ctx: ZeloopContext) => Promise<void>;
  retryPolicy: RetryPolicy;

  batchSize: number;
  itemConcurrency: number;

  tickIntervalMs: number;
  idleDelayMs: number;

  shutdownTimeoutMs: number;

  telemetry?: Partial<Telemetry>;
  hooks?: WorkerHooks<TItem>;
}
```

### Worker interface

```ts
export interface Worker {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  isRunning(): boolean;
}
```

### Expected runtime semantics

- Backpressure: **no overlap** — if a tick is running, the next tick is coalesced (at most one pending).
- Empty claim sleeps `idleDelayMs`.
- On error:
  - handler errors bubble up to the worker
  - worker consults `retryPolicy.nextDelay(...)`
  - delay => `source.retry(ack, error, delayMs)`
  - null => `source.fail(ack, error)`
- Graceful shutdown:
  - stop() aborts the signal and stops claiming new work
  - waits for inflight handlers up to `shutdownTimeoutMs`
