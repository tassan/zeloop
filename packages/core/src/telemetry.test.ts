import { describe, expect, it } from "vitest";
import { createNoopTelemetry, mergeTelemetry } from "./telemetry.js";
import type { Logger, Telemetry } from "./types.js";

describe("telemetry", () => {
  it("createNoopTelemetry returns a full Telemetry object", () => {
    const t = createNoopTelemetry();
    expect(t.logger).toBeDefined();
    expect(t.metrics).toBeDefined();
    expect(t.tracer).toBeDefined();

    // noop calls should not throw
    t.logger.info("test");
    t.logger.warn("test");
    t.logger.error("test");
    t.metrics.count("test");
    t.metrics.gauge("test", 1);
    t.metrics.histogram("test", 1);
  });

  it("noopTracer.withSpan executes the function and returns result", async () => {
    const t = createNoopTelemetry();
    const result = await t.tracer.withSpan("test", async () => 42);
    expect(result).toBe(42);
  });

  it("mergeTelemetry fills missing parts with noop", () => {
    const customLogger: Logger = {
      info() {},
      warn() {},
      error() {},
    };
    const merged = mergeTelemetry({ logger: customLogger });
    expect(merged.logger).toBe(customLogger);
    expect(merged.metrics).toBeDefined();
    expect(merged.tracer).toBeDefined();
  });

  it("mergeTelemetry returns noop when called with undefined", () => {
    const t = mergeTelemetry(undefined);
    expect(t.logger).toBeDefined();
    expect(t.metrics).toBeDefined();
    expect(t.tracer).toBeDefined();
  });
});
