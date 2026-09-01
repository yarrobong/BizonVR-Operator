# Device Commands

This document describes the current typed Cloud/API ↔ Local Hub contract.
Commands are journaled in the repository's SQLite database and delivered by
authenticated Hub polling/sync. Redis is not required, and Cloud never exposes
raw shell execution.

## Principles

- Every command has tenant, club, Hub, and device scope.
- The API validates role, subscription feature, device limit, and Hub/device
  ownership before creating a command.
- The Local Hub maps each command type to an explicit handler.
- The worker serializes same-device execution, uses bounded semantic retries,
  and reconciles uncertain outcomes before replaying dangerous side effects.
- ADB calls use an explicit verified route (`adb -s <route>`) and validated
  package/artifact arguments.

## Command inventory

The Local Hub dispatcher has 18 executable command branches:

- `OPEN_SCRCPY`, `CLOSE_SCRCPY`;
- `START_SESSION`, `PAUSE_SESSION`, `RESUME_SESSION`, `EXTEND_SESSION`,
  `SWITCH_SESSION_APP`, `END_SESSION`;
- `INSTALL_APP`, `INSTALL_APK`, `UNINSTALL_APP`;
- `OPEN_LAUNCHER`, `REBOOT_DEVICE`, `REFRESH_STATUS`;
- `RECONNECT_ADB`, `RELAUNCH_AGENT`, `RUN_DIAGNOSTICS`, `FORGET_DEVICE`.

The Cloud command policy/store also retains `PING`, `LAUNCH_APP`, `STOP_APP`,
and `SHOW_MESSAGE` as policy-only types covered by policy/reliability tests;
they are not executable dispatcher branches. `GET_STATE` is an internal
safe-retry classification only and is not a supported Cloud command. There is
no generic shell command.

## Lifecycle

```text
created
  -> sent_to_hub
  -> accepted_by_hub
  -> running
  -> succeeded | failed | timeout | cancelled
```

Claim leases, attempt counters, result hashes, and command events make retries
and duplicate deliveries observable. A terminal result can be accepted
idempotently; a stale lease cannot update the command after it has been
reclaimed.

## Delivery flow

1. The Web API authenticates the user and checks organization/club scope,
   role, subscription features, and device limits.
2. The API verifies that the target device belongs to the requested Local Hub
   and creates a typed command in SQLite.
3. The Hub polls/synchronizes pending commands and atomically claims one
   eligible head-of-line command for a device.
4. The worker selects a verified USB/Wi-Fi route, executes the explicit handler,
   and reports a bounded structured result.
5. The Cloud service applies the valid status transition and writes audit or
   session events where appropriate.
6. If the outcome is unknown, reconciliation checks device evidence before a
   retry. Dangerous commands are never blindly replayed from an incomplete
   journal.

## APK safety

`INSTALL_APK` identifies an approved artifact and its SHA-256 checksum. The
Local Hub checks artifact ID containment, rejects traversal/absolute paths and
symlinks, verifies the checksum, and only then invokes the ADB install handler.
Install errors stay visible as install/artifact failures rather than being
reported as success.

## Local Hub safety

Forbidden:

```ts
exec(`adb shell ${userInput}`)
```

Required shape:

```ts
spawn(adbPath, ["-s", serial, "shell", "am", "force-stop", packageName])
```

Package names must match:

```text
^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$
```

The full implementation is split between
[command policy](../src/backend/db/command-policy.ts),
[command service](../src/backend/services/command-service.ts), and the
[Local Hub dispatcher](../local-hub/commands/dispatcher.js).
