# docs/observability.md — Logging and metrics conventions

This document standardizes what `@zeloop/core` and related packages should emit.
Names should be stable once released (avoid churn).

## Logging fields (recommended)

Common:
- `runId`, `loopId`
- `tick` (monotonic counter)
- `batchSize`, `claimedCount`
- `attempts` (if item provides it)

Outbox:
- `itemId` (event id)
- `eventType`

Messages (suggested):
- `tick.start`, `tick.empty`, `batch.claimed`
- `item.start`, `item.ok`, `item.err`
- `batch.ok`, `batch.err`
- `shutdown.start`, `shutdown.done`

## Metrics (namespace: `zeloop.*`)

Counters:
- `zeloop.worker.tick_total{loopId}`
- `zeloop.worker.batch_claimed_total{loopId}`
- `zeloop.worker.item_ok_total{loopId}`
- `zeloop.worker.item_err_total{loopId}`
- `zeloop.worker.retry_total{loopId}`
- `zeloop.worker.dead_total{loopId}`

Histograms:
- `zeloop.worker.tick_duration_ms{loopId}`
- `zeloop.worker.batch_duration_ms{loopId}`
- `zeloop.worker.item_duration_ms{loopId}`

Gauges:
- `zeloop.worker.inflight{loopId}`

Postgres (optional):
- `zeloop.pg.tx_duration_ms`
- `zeloop.pg.query_duration_ms`

Reaper:
- `zeloop.reaper.reaped_total{loopId}`
