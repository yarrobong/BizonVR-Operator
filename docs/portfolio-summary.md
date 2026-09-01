# BizonVR Operator — Portfolio Summary

## Problem

Running a VR club is a distributed operations problem disguised as a device
dashboard. An operator needs to start and finish synchronized sessions, see
which Quest is usable, recover from flaky ADB/Wi-Fi routes, and understand when
an action failed. A cloud panel alone cannot reach headsets safely or
reliably, while a purely local tool loses organization, subscription, and audit
context.

## Architecture

The repository implements a Cloud/API and LAN-local split:

```text
React Web Panel
        -> Express API + SQLite command/session journal
        <-> authenticated Local Hub sync
             -> typed command worker
                -> verified ADB / scrcpy / ffmpeg / Quest Agent HTTP
                   -> Meta Quest
```

The API is responsible for authentication, tenant/club authorization,
subscription checks, durable state, session transitions, and command claims.
The Local Hub is the only component allowed to run ADB or casting processes. It
keeps a local cache/journal for short connectivity interruptions and reports
structured outcomes back to the API. The Android Agent complements ADB with a
pairing-bound heartbeat, launcher/session state, player messaging, and an
operator-call flow.

## Engineering challenges

- Device connectivity is not binary: USB, Wi-Fi ADB, Agent heartbeat, stable
  identity, and the current route can disagree.
- Cloud-to-Hub delivery needs leases, ordering, retries, and recovery from a
  result that may have been lost after the physical side effect happened.
- Session timers must survive refreshes and restarts without creating a second
  active session or declaring completion before cleanup is confirmed.
- Agent provisioning crosses the cloud/LAN/device boundary and must avoid
  storing or logging the raw credential in Cloud data.
- APK installation needs artifact identity and checksum verification before a
  filesystem path reaches ADB.
- Casting is a process lifecycle: one producer per Quest, multiple viewers,
  bounded buffering, fallback transport, and cleanup on abort or crash.

## Key decisions

### Express and TypeScript

The current API uses Express and TypeScript because the repository already has
a compact, testable HTTP/domain boundary and shares practical types with the
operator UI. Route handlers stay thin while authorization, session, command,
and sync services own business rules.

### SQLite for the current runtime

`better-sqlite3` provides a file-backed, transactional MVP runtime with ordered
SQL migrations, foreign keys, WAL mode, and no external database service
required for local development or CI. PostgreSQL/Redis were explored as future
deployment options, but are not presented as implemented infrastructure.

### Separate Local Hub

ADB and scrcpy are intentionally kept on the club computer. This prevents the
Cloud API from becoming a remote shell gateway and makes LAN reachability,
process ownership, and recovery explicit. Cloud sends typed commands; the Hub
maps them to a fixed handler set.

### Android Agent alongside ADB

ADB is useful for install, launch, recovery, and diagnostics, but it is not a
good primary online signal. The Agent supplies heartbeat freshness and device
identity plus the player-facing launcher/session surface. The current Android
path is retained under the historical project name
`quest-agent-spatial-spike`.

### Durable reconciliation

The system does not assume that a lost HTTP response means a failed device
operation. Command leases, result hashes, per-device serialization, stable
identity checks, and evidence-based reconciliation make unknown outcomes
visible and prevent blind replay of dangerous actions.

## Validation

The current automated baseline passes:

- Node lint/type validation;
- 134 Node tests across 23 suites, including authorization, tenant isolation,
  command/session state machines, ADB routing/recovery, casting, APK safety,
  migrations, and audit behavior;
- Vite frontend and bundled server build;
- Local Hub JavaScript syntax checks;
- Android unit tests and `assembleDebug` for the current Quest Agent path;
- GitHub Actions checks named `Node / verify` and `Android / verify`.

## Current limitation

Physical Meta Quest end-to-end validation remains pending. The repository does
not claim production deployment or production-scale multi-club load testing.
Hardware soak/manual plans are documented separately so those claims can be
added only after real-device evidence exists.
