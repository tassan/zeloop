# CLAUDE.md — zeloop

## What is zeloop

A minimal async jobs & outbox framework for Node.js powered **only by Postgres**. No Redis, Kafka, RabbitMQ, or Temporal. The project is currently in the design/docs phase — no source code has been written yet. All design decisions live in `docs/`.

## Monorepo packages

```
packages/
  core/       — @zeloop/core: worker engine + loop runner (DB-agnostic)
  postgres/   — @zeloop/postgres: Postgres adapter, SQL helpers, sources
  outbox/     — @zeloop/outbox: outbox dispatcher + handler registry
  testing/    — @zeloop/testing: testcontainers helpers (future)
```

## Architecture

- **@zeloop/core** is DB-agnostic. It defines `BatchSource`, `ZeloopContext`, `RetryPolicy`, `Worker`, and hooks. It never imports Postgres code.
- **@zeloop/postgres** implements the `BatchSource` interface for Postgres using `FOR UPDATE SKIP LOCKED`. It provides `PgAdapter`/`PgExecutor` (driver-agnostic), outbox source, reaper, idempotency store, and advisory lock helpers.
- **@zeloop/outbox** sits on top of core and provides `OutboxEvent`, handler registry, error policy, and dispatcher. It wires into `createWorker()` from core.

### Key patterns

- **Claim**: `SELECT ... FOR UPDATE SKIP LOCKED` to claim batches exclusively
- **Ack-based flow**: claim → process → complete/retry/fail
- **Backpressure**: no overlap — if a tick is running, the next is coalesced (at most one pending)
- **Graceful shutdown**: AbortSignal + `shutdownTimeoutMs`
- **Retries**: `available_at` + `attempts` + `max_attempts`; exponential backoff
- **Reaper**: recovers stuck `processing` items after visibility timeout
- **Advisory locks**: `pg_try_advisory_xact_lock(k1, k2)` for global singleton jobs; always use transaction-scoped locks to avoid pool leak

## Key constraints and invariants

- Postgres only. No external message brokers.
- All timestamps are `timestamptz`.
- Outbox status flow: `pending` → `processing` → `sent` (success) or `dead` (terminal failure).
- Multiple workers can safely run against the same tables.
- Exactly-once is NOT guaranteed. Use idempotent handlers and/or the idempotency store.
- Ordering is stable per claim query (`ORDER BY available_at, id`) but not total across workers.
- Handler cancellation is cooperative via `AbortSignal`.
- Return `id::text` from Postgres and use `WHERE id::text = ANY($1::text[])` to avoid JS bigint issues.
- Table/schema identifiers must be validated (`[a-zA-Z0-9_.]`) and quoted; never accept from untrusted input.

## SQL tables

Canonical DDL in `docs/sql-contract.md`:

| Table                     | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `zeloop_outbox_events`    | Main outbox table with claim/retry/fail semantics |
| `zeloop_dead_letters`     | Dead letter storage (recommended)                 |
| `zeloop_idempotency_keys` | Idempotency store with TTL + steal                |
| `zeloop_jobs`             | Generic job queue (optional)                      |

## Tuning defaults

- `batchSize`: 50
- `itemConcurrency`: 10
- `tickIntervalMs`: 250–1000
- `idleDelayMs`: 1000–5000
- `visibilityTimeoutSec`: 5–30 min (>= p99 handler time)
- reaper interval: 30–120s, limit 50–200

## Observability

Metrics namespace: `zeloop.*`. Standard fields: `runId`, `loopId`, `tick`, `eventType`, `itemId`. See `docs/observability.md` for the full list of counters, histograms, and gauges.

## Error policy (outbox)

- Unhandled event type → `dead` immediately (do not burn attempts)
- All other errors → `throw` (let worker retry policy decide)

## Roadmap

Current target: **v0.1 (working MVP)**. See `docs/roadmap.md` for the full plan through v1.0.

---

## Agent rules

This project is built by AI agents. Follow these rules strictly.

