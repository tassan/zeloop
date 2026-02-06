export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  count(name: string, value?: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
}

export interface Span {
  setField(key: string, value: unknown): void;
  end(): void;
}

export interface Tracer {
  withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    fields?: Record<string, unknown>,
  ): Promise<T>;
}

export interface Telemetry {
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
}

export interface ZeloopContext {
  readonly runId: string;
  readonly loopId: string;
  readonly now: () => Date;
  readonly signal: AbortSignal;
  readonly telemetry: Telemetry;
}

export interface RetryPolicy {
  nextDelay(attempt: number, error: unknown, ctx: ZeloopContext): number | null;
}

export interface ClaimedBatch<TItem, TAck = unknown> {
  items: ReadonlyArray<TItem>;
  ack: TAck;
}

export interface BatchSource<TItem, TAck = unknown> {
  claimBatch(limit: number, ctx: ZeloopContext): Promise<ClaimedBatch<TItem, TAck>>;
  complete(ack: TAck, ctx: ZeloopContext): Promise<void>;
  retry(ack: TAck, error: unknown, delayMs: number, ctx: ZeloopContext): Promise<void>;
  fail(ack: TAck, error: unknown, ctx: ZeloopContext): Promise<void>;
}

export interface IdempotencyStore {
  tryBegin(key: string, ttlMs: number, ctx: ZeloopContext): Promise<"acquired" | "exists">;
  markCompleted(key: string, resultHash: string | null, ctx: ZeloopContext): Promise<void>;
}

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

export interface Worker {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  isRunning(): boolean;
}
