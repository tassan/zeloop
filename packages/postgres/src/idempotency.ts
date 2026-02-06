import type { IdempotencyStore, ZeloopContext } from "@zeloop/core";
import type { PgAdapter, PgIdempotencyStoreOptions } from "./types.js";
import { quoteIdent } from "./ident.js";

const DEFAULT_TABLE = "zeloop_idempotency_keys";

export function createPgIdempotencyStore(
  pg: PgAdapter,
  opts: PgIdempotencyStoreOptions,
): IdempotencyStore {
  const table = quoteIdent(opts.table ?? DEFAULT_TABLE);

  return {
    async tryBegin(
      key: string,
      ttlMs: number,
      _ctx: ZeloopContext,
    ): Promise<"acquired" | "exists"> {
      return pg.withTransaction(async (tx) => {
        // Step 1: Try insert
        const inserted = await tx.query<{ key: string }>(
          `INSERT INTO ${table} (key, status, created_at)
VALUES ($1, 'started', now())
ON CONFLICT (key) DO NOTHING
RETURNING key`,
          [key],
        );

        if (inserted.rows.length > 0) {
          return "acquired";
        }

        // Step 2: Try steal stale started key
        const stolen = await tx.query<{ key: string }>(
          `UPDATE ${table}
SET status = 'started',
    created_at = now(),
    completed_at = NULL,
    result_hash = NULL
WHERE key = $1
  AND status = 'started'
  AND created_at < now() - ($2::int * interval '1 millisecond')
RETURNING key`,
          [key, ttlMs],
        );

        if (stolen.rows.length > 0) {
          return "acquired";
        }

        // Step 3: Key exists and is either completed or still fresh started
        return "exists";
      });
    },

    async markCompleted(
      key: string,
      resultHash: string | null,
      _ctx: ZeloopContext,
    ): Promise<void> {
      await pg.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE ${table}
SET status = 'completed',
    completed_at = now(),
    result_hash = $2
WHERE key = $1`,
          [key, resultHash],
        );
      });
    },
  };
}
