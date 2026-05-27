# Architecture

## Command Chain

```text
Web Panel -> Cloud API -> PostgreSQL device_commands -> Redis notify/publish -> Local Hub -> ADB/scrcpy/Quest Agent -> Meta Quest
```

Cloud never runs `adb`, never starts `scrcpy`, and never talks directly to the headset.

## Storage Responsibilities

### PostgreSQL

Primary source of truth for:

- tenants and clubs
- devices and app inventory
- durable device commands
- sessions and session history
- monitoring alerts
- subscription enforcement
- audit logs

### Redis

Operational layer only:

- fast command fan-out to connected Local Hubs
- live hub/device presence
- heartbeat TTLs
- queue wakeups and pub/sub
- short-lived dashboards and cache entries
- distributed locks for session start / finish / installation jobs

Redis must not be the only copy of a command or session lifecycle event.

### Local Hub SQLite

Autonomous branch-side cache for:

- locally known devices
- accepted commands
- active sessions and session devices
- scrcpy state
- unsynced events while internet is down

When cloud connectivity drops, Local Hub continues:

- finishing already accepted commands
- maintaining active session timers
- returning devices to launcher on session end
- collecting telemetry and syncing it later

### Quest Agent Local Storage

Minimal Android-side state only:

- pairing ID
- current session timer state
- launcher configuration
- last known hub endpoint

Recommended implementation:

- `SharedPreferences` for pairing/session metadata
- optional tiny Room/SQLite table only if offline message queue becomes necessary

## SaaS Boundaries

- `organization` is the tenant and billing scope.
- `club` is the physical VR venue.
- `zone` and `room` drive the operator map.
- `local_hub` is the only component allowed to execute ADB and `scrcpy`.

## Session Mode

Session mode is the main business workflow:

1. Operator chooses room, game, duration, devices, and optional casting.
2. Cloud validates subscription, club scope, device availability, hub online, app presence, battery, storage, and active conflicts.
3. Cloud writes `sessions`, `session_devices`, `session_events`, and `device_commands`.
4. Local Hub receives commands, launches the game, starts `scrcpy` if needed, and keeps heartbeat/telemetry flowing.
5. On finish, Local Hub stops the game, reopens the Kotlin launcher, and syncs completion back to cloud.

## Failure Model

### If Redis fails

- commands still exist in PostgreSQL
- Local Hub can continue polling from cloud

### If internet fails

- cloud cannot dispatch new work immediately
- Local Hub can finish already accepted work using SQLite cache
- telemetry and events are buffered and synced later

### If Local Hub fails

- cloud marks hub offline from heartbeat TTL
- devices in that club move into partial offline visibility
- new commands stay in PostgreSQL with visible operator status
