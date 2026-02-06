import type { RetryPolicy } from "./types.js";

export interface ExponentialBackoffOptions {
  baseMs: number;
  maxMs: number;
  factor?: number;
}

export function exponentialBackoff(opts: ExponentialBackoffOptions): RetryPolicy {
  const factor = opts.factor ?? 2;
  return {
    nextDelay(attempt: number): number | null {
      const delay = Math.min(opts.baseMs * Math.pow(factor, attempt), opts.maxMs);
      return delay;
    },
  };
}
