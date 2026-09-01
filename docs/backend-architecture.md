# Backend Architecture

Stage 3A decomposes the existing SQLite/Express backend without changing
the public API or the Local Hub transport.

## HTTP layer

`server.ts` owns Express app creation, global CORS/JSON middleware, database
startup, demo seeding, session-expiry scheduling, route mounting, Vite/static
startup, and export of the testable app/database handles.

HTTP-specific concerns live under `src/backend/http/`:

- `middleware/authentication.ts` verifies signed web Bearer tokens, the
  explicit development fallback, and per-hub transport credentials. It
  attaches the authenticated `PermissionActor` to the request.
- `errors.ts` maps domain failures to the existing HTTP status and response
  shapes, including bounded-body and malformed-JSON errors.
- `routes/` groups catalog, device, command, session, hub, and audit routes.
  Route handlers validate request-specific input, call a domain boundary, and
  serialize the existing response contract.

## Services

- `authorization.ts` owns actor lookup, organization/club scope, role checks,
  subscription feature checks, and device limits.
- `session-service.ts` owns session creation, transitions, actions,
  idempotency, expiry, and preflight checks.
- `session-state.ts` owns session read models, timer arithmetic, state
  transitions, and session events shared by commands and sessions.
- `hub-sync-service.ts` owns Local Hub state ingestion, Quest identity matching,
  heartbeat reconciliation, telemetry, and command claiming.
- `device-service.ts` owns the operator-facing device read model.
- `agent-security.ts` owns constant-time verification of stored Agent token
  hashes.

Command lifecycle persistence and side effects remain cohesive in
`services/command-service.ts`. `repositories/commands.ts` remains a thin
compatibility re-export for callers using the old ownership path. Canonical
payload/hash and policy primitives live in `db/command-policy.ts`.

## Repositories

Raw SQL is grouped by domain in:

- `organizations.ts` — organizations, users, plans, subscriptions;
- `clubs.ts` — clubs, zones, rooms;
- `hubs.ts` — Local Hub records and operator-call flags;
- `devices.ts` — device identity, connectivity, assignment, and device state;
- `apps.ts` — apps, versions, and installed-app associations;
- `commands.ts` — compatibility facade for the command service;
- `audit.ts` — redacted audit-log persistence and reads.

## Database infrastructure

`db/connection.ts` creates better-sqlite3 connections and applies foreign-key
and WAL pragmas. `db/migrations.ts` owns migration discovery, ordering,
`schema_migrations`, legacy schema compatibility, migration transactions, and
the 0008 credential scrub. `db/json.ts` owns safe JSON parsing, timestamps,
redaction, and raw-credential rejection. Shared types and state constants are
in `db/types.ts`.

## Dependency direction

The primary dependency direction is:

```text
HTTP routes/middleware
        ↓
services and domain boundaries
        ↓
repositories
        ↓
db infrastructure/shared primitives
```

Repositories do not import Express, and DB infrastructure does not import the
HTTP layer. `database.ts` remains a compatibility facade for existing tests
and callers; new modules can be imported directly by ownership.

This is a dependency guideline, not a ban on SQL in every service. The
command, session, and hub-sync services intentionally own cohesive SQLite
transactions because their state transitions, event writes, command creation,
and reconciliation side effects must remain atomic. `device-service.ts` owns
the operator-facing device read model. Repositories contain reusable domain
persistence operations; authorization queries and state-machine persistence
remain with their owning services where that keeps the boundary explicit.

## Security boundary

Cloud stores Agent credential hashes only. Raw Agent credentials are rejected
from command/result payloads and redacted from audit/session JSON. Local Hub
remains the only component that executes ADB/scrcpy operations; this stage does
not alter Local Hub or Quest Agent behavior.