### 1. Docs are the source of truth

- **Always read the relevant `docs/*.md` files before implementing anything.** The design docs define the public API, SQL contract, invariants, and error policies. Do not invent new APIs or deviate from the documented designs without explicit approval.
- If you find a contradiction between code and docs, the docs win. Fix the code.
- If a design doc is missing detail you need, ask — do not guess.

### 2. Test-Driven Development (TDD)

Every feature and bug fix must follow the red-green-refactor cycle:

1. **Red** — Write a failing test first. Commit it. The test must clearly express the intended behavior.
2. **Green** — Write the minimal production code to make the test pass. Commit it.
3. **Refactor** — Clean up the implementation while keeping tests green. Commit it.

Rules:

- Never write production code without a corresponding test.
- Never skip the failing-test step. If you write code and tests together, the test must fail when the production code is reverted.
- Test file location: colocate with source as `<module>.test.ts` (e.g., `packages/core/src/worker.ts` → `packages/core/src/worker.test.ts`).
- Integration tests that need Postgres go in `packages/<pkg>/src/__tests__/` and use testcontainers.
- Use `vitest` as the test runner.
- Prefer small, focused tests. One behavior per test. Descriptive test names: `"retries item when handler throws and retryPolicy returns delay"`.
- For the v0.1 required integration tests (2 workers / 1000 events, crash + reaper, global scheduler), put them in `packages/postgres/src/__tests__/integration/`.

### 3. Git — trunk-based development

- **Main branch: `main`.** All work targets `main`.
- **Short-lived feature branches only.** Branch naming: `<type>/<short-description>` (e.g., `feat/create-worker`, `fix/reaper-stuck-ids`, `test/outbox-claim-concurrency`).
- Branches must be short-lived (ideally a single session). Merge via squash or fast-forward — no merge commits.
- Never force-push to `main`.
- Keep `main` green at all times. Do not merge broken code.

### 4. Commit conventions (Conventional Commits)

Every commit message must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:

- `feat` — new feature (triggers MINOR bump)
- `fix` — bug fix (triggers PATCH bump)
- `test` — adding or updating tests (no version bump)
- `refactor` — code change that neither fixes a bug nor adds a feature
- `docs` — documentation only
- `chore` — build, tooling, CI changes
- `perf` — performance improvement

Scope is the package name without the `@zeloop/` prefix: `core`, `postgres`, `outbox`, `testing`.

Examples:

```
feat(core): add createWorker with backpressure and graceful shutdown
test(core): add failing test for worker idle delay behavior
fix(postgres): cast outbox ids to text to avoid bigint overflow
refactor(outbox): extract error policy into separate module
docs: update sql-contract with dead letter indexes
```

Rules:

- Subject line: imperative mood, lowercase, no period, max 72 chars.
- Body: wrap at 80 chars. Explain _why_, not _what_.
- Breaking changes: add `BREAKING CHANGE:` footer (triggers MAJOR bump).
- One logical change per commit. Do not bundle unrelated changes.

### 5. Versioning (Semantic Versioning)

