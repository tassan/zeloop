# Changelog

All notable changes to `@zeloop/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `ZeloopContext` execution context with `runId`, `loopId`, clock, abort signal, and telemetry
- `Telemetry` interface with `Logger`, `Metrics`, and `Tracer`
- `createNoopTelemetry()` and `mergeTelemetry()` helpers
- `RetryPolicy` interface with `exponentialBackoff()` factory
- `BatchSource` interface for claim/complete/retry/fail lifecycle
- `IdempotencyStore` interface for at-most-once semantics
- `WorkerHooks` for lifecycle observability
- `createWorker()` with backpressure (no-overlap coalesce), idle delay, and graceful shutdown
