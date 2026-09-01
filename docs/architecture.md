# Current Architecture

This document describes the implementation in this repository. The system is
an Express/SQLite API plus a LAN-local Node.js Hub; PostgreSQL, Redis, Django,
Celery, and WebSocket infrastructure are not part of the current runtime.

## Command chain

```text
Browser -> React Web Panel -> Express API -> SQLite command/session journal
                                      <-> authenticated Local Hub sync
                                           -> typed handlers
                                              -> ADB / scrcpy / Quest Agent
                                                 -> Meta Quest
```

The Cloud/API process never runs ADB or scrcpy and never connects to a Quest
directly. The Local Hub is the only component allowed to cross the LAN hardware
boundary.

## Storage responsibilities

### API SQLite

The API uses `better-sqlite3` with ordered SQL migrations, foreign keys, WAL
mode, and transactional domain operations. It persists organizations, clubs,
rooms, users, subscriptions, devices, app inventory, commands, sessions,
session events, telemetry projections, and audit logs.

`device_commands` is the durable Cloud-side command journal. Session actions
write their state, events, and commands together where the transition requires
atomicity.

### Local Hub cache

The Hub keeps a separate local SQLite journal/cache for known devices, command
claims and results, casts, and events that need to be synchronized after a
short connectivity loss. It does not replace Cloud authorization or invent
arbitrary commands while offline.

### Quest Agent state

The Android Agent keeps only the local pairing/session/launcher state needed to
send authenticated heartbeats and display the soft-launcher experience. Its
raw Agent credential is not stored by Cloud.

## Security boundaries

- Web requests use signed HMAC Bearer tokens in production.
- The API resolves the authenticated subject to an active user and checks
  organization/club scope, role, subscription features, and device limits.
- Local Hub requests use Hub credentials; Agent heartbeat requests use a
  pairing-bound credential, fresh timestamp, and stable identity.
- Only typed command handlers can invoke ADB or managed casting. Raw shell input
  is not part of the API contract.

## Reliability boundaries

Commands are claimed with leases, serialized per stable device identity, and
reconciled after uncertain outcomes. ADB route changes do not create new Quest
identities: stable ID, Agent ID, Android ID, and transport routes remain
separate. Session timers are based on durable timestamps, and completion waits
for confirmed cleanup. See [backend architecture](backend-architecture.md),
[Local Hub architecture](local-hub-architecture.md), and
[session reliability](session-reliability.md).

## Historical design notes

Earlier design documents explored a PostgreSQL/Redis deployment. That is useful
background, but it is not an implementation claim for this repository. The
current database/runtime details are in [database.md](database.md).