Follow [semver 2.0.0](https://semver.org/) per package:

- **Pre-1.0 (current):** `0.MINOR.PATCH`. Breaking changes bump MINOR. Features and fixes bump PATCH.
- **Post-1.0:** `MAJOR.MINOR.PATCH` per standard semver rules.
- All packages in the monorepo are versioned independently.
- Tag format: `@zeloop/<pkg>@<version>` (e.g., `@zeloop/core@0.1.0`).

### 6. Changelog (Keep a Changelog)

Each package maintains its own `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/):

```markdown
# Changelog

## [Unreleased]

### Added

- `createWorker()` with backpressure and graceful shutdown

### Fixed

- Outbox id bigint overflow when id > Number.MAX_SAFE_INTEGER

### Changed

- Rename `tickMs` to `tickIntervalMs` for clarity
```

Rules:

- Update the changelog in the same commit as the code change.
- Use sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- On release, move `[Unreleased]` entries under a version heading with the date: `## [0.1.0] - 2026-02-06`.
- Never leave the changelog out of date. If you change behavior, update the changelog.

### 7. TypeScript conventions

- Strict mode (`"strict": true`). No `any` unless absolutely necessary and justified with a comment.
- Prefer `interface` over `type` for object shapes (matches the existing API docs).
- Export only the public API from each package's `index.ts`. Internal modules use no-export or `/** @internal */`.
- Use `readonly` for arrays and properties that should not be mutated.
- Naming: `camelCase` for functions/variables, `PascalCase` for types/interfaces, `UPPER_SNAKE` for constants.
- Factory functions over classes: `createWorker()`, `createRegistry()`, `createPgOutboxSource()` — not `new Worker()`.
- No default exports. Named exports only.
- No enums. Use union types or const objects.

### 8. Package boundaries

Dependency direction is strict and must never be violated:

```
@zeloop/outbox  →  @zeloop/core
@zeloop/postgres →  @zeloop/core
@zeloop/outbox  ✗  @zeloop/postgres  (no direct dependency)
@zeloop/core    ✗  @zeloop/postgres  (no dependency on adapters)
@zeloop/core    ✗  @zeloop/outbox    (no dependency on plugins)
```

- `@zeloop/core` has zero runtime dependencies.
- `@zeloop/postgres` depends on `@zeloop/core` (for types like `BatchSource`, `ZeloopContext`).
- `@zeloop/outbox` depends on `@zeloop/core` (for types like `ZeloopContext`, `Worker`).
- `@zeloop/outbox` does NOT depend on `@zeloop/postgres`. The wiring happens in user code or examples.
- If you find yourself importing across a forbidden boundary, you are doing it wrong. Refactor.

### 9. Error handling

- Never swallow errors silently. Log or propagate.
- Never throw strings. Always throw `Error` instances.
- Normalize external errors at package boundaries (e.g., wrap Postgres driver errors in a zeloop-specific error).
- SQL errors must not leak to callers outside `@zeloop/postgres`.

### 10. PR workflow

- Every PR must have:
  1. A clear title following conventional commits format.
  2. A summary of what changed and why.
  3. Passing tests (all existing + new).
  4. Changelog updated.
- PRs should be small and focused. One feature or fix per PR.
- If a PR touches multiple packages, explain why they must be coupled.

### 11. Task execution order

When implementing a feature, follow this order:

1. Read the relevant `docs/*.md` files.
2. Write the type definitions / interfaces first (they are documented in the design docs).
3. Write failing tests for the behavior.
4. Implement the minimal code to pass the tests.
5. Refactor if needed.
6. Update the changelog.
7. Commit with a proper conventional commit message.

### 12. Things agents must NOT do

- Do not add dependencies without explicit approval. This project is minimal by design.
- Do not introduce abstractions "for the future." Solve the current problem.
- Do not modify `docs/*.md` design files unless asked to. These are maintained by the project owner.
- Do not create README files in sub-packages unless asked.
- Do not add comments that restate the code. Only comment non-obvious _why_.
- Do not use `console.log` for observability. Use the `Telemetry` interface.
- Do not hardcode table names. Use the configurable table name options with safe defaults.
- Do not use session-level advisory locks. Always use `pg_try_advisory_xact_lock`.

---

## Docs reference

- `docs/core-api.md` — core public API design (types + worker)
- `docs/outbox-plugin.md` — outbox dispatcher, registry, error policy, idempotency
- `docs/postgres-adapter.md` — PgAdapter, outbox source, reaper, advisory locks
- `docs/sql-contract.md` — canonical DDL and SQL queries
- `docs/invariants.md` — guarantees, non-guarantees, failure modes
- `docs/observability.md` — logging fields and metrics conventions
- `docs/roadmap.md` — v0.1 → v1.0 milestones
- `docs/package-layout.md` — monorepo structure
