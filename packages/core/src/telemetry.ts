import type { Logger, Metrics, Span, Telemetry, Tracer } from "./types.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

const noopMetrics: Metrics = {
  count() {},
  gauge() {},
  histogram() {},
};

const noopSpan: Span = {
  setField() {},
  end() {},
};

const noopTracer: Tracer = {
  async withSpan<T>(_name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return fn(noopSpan);
  },
};

export function createNoopTelemetry(): Telemetry {
  return {
    logger: noopLogger,
    metrics: noopMetrics,
    tracer: noopTracer,
  };
}

export function mergeTelemetry(partial?: Partial<Telemetry>): Telemetry {
  const noop = createNoopTelemetry();
  if (!partial) return noop;
  return {
    logger: partial.logger ?? noop.logger,
    metrics: partial.metrics ?? noop.metrics,
    tracer: partial.tracer ?? noop.tracer,
  };
}
