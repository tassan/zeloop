import type { ZeloopContext } from "@zeloop/core";
import type { PgAdapter, PgReaperOptions } from "./types.js";
import { quoteIdent } from "./ident.js";

const DEFAULT_TABLE = "zeloop_outbox_events";

export function createPgOutboxReaperTask(
  pg: PgAdapter,
  opts: PgReaperOptions,
): (ctx: ZeloopContext) => Promise<number> {
  const table = quoteIdent(opts.table ?? DEFAULT_TABLE);

  return async (_ctx: ZeloopContext): Promise<number> => {
    return pg.withTransaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `WITH stuck AS (
  SELECT id
  FROM ${table}
  WHERE status = 'processing'
    AND processing_at < now() - ($1::int * interval '1 second')
  ORDER BY processing_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE ${table} e
SET status = 'pending',
    processing_at = NULL,
    updated_at = now()
FROM stuck
WHERE e.id = stuck.id
RETURNING e.id::text AS id`,
        [opts.visibilityTimeoutSec, opts.limit],
      );

      return result.rows.length;
    });
  };
}
