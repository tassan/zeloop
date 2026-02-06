import { createHash } from "node:crypto";
import type { PgExecutor } from "./types.js";

/**
 * Derive deterministic `(k1, k2)` 32-bit signed integers from
 * a job name and optional time bucket for use with advisory locks.
 */
export function advisoryKey(
  jobName: string,
  bucket?: number,
): { k1: number; k2: number } {
  const input = bucket !== undefined ? `${jobName}:${bucket}` : jobName;
  const hash = createHash("md5").update(input).digest();
  const k1 = hash.readInt32LE(0);
  const k2 = hash.readInt32LE(4);
  return { k1, k2 };
}

/**
 * Attempt to acquire a transaction-scoped advisory lock.
 * Returns `true` if the lock was acquired, `false` otherwise.
 */
export async function tryAdvisoryXactLock(
  tx: PgExecutor,
  k1: number,
  k2: number,
): Promise<boolean> {
  const result = await tx.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired",
    [k1, k2],
  );
  return result.rows[0]?.acquired === true;
}
