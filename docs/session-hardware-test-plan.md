# Session Engine hardware test plan

Этот план выполняется только на test club и test Quest, без customer session.
Перед началом записать Quest stable identity, Agent version, Hub instance и
commit. Любой шаг с неожиданным физическим состоянием останавливает прогон и
фиксируется как failure, а не обходится ручной ADB-командой.

## Prerequisites

- [ ] Meta Quest paired; `quest-agent-spatial-spike` installed with checksum.
- [ ] Local Hub online, HUB_TOKEN configured, USB repair path available.
- [ ] Test app installed and foreground package known.
- [ ] Browser panel shows same device identity and no active session.
- [ ] `scripts/session-hardware-soak.js` configured with real API/Hub values.

## End-to-end acceptance

1. [ ] Pair Quest and wait for Agent heartbeat.
2. [ ] Start a 30-minute session; verify exactly one START command.
3. [ ] Verify game foreground and matching session id in heartbeat.
4. [ ] Start cast; close/reopen viewer; session remains running.
5. [ ] Pause; verify game stops, launcher is foreground, remaining time freezes.
6. [ ] Refresh browser; UI reconstructs Paused without resetting time.
7. [ ] Resume; verify one command and the same remaining snapshot.
8. [ ] Extend +10; retry the request with the same idempotency key; verify +10.
9. [ ] Drop Quest Wi-Fi for 30 seconds; verify Cloud does not reset or complete.
10. [ ] Restore Wi-Fi; verify heartbeat, ADB route and timer converge.
11. [ ] Force an ADB reconnect; verify no duplicate device or START command.
12. [ ] Switch to a second installed app; verify old app stops and new foreground
    package is confirmed before the UI says switched.
13. [ ] Restart Local Hub during a running session; verify lease recovery and no
    duplicate launch.
14. [ ] Refresh browser in Starting, Running, Paused and Finishing states.
15. [ ] End session; verify `finishing`, game stopped, launcher foreground.
16. [ ] Verify Cloud becomes Completed only after cleanup result.
17. [ ] Send a delayed old heartbeat; verify it cannot resurrect the session.

## Recovery cases

- [ ] Quest reboot during running: session remains logically active and enters
  reconciliation/operator-required state until identity and Agent state match.
- [ ] Launcher missing/crashing: operator sees actionable cleanup failure.
- [ ] Wrong foreground app after launch: session does not become running.
- [ ] Hub offline at expiry: session stays finishing and is cleaned after return.
- [ ] Two operator browser tabs issue Pause/End simultaneously: one legal
  transition wins and the other receives a deterministic conflict.

Record for every run: timestamps, command ids, session/device revisions,
foreground package before/after, heartbeat payloads, Hub logs, screenshots and
final Cloud/device state. A hardware PASS requires a real Quest; an unexecuted
or unavailable scenario is `NOT RUN`.
