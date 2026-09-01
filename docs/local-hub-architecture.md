# Local Hub Architecture

Stage 3B keeps the Local Hub runtime contract while making ownership explicit. `local-hub/hub.js` is the composition root: it loads configuration, creates shared services, wires dependencies, starts the local Agent server and Cloud sync loop, and registers shutdown handlers.

## Runtime data flow

```text
Cloud API
   ↕ authenticated Cloud client / sync worker
Local Hub
   ↓ command worker → command dispatcher
   ↓ device routing → verified USB/Wi-Fi ADB route
Quest Agent / Quest

Quest Agent
   → authenticated Local Hub HTTP server
   → heartbeat store and local device state
   → Cloud sync payload
```

Cloud never runs ADB or `scrcpy`. The Local Hub is the only ADB boundary. A TCP route is usable only after `adb -s <route> get-state` reports `device` and route identity probes match the intended Quest.

## Modules

- `config.js` resolves the existing environment variables, defaults, LAN callback safety checks, cache paths and streaming settings.
- `logger.js` provides timestamped, recursively redacted logging. Sensitive values are local-only and are not printed in command arguments, headers or nested objects.
- `storage.js` owns small local JSON stores.
- `cloud/client.js` owns authenticated HTTP transport, Hub binding and normalized Cloud responses.
- `cloud/sync.js` owns bootstrap, polling, device-state payloads, command claims, result delivery and retry/outbox orchestration.
- `devices/routing.js` owns stable identity, USB/Wi-Fi route selection, remembered wireless state, ADB supervisor integration and route health.
- `devices/apps.js` owns installed-app discovery, launch component selection and icon-cache lookup.
- `devices/diagnostics.js` owns foreground-package, battery and display diagnostics.
- `adb/helpers.js` adapts the existing safe process runner to Local Hub operations and preserves bounded output/error semantics.
- `agent/credentials.js` wraps the existing credential primitives and persists raw Agent credentials locally with mode `0600`.
- `agent/auth.js` owns bearer verification, constant-time hash comparison, timestamp freshness and monotonic replay protection.
- `agent/heartbeat-store.js` owns in-memory heartbeat state and stale-heartbeat pruning.
- `agent/server.js` owns `/api/agent/heartbeat`, `/api/agent/call_operator`, `/streams/:serial`, JSON limits, CORS and HTTP response behavior.
- `agent/provisioning.js` builds Agent launch arguments and keeps the raw credential on the Hub-to-Quest path only.
- `commands/dispatcher.js` owns the command-type behavior and all ADB/session/APK/Agent side effects.
- `commands/worker.js` owns per-device serialization and safe ADB recovery around dispatch.
- `commands/reconciliation.js` owns evidence-based recovery after an interrupted or unknown command outcome.
- `cast/service.js` owns Local Hub cast orchestration while `cast-manager.js` and `streaming.js` remain the process/backpressure primitives.
- `lifecycle/shutdown.js` owns idempotent shutdown of polling, casts, scrcpy, HTTP and the execution journal.

## Credential boundary

Cloud stores only provisioning intent and the resulting Agent credential hash. The Hub generates the raw credential, passes it to Quest Agent during install/start, and stores the raw value only in the local credential cache. Heartbeat authentication requires the credential and a bound device identity. Heartbeat timestamps remain monotonic across Hub restarts; this stage does not claim full nonce/revocation support.

## Command safety

Cloud command payloads are claimed and journaled by the existing durable execution store. The worker serializes commands per stable device identity, uses the existing safe retry classifications and re-resolves routes after recovery. The dispatcher verifies stable identity and optional `android_id` before execution. APK paths remain artifact IDs under the canonical approved cache and are checked for containment, symlinks and SHA-256 before ADB install. END_SESSION reports success only after launcher foreground and Agent cleanup evidence are present.

## Lifecycle

At startup the Hub creates the Agent callback server, bootstraps known devices, then starts the existing polling cadence. At shutdown it stops casts and owned scrcpy processes, clears polling, closes the local HTTP server and closes the command execution journal. Repeated shutdown requests share one in-flight operation.

This document describes the software architecture only; it does not claim physical Quest or hardware validation.
