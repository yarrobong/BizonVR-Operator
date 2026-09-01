# Database Design

This document describes the current repository runtime. The Cloud/API uses
`better-sqlite3`; the Local Hub has a separate SQLite cache. PostgreSQL and
Redis are future deployment options, not running dependencies in this codebase.

## API database

The database is created by `src/backend/db/connection.ts` and upgraded by the
ordered SQL files under `db/migrations/`. Connections enable foreign keys and
WAL mode. Migration application is transactional, and legacy Agent credential
fields are scrubbed by the credential-safety migration.

Core domains currently represented in the schema include:

- organizations, users, clubs, zones, rooms, and subscriptions;
- Local Hubs, devices, stable identity/route fields, and telemetry projections;
- apps, app versions, installed-app associations, and APK checksums;
- durable device commands, command events, sessions, session devices, and
  session events;
- audit logs and operator-call/monitoring state.

The exact schema source is [0001_initial.sql](../db/migrations/0001_initial.sql),
with later migrations adding route identity, session lifecycle/reliability, and
Agent authentication protections.

## Durable command and session state

`device_commands` stores the typed command, tenant/routing scope, target stable
identity, status, timestamps, retry data, lease information, and result/error
details. The service layer uses SQLite transactions for command claiming,
session transitions, event writes, and audit writes that must agree.

Session state is Cloud-authoritative. Durable start/pause/extension timestamps,
revision fields, and the one-active-session constraint prevent a refresh,
restart, or duplicate request from silently creating a second active session.

## Local Hub cache

The Local Hub cache schema is [local-hub/migrations/0001_cache.sql](../local-hub/migrations/0001_cache.sql).
It stores:

- last known Cloud device/session projections;
- accepted commands, leases, retry state, and durable results;
- cast lifecycle state;
- outbound events produced while the Hub is temporarily offline.

This cache supports reconciliation and safe shutdown. It is not a second
authorization system and is not exposed as a Cloud database.

## Planned deployment migration

A future hosted deployment may map the API schema to PostgreSQL and add a
separate operational delivery layer. Those changes are intentionally outside
the current MVP and must not be read as present runtime requirements.
