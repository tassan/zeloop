import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { PgExecutor, PgAdapter } from "../../types.js";

const DDL = `
CREATE TYPE zeloop_outbox_status AS ENUM (
  'pending',
  'processing',
  'sent',
  'dead'
);

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

CREATE INDEX zeloop_outbox_type_idx
  ON zeloop_outbox_events (event_type, created_at);

CREATE UNIQUE INDEX zeloop_outbox_dedupe_key_ux
  ON zeloop_outbox_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE zeloop_dead_letters (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,
  source_id      bigint NOT NULL,
  event_type     text NULL,
  payload        jsonb NOT NULL,
  headers        jsonb NULL,
  attempts       int NOT NULL,
  last_error     text NULL,
  dead_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zeloop_dead_letters_dead_at_idx
  ON zeloop_dead_letters (dead_at);

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
`;

let container: StartedPostgreSqlContainer | null = null;
let pool: pg.Pool | null = null;

export async function startPostgres(): Promise<{
  pool: pg.Pool;
  adapter: PgAdapter;
}> {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("zeloop_test")
    .start();

  pool = new pg.Pool({
    connectionString: container.getConnectionUri(),
    max: 20,
  });

  await pool.query(DDL);

  const adapter = createPgAdapterFromPool(pool);
  return { pool, adapter };
}

export async function stopPostgres(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (container) {
    await container.stop();
    container = null;
  }
}

export function createPgAdapterFromPool(p: pg.Pool): PgAdapter {
  return {
    async withTransaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> {
      const client = await p.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(sql: string, params?: readonly unknown[]) {
            const res = await client.query(sql, params as unknown[]);
            return { rows: res.rows as R[] };
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
}

export async function insertTestEvents(
  p: pg.Pool,
  count: number,
  eventType = "test.event",
): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
    params.push(eventType, JSON.stringify({ index: i }), `agg-${i}`);
  }
  await p.query(
    `INSERT INTO zeloop_outbox_events (event_type, payload, aggregate_id)
     VALUES ${values.join(", ")}`,
    params,
  );
}

export async function countByStatus(
  p: pg.Pool,
  status: string,
): Promise<number> {
  const res = await p.query(
    "SELECT count(*)::int AS c FROM zeloop_outbox_events WHERE status = $1",
    [status],
  );
  return res.rows[0].c;
}

export async function resetOutbox(p: pg.Pool): Promise<void> {
  await p.query("DELETE FROM zeloop_dead_letters");
  await p.query("DELETE FROM zeloop_outbox_events");
  await p.query("DELETE FROM zeloop_idempotency_keys");
}
