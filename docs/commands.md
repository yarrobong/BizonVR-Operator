# Device Commands

## Principles

- All device commands are stored durably in PostgreSQL.
- Redis is used only to speed up delivery and wake a connected Local Hub.
- Cloud sends typed commands only.
- Cloud never exposes raw shell or arbitrary command execution.

## Command Table

`device_commands` is the canonical queue with:

- tenant scope: `organization_id`, `club_id`
- routing scope: `local_hub_id`, `device_id`
- business link: `session_id`
- type and JSON payload
- status lifecycle
- timestamps for accepted/started/finished
- retry and error fields

## Supported Command Types

- `PING`
- `REFRESH_STATUS`
- `INSTALL_APP`
- `INSTALL_APK`
- `UNINSTALL_APP`
- `LAUNCH_APP`
- `STOP_APP`
- `REBOOT_DEVICE`
- `OPEN_SCRCPY`
- `CLOSE_SCRCPY`
- `SHOW_MESSAGE`
- `START_SESSION`
- `END_SESSION`
- `OPEN_LAUNCHER`
- `RUN_DIAGNOSTICS`

## Lifecycle

```text
created
  -> sent_to_hub
  -> accepted_by_hub
  -> running
  -> succeeded | failed | timeout | cancelled
```

## Delivery Flow

1. Web/API validates role, club scope, subscription feature, and device limit.
2. Cloud verifies the device belongs to the requested Local Hub.
3. Redis may publish a lightweight wakeup event for the destination hub.
4. Cloud inserts a row into `device_commands`.
5. Local Hub polls or subscribes, accepts the command, and stores it in SQLite cache.
6. Local Hub reports `running`, executes a typed handler with validated arguments, then reports a terminal status.
7. Cloud rejects invalid lifecycle jumps, for example `created -> succeeded`.

For `INSTALL_APK`, the command payload must identify the exact app version and checksum. Local Hub verifies the local APK artifact checksum before running `adb install`, so artifact errors are visible separately from install failures.

## Payload Examples

### OPEN_SCRCPY

```json
{
  "bitrate": "25M",
  "max_size": 1600,
  "crop": "1600:1000:116:460"
}
```

### START_SESSION

```json
{
  "session_id": 42,
  "package": "com.example.game",
  "duration_minutes": 30,
  "require_scrcpy": true
}
```

### REFRESH_STATUS with wake

```json
{
  "reason": "wake_device",
  "wake_device": true
}
```

### INSTALL_APK

```json
{
  "target": "quest_agent",
  "package_name": "com.bizonvr.spatialspike",
  "app_version_id": 7,
  "version_name": "0.1.0",
  "version_code": 1,
  "apk_checksum": "sha256..."
}
```

Local Hub may use this typed refresh payload to:

- reconnect a known Quest over `adb connect <ip>:5555`
- send wake key events over Wi-Fi ADB
- refresh telemetry after the headset is reachable again
- keep a remembered Wi-Fi route usable from the web panel even after the headset falls asleep, so the operator can wake it and then launch a session or cast

### END_SESSION

```json
{
  "package": "com.example.game",
  "return_to_launcher": true
}
```

### EXTEND_SESSION

`EXTEND_SESSION` is a sync-only Agent command. The authoritative duration is
already committed in Cloud; the command delivers the new timestamp-derived
state to the Quest and is safe to reconcile. Older databases use a
`RESUME_SESSION` payload with `resync_only: true` during migration compatibility.

```json
{
  "session_id": 42,
  "package": "com.example.game",
  "extension_minutes": 10,
  "session_state": { "revision": 3, "remaining_seconds": 1800 }
}
```

## Local Hub Safety

Local Hub must map every command type to an explicit handler. For example:

- `LAUNCH_APP` -> validated package name -> `adb shell monkey` or `am start`
- `STOP_APP` -> validated package name -> `adb shell am force-stop`
- `OPEN_SCRCPY` -> start managed `scrcpy` child process

Forbidden pattern:

```ts
exec(`adb shell ${userInput}`)
```

Required pattern:

```ts
spawn(adbPath, ["-s", serial, "shell", "am", "force-stop", packageName])
```

Package names must match:

```text
^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$
```
