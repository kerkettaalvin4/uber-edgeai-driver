# Changelog

## Unreleased

- Added the first pure TypeScript domain feature: PRD trip lifecycle transitions and max-ordinal status merging.
- Added the React Native 0.88 New Architecture app shell and Android/iOS project scaffolds.
- Added Jest and React Native Testing Library setup for domain and app-root tests.
- Added pure TypeScript Hybrid Logical Clock tick, receive, compare, and serialization logic with focused tests.
- Added an isolated Fastify telemetry gateway foundation with development JWT issuance, authenticated WebSocket stream, envelope validation, heartbeat pong, and Redis resume buffering.
- Added Docker Compose services for the gateway, Redis, and PostGIS-backed PostgreSQL.
- Added an authenticated `/v1/sync` endpoint with UUIDv7 idempotency, PostgreSQL-backed state, and max-ordinal, HLC last-writer-wins, and observed-remove set merges.
- Added a development-only synthetic Bengaluru route replay that emits location batches, H3 resolution-8 surge deltas, and route updates to resumed WebSocket clients.



