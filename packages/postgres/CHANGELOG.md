# Changelog

All notable changes to `@zeloop/postgres` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `PgExecutor` and `PgAdapter` interfaces (driver-agnostic)
- `assertSafeIdent()` and `quoteIdent()` for SQL identifier safety
- `createPgOutboxSource()` — `BatchSource` implementation using `FOR UPDATE SKIP LOCKED`
- Dead letter support with configurable table name
- `createPgOutboxReaperTask()` for recovering stuck `processing` items
- `advisoryKey()` and `tryAdvisoryXactLock()` for global singleton jobs
- `createPgIdempotencyStore()` with TTL and steal algorithm
