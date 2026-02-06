# docs/roadmap.md — Roadmap v0.1 → v1.0

## v0.1 — Working MVP
Goal: internal adoption-ready, small API surface, Postgres-only.

### @zeloop/core
- `ZeloopContext` (clock + abort + telemetry)
- `Telemetry` null-object (logger/metrics/tracer)
- `RetryPolicy` + `exponentialBackoff()` helper
- `BatchSource` (ack-based)
- `createWorker()`:
  - backpressure (no overlap / coalesce)
  - graceful shutdown with timeout
  - hooks

### @zeloop/postgres
- `PgExecutor`, `PgAdapter`
- `createPgOutboxSource()`
- `createPgOutboxReaperTask()`
- advisory helpers: `tryAdvisoryXactLock()`, `advisoryKey()`
- identifier safety (`assertSafeIdent`, `quoteIdent`)

### @zeloop/outbox
- `OutboxEvent`, `OutboxHandler`
- `createRegistry()`, `createOutboxDispatcher()`
- default error policy: unhandled event type => `dead` immediately (via `fail`)
- `createOutboxWorker()` helper

### Tests (required)
- Postgres testcontainers
- 2 workers / 1000 events: all processed
- crash simulation + reaper recovery
- scheduler global: N instances => 1 execution per bucket

### Docs (required)
- README
- `sql-contract.md`
- `invariants.md`

---

## v0.2 — Idempotency + hardening
- `createPgIdempotencyStore()` with TTL + steal for stuck `started`
- dispatcher integration with TTL
- standard metrics/log fields (see `docs/observability.md`)
- tuning guide

---

## v0.3 — Outbox plugin completeness
- optional dead-letter table integration (transactional insert on `dead`)
- error normalization (safe truncation, structured fields)
- versioning conventions for event types

---

## v0.5 — API freeze
- audit exports + defaults
- compatibility matrix (Node LTS, PG 14+)
- benchmarks (claim throughput)
- failure playbook

---

## v1.0 — Stable OSS
- semver strict
- complete docs + cookbook
- contribution policy + release automation
- `@zeloop/testing` helpers
