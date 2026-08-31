# Real hardware ADB reliability test plan

This is the manual companion to `scripts/adb-hardware-soak.js`. The script
records ADB transport behavior and exercises the existing Local Hub process
runner/reconnect supervisor. It does not claim that a scenario happened unless
the operator actually performs it.

## Preconditions

- [ ] Quest is a supported Meta Quest device running the production app `quest-agent-spatial-spike`.
- [ ] Quest Agent is paired and its heartbeat is visible in the operator panel/API.
- [ ] Local Hub is running on the same LAN as the Quest.
- [ ] USB debugging is authorized on the Quest; the authorization dialog was accepted.
- [ ] `adb devices -l` shows the expected USB route as `device`.
- [ ] The operator knows the stable identity (`stable_id`/serial), not only the current IP address.
- [ ] ADB soak artifacts can be written to `artifacts/adb-soak/`.
- [ ] Before each destructive network/power scenario, record the current session state and do not use a live customer session.

## Automated baseline / soak

Run from the repository root:

```bash
node scripts/adb-hardware-soak.js \
  --device '<stable-id>' \
  --duration 30m \
  --interval 5s \
  --api-url http://localhost:3000 \
  --verbose
```

For the two-hour run, use `--duration 2h`. The command writes a JSON artifact
and a human-readable `.summary.txt` beside it. The JSON includes samples,
execution route, IP, Agent status/heartbeat age when `--api-url` is available,
ADB status, get-state and health-command latency, reconnect metrics, route/IP
changes, failure categories, and consecutive failures.

The API flag is optional. Without it, Agent status and heartbeat age are
explicitly `unknown`; this is a limitation, not an offline or passing result.

## Scenarios

For every scenario, record: start/end timestamps, action, USB route, Wi-Fi
route/IP, Agent heartbeat state, ADB state, observed recovery time, operator
intervention, artifact path, and PASS/FAIL with evidence.

### 1. Baseline

- [ ] Start with USB authorized and Quest Agent heartbeat online.
- [ ] Run the soak for at least 30 minutes.
- [ ] Expected: no duplicate device, stable identity unchanged, health command succeeds, no unexplained ADB failures.
- [ ] Logs: JSON artifact, summary, Local Hub log, operator-panel screenshot.
- [ ] Pass/fail: PASS only if all samples and expected telemetry are present; otherwise FAIL or INCONCLUSIVE.

### 2. Wi-Fi drop and recovery

- [ ] Disable the Quest Wi-Fi radio or move it outside AP range for 30–60 seconds.
- [ ] Restore Wi-Fi without changing the Quest identity.
- [ ] Expected: Agent/ADB degradation is visible; reconnect uses a verified route; recovery does not create a second device.
- [ ] Logs: timestamps for disconnect/reconnect, candidate routes, reconnect duration, heartbeat age.
- [ ] Pass/fail: PASS only if the documented recovery target is met and identity remains stable.

### 3. Router/AP restart

- [ ] Restart the AP/router while the Quest and Local Hub are idle.
- [ ] Expected: route may change and IP may change; supervisor retries with bounded backoff; old IP is not treated as identity.
- [ ] Logs: router timestamps, DHCP lease/IP, soak artifact, Local Hub log.
- [ ] Pass/fail: PASS if the Quest returns on the verified new route without duplicate registration.

### 4. IP change

- [ ] Force a new DHCP lease or use a controlled network change.
- [ ] Expected: stable/Agent identity is unchanged; new IP is stored as a route candidate; a stale IP cannot attach to another Quest.
- [ ] Logs: before/after IP, stable ID, Android ID, route verification output.
- [ ] Pass/fail: PASS if identity verification rejects a mismatched device and accepts the original Quest.

### 5. Sleep / wake

- [ ] Put the Quest to sleep for at least 60 seconds, then wake it.
- [ ] Expected: Agent heartbeat recovers; ADB may be temporarily offline but must not make an Agent-online device appear globally absent.
- [ ] Logs: sleep/wake timestamps, heartbeat age, ADB status transitions, recovery duration.
- [ ] Pass/fail: PASS if the operator can distinguish Agent health from ADB transport health and control recovers.

