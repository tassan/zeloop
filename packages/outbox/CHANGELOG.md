# Changelog

All notable changes to `@zeloop/outbox` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `OutboxEvent` type with id, eventType, payload, headers, attempts, and createdAt
- `createRegistry()` handler registry with `get()` and `list()`
- `createOutboxDispatcher()` with error policy and optional idempotency
- `OutboxErrorPolicy` interface — unhandled event type goes to `dead`, other errors `throw`
- `DeadLetterError` for immediate fail signaling
- `createOutboxWorker()` helper that wires source, dispatcher, and retry policy into `createWorker()`
