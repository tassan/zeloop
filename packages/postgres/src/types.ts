export interface PgExecutor {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface PgAdapter {
  withTransaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>;
}

export interface PgOutboxSourceOptions {
  table?: string;
  deadLetter?: {
    enabled: boolean;
    table?: string;
    sourceName?: string;
  };
}

export interface OutboxAck {
  ids: readonly string[];
}

/** Row shape returned by the outbox source (structurally compatible with @zeloop/outbox OutboxEvent). */
export interface OutboxRow {
  id: string;
  eventType: string;
  payload: unknown;
  headers: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  aggregateType: string | null;
  aggregateId: string | null;
  createdAt: Date;
}

export interface PgReaperOptions {
  table?: string;
  visibilityTimeoutSec: number;
  limit: number;
}

export interface PgIdempotencyStoreOptions {
  table?: string;
  startedTtlMs: number;
}
