import type { BatchSource, ZeloopContext } from "@zeloop/core";
import type { PgAdapter, PgOutboxSourceOptions, OutboxAck, OutboxRow } from "./types.js";
import { quoteIdent } from "./ident.js";

const DEFAULT_TABLE = "zeloop_outbox_events";
const DEFAULT_DL_TABLE = "zeloop_dead_letters";
const DEFAULT_DL_SOURCE = "outbox";

interface RawOutboxRow {
  id: string;
  event_type: string;
  payload: unknown;
  headers: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  aggregate_type: string | null;
  aggregate_id: string | null;
  created_at: Date;
}

interface RetryResult {
  id: string;
  status: string;
}

function mapRow(row: RawOutboxRow): OutboxRow {
  return {
    id: String(row.id),
    eventType: row.event_type,
    payload: row.payload,
    headers: row.headers,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    aggregateType: row.aggregate_type ?? null,
    aggregateId: row.aggregate_id ?? null,
    createdAt: row.created_at,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createPgOutboxSource(
  pg: PgAdapter,
  opts?: PgOutboxSourceOptions,
): BatchSource<OutboxRow, OutboxAck> {
  const table = quoteIdent(opts?.table ?? DEFAULT_TABLE);
  const dlEnabled = opts?.deadLetter?.enabled === true;
  const dlTable = dlEnabled
    ? quoteIdent(opts?.deadLetter?.table ?? DEFAULT_DL_TABLE)
    : "";
  const dlSource = opts?.deadLetter?.sourceName ?? DEFAULT_DL_SOURCE;

  return {
    async claimBatch(
      limit: number,
      _ctx: ZeloopContext,
    ): Promise<{ items: ReadonlyArray<OutboxRow>; ack: OutboxAck }> {
      return pg.withTransaction(async (tx) => {
        const result = await tx.query<RawOutboxRow>(
          `WITH picked AS (
  SELECT id
  FROM ${table}
  WHERE status = 'pending'
    AND available_at <= now()
  ORDER BY available_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE ${table} e
SET status = 'processing',
    processing_at = now(),
    updated_at = now()
FROM picked
WHERE e.id = picked.id
RETURNING e.*`,
          [limit],
        );

        const items = result.rows.map(mapRow);
        const ids = items.map((item) => item.id);
        return { items, ack: { ids } };
      });
    },

    async complete(ack: OutboxAck, _ctx: ZeloopContext): Promise<void> {
      await pg.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE ${table}
SET status = 'sent',
    processed_at = now(),
    updated_at = now()
WHERE id::text = ANY($1::text[])
  AND status = 'processing'`,
          [ack.ids],
        );
      });
    },

    async retry(
      ack: OutboxAck,
      error: unknown,
      delayMs: number,
      _ctx: ZeloopContext,
    ): Promise<void> {
      await pg.withTransaction(async (tx) => {
        const result = await tx.query<RetryResult>(
          `UPDATE ${table}
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
RETURNING id::text AS id, status, attempts, available_at`,
          [ack.ids, delayMs, errorMessage(error)],
        );

        if (dlEnabled) {
          const deadIds = result.rows
            .filter((r) => r.status === "dead")
            .map((r) => r.id);
          if (deadIds.length > 0) {
            await insertDeadLetters(tx, table, dlTable, dlSource, deadIds, error);
          }
        }
      });
    },

    async fail(
      ack: OutboxAck,
      error: unknown,
      _ctx: ZeloopContext,
    ): Promise<void> {
      await pg.withTransaction(async (tx) => {
        if (dlEnabled) {
          await insertDeadLetters(
            tx,
            table,
            dlTable,
            dlSource,
            ack.ids as string[],
            error,
          );
        }

        await tx.query(
          `UPDATE ${table}
SET status = 'dead',
    last_error = $2,
    last_error_at = now(),
    processing_at = NULL,
    updated_at = now()
WHERE id::text = ANY($1::text[])
  AND status = 'processing'`,
          [ack.ids, errorMessage(error)],
        );
      });
    },
  };
}

async function insertDeadLetters(
  tx: import("./types.js").PgExecutor,
  outboxTable: string,
  dlTable: string,
  source: string,
  ids: readonly string[],
  error: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO ${dlTable} (source, source_id, event_type, payload, headers, attempts, last_error)
SELECT $1, e.id, e.event_type, e.payload, e.headers, e.attempts, $2
FROM ${outboxTable} e
WHERE e.id::text = ANY($3::text[])`,
    [source, errorMessage(error), ids],
  );
}
