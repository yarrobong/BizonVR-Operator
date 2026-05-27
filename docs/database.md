# Database Design

## Overview

BizonVR Club Control uses a layered storage model:

- PostgreSQL is the source of truth for cloud data and all business entities.
- Redis is ephemeral infrastructure for delivery, fan-out, locking, and live views.
- Local Hub keeps a SQLite cache to continue sessions and command execution when cloud connectivity is lost.
- Quest Agent stores only minimal local state on-device.

This repository currently runs on `better-sqlite3` for MVP development, but the schema is intentionally designed to map 1:1 to PostgreSQL production tables.

## Core Domains

### Organization and Access

- `organizations`: tenant root for billing, quotas, clubs, and audit scope.
- `users`: SaaS users scoped to an organization with platform role and status.
- `subscription_plans`: catalog of commercial plans and enabled features.
- `organization_subscriptions`: active plan, limits, and overrides for each organization.

### Club Topology

- `clubs`: a real operating location owned by an organization.
- `club_zones`: logical map sections such as main floor, arena wing, or training zone.
- `club_rooms`: operator-facing playable spaces shown on the club map.
- `local_hubs`: on-premise bridge nodes bound to a club.

### Devices and Apps

- `devices`: Meta Quest headsets managed through Local Hub and Quest Agent.
- `apps`: app catalog metadata, including launcher and third-party games.
- `app_versions`: versioned APK artifacts with checksum.
- `device_apps`: installation state per device.

### Commands and Sessions

- `device_commands`: durable command queue persisted in PostgreSQL and delivered through Local Hub.
- `sessions`: business session aggregate.
- `session_devices`: per-headset execution inside a session.
- `session_events`: timeline of events for session orchestration and support.
- `scrcpy_streams`: cast lifecycle records. Actual `scrcpy` processes run only on Local Hub.

### Monitoring and Audit

- `device_telemetry`: time-series snapshots from Local Hub and Agent.
- `device_events`: device-specific technical events.
- `monitoring_alerts`: operator-visible alerts with severity and lifecycle.
- `audit_logs`: immutable business/security audit trail.

## Status Enums

### Device status

- `new`
- `pairing_required`
- `online`
- `offline`
- `busy`
- `in_session`
- `installing`
- `updating`
- `maintenance_required`
- `charging_required`
- `error`
- `disabled`

### Command status

- `created`
- `sent_to_hub`
- `accepted_by_hub`
- `running`
- `succeeded`
- `failed`
- `timeout`
- `cancelled`

### Session status

- `draft`
- `preparing`
- `ready`
- `starting`
- `running`
- `paused`
- `extended`
- `finishing`
- `completed`
- `cancelled`
- `failed`

### Monitoring severity

- `info`
- `warning`
- `critical`
- `blocker`

## Relational Flow

```text
organizations
  -> clubs
    -> club_zones
    -> club_rooms
    -> local_hubs
    -> devices
    -> sessions

devices
  -> device_apps
  -> device_commands
  -> device_telemetry
  -> device_events

sessions
  -> session_devices
  -> session_events
  -> scrcpy_streams
```

## Indexing Strategy

Important indexes are included for:

- tenant and club scoping: `users.organization_id`, `clubs.organization_id`
- operator map lookups: `devices(club_id, room_id)`
- hub dispatch: `device_commands(local_hub_id, status, created_at)`
- active session lookups: `sessions(club_id, status, created_at)`, `session_devices(session_id, status)`
- telemetry history: `device_telemetry(device_id, captured_at desc)`
- alert dashboards: `monitoring_alerts(status, severity, last_seen_at desc)`
- audit review: `audit_logs(organization_id, created_at desc)`

## PostgreSQL vs SQLite

### Production PostgreSQL

- Prefer `uuid` or `bigserial` IDs depending on deployment policy.
- Replace `TEXT` JSON payload fields with `jsonb`.
- Replace timestamp text columns with `timestamptz`.
- Convert status checks into native PostgreSQL enums if desired.

### Current repository runtime

- Uses `better-sqlite3` and a SQL migration at [db/migrations/0001_initial.sql](/Users/Yaroslav/Documents/dev/BizonVR-Operator/db/migrations/0001_initial.sql:1).
- Keeps the same table names and foreign-key relationships.
- Uses `CHECK` constraints instead of database-native enums for portability.

## Local Hub SQLite Cache

The Local Hub cache schema lives in [local-hub/migrations/0001_cache.sql](/Users/Yaroslav/Documents/dev/BizonVR-Operator/local-hub/migrations/0001_cache.sql:1).

It persists:

- last cloud snapshot of devices and sessions
- accepted commands waiting to execute or sync back
- scrcpy stream state
- outbound events generated while offline

This keeps command execution and session shutdown reliable during temporary internet loss.
