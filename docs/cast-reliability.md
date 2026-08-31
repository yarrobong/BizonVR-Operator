# Cast / video stream reliability

## Production lifecycle

The Local Hub owns one capture producer per stable Quest identity. A producer is
`adb exec-out screenrecord` piped to `ffmpeg`; viewers are HTTP subscribers to
that producer. The registry key is `stableSerial`, never an IP address or a
temporary ADB route.

```text
idle -> starting -> streaming
                 |        |
                 v        v
              failed <- reconnecting
                 |
              stopping -> removed from registry
```

`local-hub/cast-manager.js` is the lifecycle owner. It enforces:

- single-flight start and one producer for multiple viewers;
- generation tokens, so stale process callbacks cannot stop a replacement;
- readiness on the first non-empty output chunk, not merely process spawn;
- boot timeout cleanup and actionable pre-header failure responses;
- bounded recovery (three attempts by default) with a freshly resolved and
  identity-verified ADB route;
- idempotent SIGTERM, grace period, SIGKILL escalation, and awaited process exit;
- response/request close and abort cleanup;
- no unbounded viewer queue. Chunks are dropped for a blocked viewer and the
  viewer is disconnected after the configured timeout;
- automatic producer stop after the last viewer disconnects (one-second grace).

The screenshot transport uses the same manager and is an explicit diagnostic
transport. If the primary video producer fails before readiness, the manager
records the primary failure and starts the screenshot fallback. A fallback
failure is surfaced as `STREAM_CAPTURE_FAILED`; it is not hidden as a healthy
cast.

## Resource policy

Defaults are conservative and configurable through Local Hub environment:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `MAX_CONCURRENT_CASTS` | `4` | Producers per Hub |
| `MAX_CAST_VIEWERS` | `4` | Viewers per Quest producer |
| `CAST_MAX_PENDING_BYTES` | `2097152` | Per-viewer response buffer ceiling |
| `CAST_SLOW_VIEWER_TIMEOUT_MS` | `5000` | Dead/slow viewer cutoff |
| `CAST_NO_VIEWER_STOP_MS` | `1000` | Last-viewer producer stop grace |
| `CAST_RECOVERY_ATTEMPTS` | `3` | Maximum automatic restarts |
| `CAST_RECOVERY_BASE_DELAY_MS` | `250` | Exponential recovery backoff base |
| `CAST_TERM_GRACE_MS` / `CAST_KILL_GRACE_MS` | `1000` | Process termination bounds |

`low-latency`, `balanced`, and `performance` profiles remain bounded at 30/30/15
fps and 10/14/4 Mbps. The browser default is `low-latency` fMP4; MJPEG is for
preview/diagnostics.

## Observability

Structured cast records include `castId`, `generation`, stable identity, route,
transport, profile, state, PIDs, viewer count, first-frame latency, bytes,
restart count, stop reason, exit diagnostics, backpressure events, and dropped
chunks. Aggregate counters are exposed by the manager for integration with the
Hub monitoring adapter: starts, successes/failures, active casts, restarts,
process crashes, boot timeouts, viewer disconnects, slow-viewer disconnects,
bytes, first-frame latency, and duration.

## Tests and hardware validation

Code-level fault injection is in `tests/cast-manager.test.ts`. It covers
single-flight, fan-out, close/abort behavior, slow/dead viewers, boot timeout,
fallback, process crash, stale generations, route replacement, wrong-route
rejection, resource limits, ten-Quest isolation, idempotent stop, SIGKILL
fallback, and 1000 lifecycle iterations.

Run it with:

```bash
npx tsx --test tests/cast-manager.test.ts
```

For a real Quest, use:

```bash
node scripts/cast-hardware-soak.js \
  --device 192.168.1.35:5555 \
  --api-url http://192.168.1.10:3001 \
  --duration 30m --interval 5s --profile low-latency \
  --output artifacts/cast-soak/quest-35.json
```

The harness reports `NOT RUN` when the requested ADB route is absent and never
manufactures a hardware pass from fake or empty input. Hardware metrics to
collect later include first-frame latency, uptime, process exits, recovery time,
bytes/sec, viewer disconnects, Hub CPU/RAM, and interruptions.
