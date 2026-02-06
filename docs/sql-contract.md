# zeloop — SQL Contract (canonical)

This document defines the canonical relational contract for the `@zeloop/postgres` package.
The `@zeloop/core` package does **not** require Postgres. It only assumes that a `BatchSource`
implementation can provide the invariants described in `docs/invariants.md`.

## 0) General rules

- Postgres only. No Redis / Kafka / RabbitMQ / Temporal.
- All timestamps are `timestamptz`.
- Claim pattern uses `SELECT ... FOR UPDATE SKIP LOCKED`.
- Retries use `available_at` + `attempts`.
- Multiple workers can safely run against the same tables.

---

## 1) Outbox table: `zeloop_outbox_events`

### 1.1 Status semantics

- `pending`: eligible when `available_at <= now()`
- `processing`: claimed and in progress
- `sent`: completed successfully (terminal)
- `dead`: terminal failure / exceeded attempts (terminal)

### 1.2 DDL

```sql
CREATE TYPE zeloop_outbox_status AS ENUM (
  'pending',
  'processing',
  'sent',
  'dead'
);

CREATE TABLE zeloop_outbox_events (
  id               bigserial PRIMARY KEY,

  -- routing
  event_type       text NOT NULL,
  aggregate_type   text NULL,
  aggregate_id     text NULL,

  -- payload
  payload          jsonb NOT NULL,
  headers          jsonb NULL,

  -- optional enqueue-time dedupe (does not replace idempotency store)
  dedupe_key       text NULL,

  -- retry + state
  status           zeloop_outbox_status NOT NULL DEFAULT 'pending',
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 25,

  available_at     timestamptz NOT NULL DEFAULT now(),
  processing_at    timestamptz NULL,
  processed_at     timestamptz NULL,

  -- error tracking
  last_error       text NULL,
  last_error_at    timestamptz NULL,

  -- audit
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

### 1.3 Required indexes

```sql
CREATE INDEX zeloop_outbox_claim_idx
  ON zeloop_outbox_events (status, available_at, id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX zeloop_outbox_type_idx
  ON zeloop_outbox_events (event_type, created_at);

CREATE UNIQUE INDEX zeloop_outbox_dedupe_key_ux
  ON zeloop_outbox_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
```

### 1.4 Canonical claim (`claimBatch`) query

```sql
WITH picked AS (
  SELECT id
  FROM zeloop_outbox_events
  WHERE status = 'pending'
    AND available_at <= now()
  ORDER BY available_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE zeloop_outbox_events e
SET status = 'processing',
    processing_at = now(),
    updated_at = now()
FROM picked
WHERE e.id = picked.id
RETURNING e.*;
```

### 1.5 Complete / retry / fail

**Complete (terminal success):**
```sql
UPDATE zeloop_outbox_events
SET status = 'sent',
    processed_at = now(),
    updated_at = now()
WHERE id::text = ANY($1::text[])
  AND status = 'processing';
```

**Retry (pending again or dead):**
```sql
UPDATE zeloop_outbox_events
SET status = CASE
               WHEN attempts + 1 >= max_attempts THEN 'dead'
               ELSE 'pending'
             END,
    attempts = attempts + 1,
    available_at = CASE
                     WHEN attempts + 1 >= max_attempts THEN available_at
                     ELSE now() + ($2::int * interval '1 millisecond')
                   END,
    last_error = $3,
    last_error_at = now(),
    processing_at = NULL,
    updated_at = now()
WHERE id::text = ANY($1::text[])
  AND status = 'processing'
RETURNING id::text AS id, status, attempts, available_at;
```

**Fail (dead immediately):**
```sql
UPDATE zeloop_outbox_events
SET status = 'dead',
    last_error = $2,
    last_error_at = now(),
    processing_at = NULL,
    updated_at = now()
WHERE id::text = ANY($1::text[])
  AND status = 'processing';
```

### 1.6 Recovery: reaper for stuck `processing`

Use `visibility_timeout` (seconds). Requeue stuck items:

```sql
WITH stuck AS (
  SELECT id
  FROM zeloop_outbox_events
  WHERE status = 'processing'
    AND processing_at < now() - ($1::int * interval '1 second')
  ORDER BY processing_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE zeloop_outbox_events e
SET status = 'pending',
    processing_at = NULL,
    updated_at = now()
FROM stuck
WHERE e.id = stuck.id
RETURNING e.id::text AS id;
```

> Reaper does not guarantee no duplication. Use idempotent handlers and/or `zeloop_idempotency_keys`.

---

## 2) Dead letters (recommended): `zeloop_dead_letters`

```sql
CREATE TABLE zeloop_dead_letters (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,     -- e.g. 'outbox'
  source_id      bigint NOT NULL,   -- outbox id
  event_type     text NULL,
  payload        jsonb NOT NULL,
  headers        jsonb NULL,
  attempts       int NOT NULL,
  last_error     text NULL,
  dead_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zeloop_dead_letters_dead_at_idx
  ON zeloop_dead_letters (dead_at);
```

---

## 3) Idempotency store: `zeloop_idempotency_keys`

```sql
CREATE TYPE zeloop_idem_status AS ENUM ('started', 'completed');

CREATE TABLE zeloop_idempotency_keys (
  key            text PRIMARY KEY,
  status         zeloop_idem_status NOT NULL DEFAULT 'started',
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz NULL,
  result_hash    text NULL
);

CREATE INDEX zeloop_idempotency_created_idx
  ON zeloop_idempotency_keys (created_at);
```

---

## 4) Generic job queue (optional): `zeloop_jobs`

```sql
CREATE TYPE zeloop_job_status AS ENUM (
  'pending',
  'processing',
  'done',
  'dead'
);

CREATE TABLE zeloop_jobs (
  id              bigserial PRIMARY KEY,
  job_type        text NOT NULL,
  payload         jsonb NOT NULL,

  status          zeloop_job_status NOT NULL DEFAULT 'pending',
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 25,

  run_at          timestamptz NOT NULL DEFAULT now(),
  processing_at   timestamptz NULL,
  done_at         timestamptz NULL,

  last_error      text NULL,
  last_error_at   timestamptz NULL,

  dedupe_key      text NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zeloop_jobs_claim_idx
  ON zeloop_jobs (status, run_at, id)
  WHERE status IN ('pending', 'processing');

CREATE UNIQUE INDEX zeloop_jobs_dedupe_key_ux
  ON zeloop_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
```

---

## 5) Advisory locks (global jobs)

Prefer transaction locks:

```sql
SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired;
```

Derive `(k1, k2)` deterministically from `jobName` + optional time bucket.
