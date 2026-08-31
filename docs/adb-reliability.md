# Local Hub ADB reliability

Local Hub treats ADB as a control and recovery transport. Quest Agent heartbeat remains the primary online signal, so an Agent-online/ADB-unavailable headset is reported as degraded rather than fully offline.

## Lifecycle

Each stable Quest identity has one supervisor state and at most one reconnect flight. A reconnect evaluates the heartbeat IP first, then the remembered IP and bounded previous-IP history. A TCP-open result is only a candidate: `adb connect` must succeed, `adb -s <route> get-state` must return `device`, and the route must match the remembered `stable_id`/`android_id` before it is persisted.

Successful recovery resets the attempt counter and backoff. Failed recovery uses bounded exponential backoff with jitter. `unauthorized` and `different_device` remain explicit states and are not treated as ordinary offline retries. A newer heartbeat/route input supersedes an older attempt; late results cannot publish the old IP.

## Process execution

All finite ADB operations use `local-hub/adb-process-runner.js`. It passes an argv array with `shell: false`, collects stdout/stderr, returns structured exit/timeout/spawn-error information, and terminates timed-out process groups. Long-lived `adb screenrecord` and `scrcpy` streams remain separately managed by the cast lifecycle and are stopped on request cleanup.

Commands resolve and health-check the route immediately before execution. A transport failure can trigger the same single-flight supervisor recovery. Only idempotent control operations are retried once on the newly resolved route; APK install, reboot, session end and other non-idempotent operations are not blindly repeated.

## ADB server failure

The hub does not run `adb kill-server`/`start-server` on every command failure. A failed or unavailable daemon is surfaced as an ADB transport failure, while Agent heartbeats and the HTTP/cloud sync loop continue. Once the daemon/network returns, normal discovery and supervisor backoff progressively restore verified routes.

## Remaining platform limits

Meta Quest/Android may close wireless ADB after reboot, sleep, OS updates, Wi-Fi changes, debugging reset, authorization changes, or policy changes. A powered-off/deeply sleeping headset and a Quest whose wireless-debugging setting was reset cannot always be repaired without trusted USB or an explicitly provisioned secure-settings recovery path. IP addresses are never device identity and cannot by themselves resolve a wrong-device collision.
