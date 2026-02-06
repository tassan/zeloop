# zeloop

[![CI](https://github.com/tassan/zeloop/actions/workflows/ci.yml/badge.svg)](https://github.com/tassan/zeloop/actions/workflows/ci.yml)
[![npm @zeloop/core](https://img.shields.io/npm/v/@zeloop/core?label=%40zeloop%2Fcore)](https://www.npmjs.com/package/@zeloop/core)
[![npm @zeloop/postgres](https://img.shields.io/npm/v/@zeloop/postgres?label=%40zeloop%2Fpostgres)](https://www.npmjs.com/package/@zeloop/postgres)
[![npm @zeloop/outbox](https://img.shields.io/npm/v/@zeloop/outbox?label=%40zeloop%2Foutbox)](https://www.npmjs.com/package/@zeloop/outbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A minimal async jobs & outbox framework for Node.js powered **only by Postgres**. No Redis, Kafka, RabbitMQ, or Temporal.

## Features

- **Transactional outbox** — `SELECT ... FOR UPDATE SKIP LOCKED` for exclusive, non-blocking batch claims
- **Loop-based worker engine** — backpressure (no-overlap coalesce), idle delay, configurable tick interval
- **Retry with exponential backoff** — `available_at` + `attempts` with configurable max attempts
- **Reaper** — recovers stuck `processing` items after a visibility timeout
- **Advisory locks** — transaction-scoped `pg_try_advisory_xact_lock` for global singleton jobs
- **Graceful shutdown** — cooperative cancellation via `AbortSignal` with configurable timeout
- **Safe multi-worker concurrency** — multiple workers can safely run against the same tables
- **Dead letter support** — unprocessable events are moved to a dead letter table
- **DB-agnostic core** — `@zeloop/core` has zero runtime dependencies; swap Postgres for any `BatchSource`

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [`@zeloop/core`](packages/core) | Worker engine, retry policy, telemetry (DB-agnostic) | `pnpm add @zeloop/core` |
| [`@zeloop/postgres`](packages/postgres) | Postgres adapter, outbox source, reaper, advisory locks | `pnpm add @zeloop/postgres` |
| [`@zeloop/outbox`](packages/outbox) | Outbox dispatcher, handler registry, error policy | `pnpm add @zeloop/outbox` |

## Install

```bash
pnpm add @zeloop/core @zeloop/postgres @zeloop/outbox
```

You also need a Postgres driver (e.g. `pg`):

```bash
pnpm add pg
```

## Quick Start

### 1. Apply migrations

Run the outbox DDL against your Postgres database. See [`docs/sql-contract.md`](docs/sql-contract.md) for the full schema.

```sql
CREATE TYPE zeloop_outbox_status AS ENUM ('pending', 'processing', 'sent', 'dead');

CREATE TABLE zeloop_outbox_events (
  id               bigserial PRIMARY KEY,
  event_type       text NOT NULL,
  aggregate_type   text NULL,
  aggregate_id     text NULL,
  payload          jsonb NOT NULL,
  headers          jsonb NULL,
  dedupe_key       text NULL,
  status           zeloop_outbox_status NOT NULL DEFAULT 'pending',
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 25,
  available_at     timestamptz NOT NULL DEFAULT now(),
  processing_at    timestamptz NULL,
  processed_at     timestamptz NULL,
  last_error       text NULL,
  last_error_at    timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zeloop_outbox_claim_idx
  ON zeloop_outbox_events (status, available_at, id)
  WHERE status IN ('pending', 'processing');
```

### 2. Create a PgAdapter

zeloop is driver-agnostic. Wrap any Postgres client that supports transactions:

```typescript
import pg from "pg";
import type { PgAdapter, PgExecutor } from "@zeloop/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const adapter: PgAdapter = {
  async withTransaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn({
        async query(sql, params) {
          const res = await client.query(sql, params as unknown[]);
          return { rows: res.rows };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
};
```

### 3. Register handlers and start the worker

```typescript
import { exponentialBackoff } from "@zeloop/core";
import { createPgOutboxSource } from "@zeloop/postgres";
import {
  createRegistry,
  createOutboxDispatcher,
  createOutboxWorker,
} from "@zeloop/outbox";

// Register handlers by event type
const registry = createRegistry({
  "order.created": async (event, ctx) => {
    console.log(`Processing order ${event.payload.orderId}`);
    // ... send email, call API, etc.
  },
  "order.shipped": async (event, ctx) => {
    console.log(`Order shipped: ${event.payload.trackingNumber}`);
  },
});

// Create the dispatcher (routes events to handlers)
const dispatcher = createOutboxDispatcher({ registry });

// Create the Postgres outbox source
const source = createPgOutboxSource(adapter);

// Create and start the worker
const worker = createOutboxWorker(source, {
  id: "outbox-worker",
  dispatcher,
  retryPolicy: exponentialBackoff({ baseMs: 1000, maxMs: 60_000 }),
  batchSize: 50,
  itemConcurrency: 10,
  tickIntervalMs: 500,
  idleDelayMs: 2000,
  shutdownTimeoutMs: 30_000,
});

await worker.start();
```

### 4. Graceful shutdown

```typescript
process.on("SIGINT", () => worker.stop("SIGINT"));
process.on("SIGTERM", () => worker.stop("SIGTERM"));
```

### 5. Insert outbox events

Insert events from your application code (typically inside a business transaction):

```sql
INSERT INTO zeloop_outbox_events (event_type, payload)
VALUES ('order.created', '{"orderId": "abc-123"}'::jsonb);
```

## Advanced

### Reaper

The reaper recovers events stuck in `processing` state (e.g. after a worker crash):

```typescript
import { createPgOutboxReaperTask } from "@zeloop/postgres";

const reap = createPgOutboxReaperTask(adapter, {
  visibilityTimeoutSec: 300, // 5 minutes
  limit: 100,
});

// Run on an interval
setInterval(async () => {
  const count = await reap(ctx);
  if (count > 0) console.log(`Reaped ${count} stuck events`);
}, 60_000);
```

### Advisory locks (global singleton jobs)

Ensure only one instance runs a scheduled job across all workers:

```typescript
import { advisoryKey, tryAdvisoryXactLock } from "@zeloop/postgres";

const { k1, k2 } = advisoryKey("daily-report");

await adapter.withTransaction(async (tx) => {
  const acquired = await tryAdvisoryXactLock(tx, k1, k2);
  if (!acquired) return; // another worker holds the lock

  // Run your singleton job here
});
```

### Custom retry policy

```typescript
import type { RetryPolicy } from "@zeloop/core";

const customRetry: RetryPolicy = {
  nextDelay(attempt, error, ctx) {
    if (attempt >= 5) return null; // give up after 5 attempts
    return 1000 * Math.pow(2, attempt); // exponential backoff
  },
};
```

### Custom error policy

```typescript
import type { OutboxErrorPolicy } from "@zeloop/outbox";

const errorPolicy: OutboxErrorPolicy = {
  decide(error, event, ctx) {
    // Permanent failures go straight to dead letter
    if (error instanceof TypeError) return { type: "dead" };
    // Everything else retries via the worker retry policy
    return { type: "throw" };
  },
};

const dispatcher = createOutboxDispatcher({ registry, errorPolicy });
```

### Dead letter table

Enable dead letter storage for failed events:

```typescript
const source = createPgOutboxSource(adapter, {
  deadLetter: { enabled: true },
});
```

See [`docs/sql-contract.md`](docs/sql-contract.md) for the `zeloop_dead_letters` DDL.

## Architecture

```
@zeloop/outbox ──→ @zeloop/core ←── @zeloop/postgres
     │                                      │
     └──────── no direct dependency ────────┘
```

- **`@zeloop/core`** is DB-agnostic. It defines `BatchSource`, `Worker`, `RetryPolicy`, and hooks. Zero runtime dependencies.
- **`@zeloop/postgres`** implements `BatchSource` for Postgres using `FOR UPDATE SKIP LOCKED`.
- **`@zeloop/outbox`** provides the dispatcher, handler registry, and error policy. It depends only on core.
- User code wires all three packages together.

## SQL Tables

| Table | Purpose |
|-------|---------|
| `zeloop_outbox_events` | Main outbox table with claim/retry/fail semantics |
| `zeloop_dead_letters` | Dead letter storage (recommended) |
| `zeloop_idempotency_keys` | Idempotency store with TTL + steal |
| `zeloop_jobs` | Generic job queue (optional) |

See [`docs/sql-contract.md`](docs/sql-contract.md) for canonical DDL and queries.

## Contributing

zeloop uses trunk-based development on `main` with [Conventional Commits](https://www.conventionalcommits.org/). See [`CLAUDE.md`](CLAUDE.md) for the full contributor guide covering TDD workflow, commit conventions, and package boundaries.

```bash
pnpm install          # install dependencies
pnpm run build        # build all packages
pnpm run test         # run unit tests
pnpm run test:integration  # run integration tests (requires Docker)
pnpm run lint         # lint
```

## License

[MIT](LICENSE)
