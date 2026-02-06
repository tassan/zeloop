# docs/invariants.md — Guarantees and limits

## What zeloop guarantees (under the canonical SQL contract)

1) **Exclusive claim per item**
- Claim uses `FOR UPDATE SKIP LOCKED`
- Update to `processing` happens in the same transaction

2) **Safe multi-worker concurrency**
- Multiple processes/containers can run the same worker against the same tables

3) **Deterministic retries**
- Retries are controlled by `attempts`, `max_attempts`, `available_at/run_at`

4) **Eventual recovery of stuck items (with reaper)**
- Items stuck in `processing` can be returned to `pending` after a timeout

5) **Global job coordination (with advisory locks)**
- Using `pg_try_advisory_xact_lock(k1,k2)` ensures a single leader per bucket

---

## What zeloop does NOT guarantee

1) **Exactly-once effects**
- Without idempotency, a crash between side-effect and `complete()` can duplicate effects

2) **Global ordering**
- Ordering is stable per claim query (`ORDER BY available_at, id`), but not total across workers

3) **Perfect fairness**
- `SKIP LOCKED` optimizes throughput; fairness is best-effort

4) **Forced cancellation of handler code**
- Handlers receive `AbortSignal`, but cancellation is cooperative

---

## Expected failure modes and mitigations

### Duplicate side effects
**Cause:** crash after external effect, before DB `complete()`.
**Mitigation:** idempotent handlers and/or idempotency store.

### Stuck `processing`
**Cause:** worker crash or wedged handler.
**Mitigation:** reaper + visibility timeout.

### Thundering herd polling costs
**Cause:** very short tick with empty queue.
**Mitigation:** `idleDelayMs`, backpressure (no overlap), smaller batches.

### Advisory lock leaks with pools
**Cause:** session advisory locks on pooled connections.
**Mitigation:** use transaction locks (`pg_try_advisory_xact_lock`).

---

## Tuning defaults (starting point)

- `batchSize`: 50
- `itemConcurrency`: 10
- `tickIntervalMs`: 250–1000
- `idleDelayMs`: 1000–5000
- `visibilityTimeoutSec`: 5–30 min (>= p99 handler time)
- reaper interval: 30–120s, limit 50–200
