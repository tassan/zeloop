# docs/postgres-adapter.md — @zeloop/postgres (design)

This package provides Postgres-only adapters and canonical SQL helpers.
It is compatible with any Postgres driver via a minimal adapter interface.

## Minimal contracts

```ts
export interface PgExecutor {
  query<T = any>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface PgAdapter {
  withTransaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>;
}
```

## Identifier safety

Because the adapter may accept configurable table names, `@zeloop/postgres` should:

- validate identifiers (allow `[a-zA-Z0-9_.]`)
- quote schema/table parts safely (`"schema"."table"`)

Identifiers must **not** come from untrusted end-user input.

## Outbox source

```ts
export interface PgOutboxSourceOptions {
  table?: string; // default "zeloop_outbox_events"
  deadLetter?: {
    enabled: boolean;
    table?: string; // default "zeloop_dead_letters"
    sourceName?: string; // default "outbox"
  };
}

export interface OutboxAck {
  ids: readonly string[]; // outbox ids as text
}

export function createPgOutboxSource(
  pg: PgAdapter,
  opts?: PgOutboxSourceOptions
): import("@zeloop/core").BatchSource<import("@zeloop/outbox").OutboxEvent, OutboxAck>;
```

### Notes

- Prefer returning `id::text` and operating with `WHERE id::text = ANY($1::text[])` to avoid JS bigint issues.
- Dead-letter insertion (if enabled) is best done in the same transaction as `fail()` / `retry()->dead`.

## Reaper task

A helper that requeues stuck `processing` items:

```ts
export interface PgReaperOptions {
  table?: string;
  visibilityTimeoutSec: number;
  limit: number;
}

export function createPgOutboxReaperTask(
  pg: PgAdapter,
  opts: PgReaperOptions
): (ctx: import("@zeloop/core").ZeloopContext) => Promise<number>;
```

## Idempotency store (TTL + steal)

```ts
export interface PgIdempotencyStoreOptions {
  table?: string; // default "zeloop_idempotency_keys"
  startedTtlMs: number; // e.g. 15 minutes
}

export function createPgIdempotencyStore(
  pg: PgAdapter,
  opts: PgIdempotencyStoreOptions
): import("@zeloop/outbox").IdempotencyStore;
```

Canonical algorithm:

1. Try insert `(key, started)`; if inserted => acquired
2. Else try steal if `status=started` and `created_at` older than ttl; if updated => acquired
3. Else => exists

## Advisory locks (global jobs)

```ts
export function advisoryKey(jobName: string, bucket?: number): { k1: number; k2: number };

export async function tryAdvisoryXactLock(tx: PgExecutor, k1: number, k2: number): Promise<boolean>;
```

Use `pg_try_advisory_xact_lock(k1,k2)` to avoid pool leak issues.