### 6. Quest reboot

- [ ] Reboot the Quest with no active customer session.
- [ ] Expected: stable identity and Android ID remain unchanged; Agent heartbeat returns; USB/Wi-Fi routes are reconciled rather than duplicated.
- [ ] Logs: reboot timestamps, boot completion, route list, identity probes.
- [ ] Pass/fail: PASS if the same device record is reused and control becomes available.

### 7. Local Hub restart

- [ ] Stop and restart Local Hub while the Quest remains powered on.
- [ ] Expected: cached identity/routes are reused safely; command sync resumes; no raw shell or direct Cloud-to-Quest path is involved.
- [ ] Logs: Hub restart timestamps, startup log, artifact samples, cloud status.
- [ ] Pass/fail: PASS if recovery is automatic or the next operator action is explicit and sufficient.

### 8. ADB server restart

- [ ] Restart the host ADB server (`adb kill-server`, then allow Local Hub to reconnect it) during an idle period.
- [ ] Expected: daemon failure is visible, finite commands do not hang, recovery is bounded and route-verified.
- [ ] Logs: daemon timestamps, timeout/error category, reconnect duration.
- [ ] Pass/fail: PASS if the Hub returns to a verified route without duplicate state.

### 9. Manual ADB disconnect

- [ ] Disconnect the active Wi-Fi route with `adb disconnect <ip>:5555`.
- [ ] Expected: the next safe health/control operation can recover; install/repair policy still prefers USB where required.
- [ ] Logs: exact command time, route before/after, command result, supervisor state.
- [ ] Pass/fail: PASS if a safe command recovers or presents an actionable error.

### 10. Command during failure

- [ ] Interrupt Wi-Fi, issue a safe status/control command, and restore connectivity.
- [ ] Expected: only safe idempotent commands retry; install/reboot/end-session are not blindly replayed; operator sees failure and next step.
- [ ] Logs: command type, retry count, status transition, audit log, artifact.
- [ ] Pass/fail: PASS if command policy and operator error are correct.

### 11. Cast plus control

- [ ] Start scrcpy/cast and issue a safe control/status action concurrently.
- [ ] Expected: cast process and ADB control remain independently observable; a cast failure is not hidden; no process leak remains after stop.
- [ ] Logs: cast PID/lifecycle, command latency, ADB state, cleanup result.
- [ ] Pass/fail: PASS if both paths remain responsive or failures are isolated and actionable.

### 12. Rapid flap

- [ ] Perform at least 10 controlled Wi-Fi disconnect/reconnect flaps.
- [ ] Expected: reconnect is single-flight per stable identity, backoff is bounded, stale generations cannot overwrite a newer route.
- [ ] Logs: count, each recovery duration, max consecutive failures, final route.
- [ ] Pass/fail: PASS if no duplicate devices or stale-route regressions occur.

### 13. Two-hour soak

- [ ] Run the harness with `--duration 2h` in the final network and Quest configuration.
- [ ] Expected: no hangs, no unexplained timeout clusters, stable identity, bounded recovery, acceptable latency percentiles.
- [ ] Logs: JSON artifact and summary; retain Local Hub/cloud logs for the same time window.
- [ ] Pass/fail: PASS only with agreed numeric thresholds recorded by the team.

## Result rules

- `NOT RUN`: no real Quest was observed, or a required telemetry source/scenario was never executed. Fake-mode output cannot change this.
- `INCONCLUSIVE`: data or logs are incomplete, or Agent heartbeat telemetry was not configured for a test that requires it.
- `FAIL`: a required invariant was violated, such as identity mismatch acceptance, duplicate device creation, unbounded hang, unsafe replay, or unrecovered route.
- `PASS`: all steps for the scenario were executed, artifacts are retained, and the recorded evidence meets the pre-agreed thresholds.

The overall project must remain `NOT READY` until the physical scenarios above
are executed on the target Quest hardware and the resulting artifacts and
operator evidence are reviewed. A successful ADB soak alone is not a full
production readiness certificate.
