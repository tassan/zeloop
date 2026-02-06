# zeloop

A minimal async jobs & outbox framework for Node.js powered only by **Postgres**.

## What it is

**zeloop** provides execution primitives for:

- Outbox processing (transactional `SKIP LOCKED`)
- Loop-based schedulers
- Postgres advisory locks for global jobs
- Retry with backoff (`available_at` + `attempts`)
- Optional idempotency
- Graceful shutdown
- Safe concurrency across multiple workers/instances

## What it is not

- A queue engine (Kafka/RabbitMQ replacement)
- A workflow engine (Temporal replacement)
- A dashboard product

## Packages (proposed)

- `@zeloop/core` — worker engine + loop runner (DB-agnostic)
- `@zeloop/postgres` — Postgres adapter + SQL helpers + sources
- `@zeloop/outbox` — outbox dispatcher + handler registry
- `@zeloop/testing` — testcontainers helpers (roadmap)

## Docs

- `docs/sql-contract.md`
- `docs/invariants.md`
- `docs/roadmap.md`
- `docs/package-layout.md`
- `docs/core-api.md`
- `docs/outbox-plugin.md`
- `docs/postgres-adapter.md`
- `docs/observability.md`

## Quickstart (conceptual)

### 1) Apply migrations

Use the canonical SQL schema in `docs/sql-contract.md`:

- `zeloop_outbox_events`
- (optional) `zeloop_dead_letters`
- (optional) `zeloop_idempotency_keys`
- (optional) `zeloop_jobs`

### 2) Provide a Postgres adapter

zeloop needs only a `PgAdapter` (driver-agnostic).
See `docs/postgres-adapter.md`.

### 3) Define outbox handlers

Register handlers by `eventType` (`event_type` in DB).

### 4) Create dispatcher + source + worker

- dispatcher: `@zeloop/outbox`
- source: `@zeloop/postgres`
- worker engine: `@zeloop/core`

### 5) Start and shutdown

Use `SIGINT`/`SIGTERM` to stop gracefully.

> This README is intentionally minimal; the design details live in `docs/`.
