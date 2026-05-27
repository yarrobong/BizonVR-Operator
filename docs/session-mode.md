# Session Mode

## Goal

Session mode is the core operator workflow for BizonVR Club Control. It must help staff launch, supervise, extend, and cleanly finish a VR play session across one or many Meta Quest headsets.

## Main Records

- `sessions`: business aggregate for a customer play session
- `session_devices`: per-headset execution and scrcpy requirement
- `session_events`: operator and technical timeline
- `device_commands`: launch, cast, end, and launcher return actions
- `scrcpy_streams`: cast lifecycle records

## Start Flow

1. Operator selects room, devices, game, duration, and optional casting.
2. Cloud performs pre-flight validation.
3. Cloud creates records in `preparing` state only:
   - `sessions`
   - `session_devices`
   - `session_events`
   - `device_commands` with `START_SESSION`
4. Local Hub accepts commands and executes them through ADB/Quest Agent.
5. Only after Local Hub reports `START_SESSION -> succeeded`, Cloud moves the device to `in_session`, marks the session `running`, starts timestamps, and tracks cast state.
6. If Local Hub reports `failed`, `timeout`, or `cancelled`, Cloud marks the session/device failed and records a critical `session_event`.

## Required Pre-flight Checks

- Local Hub online
- device online
- ADB available
- Quest Agent available
- battery threshold met
- storage threshold met
- app installed
- compatible app version
- no active session conflict
- scrcpy available if casting was requested

## Session States

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

## Device States Inside a Session

- `preparing`
- `ready`
- `running`
- `paused`
- `finished`
- `failed`
- `replaced`

## In-Session Actions

- extend timer by fixed increments
- open or close `scrcpy`
- send message to player
- restart the game
- replace a failing headset
- mark a headset issue
- stop a single device or finish the whole session

## Finish Flow

1. Operator or timer triggers session finish.
2. Cloud moves the session to `finishing` and queues `END_SESSION`.
3. Game process is stopped on Quest.
4. Kotlin Club Launcher is reopened.
5. Local Hub reports `END_SESSION -> succeeded`.
6. `session_devices` are marked finished and the device returns to `online`.
6. `sessions` moves to `completed` when all session devices are finished.
7. `session_events` captures the outcome and service notes.

Cloud must not mark a session `completed` or a device `online` before Local Hub confirms the finish command. If finish fails, the operator sees a failed session/device instead of a false success.

## Offline Behavior

If the internet drops after Local Hub has accepted the session:

- Local Hub keeps the timer running from SQLite cache.
- Local Hub can still stop the game and return to launcher.
- New telemetry, device events, and audit-relevant facts are queued locally.
- Cloud state is reconciled after connectivity returns.
