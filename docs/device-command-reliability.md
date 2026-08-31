# DeviceCommand pipeline reliability

## Contract

The pipeline uses **at-least-once delivery** with idempotent execution, per-device ordering, claim leases, duplicate suppression and durable result reconciliation. It does not claim exactly-once ADB semantics: an ADB process can apply an effect and lose its response before the Hub knows that it completed. In that case the operator sees `result_unknown` until a reconciliation probe proves success or the operation is manually resolved.

The Cloud never runs ADB. Only the assigned Local Hub can claim a command, and the Hub is the only component that executes the allow-listed command handlers.

## Command lifecycle

```text
created -> accepted_by_hub -> running -> succeeded
                                  |       failed
                                  |       timeout (outcome_state=unknown)
                                  |       cancelled
```

`device_commands` stores the command payload hash, target Quest identity, claim owner/token, lease, attempt budget, error code, result hash and outcome state. `device_command_events` is the compact lifecycle audit trail. Status writes are conditional on the previously read status; a stale writer cannot perform a last-write-wins update.

Successful `FORGET_DEVICE` keeps a small `device_command_tombstones` record before removing the Quest inventory row, so a repeated terminal response remains idempotent even though the device itself is gone.

`succeeded`, `failed`, `timeout` and `cancelled` are terminal at the status level. `timeout` is not necessarily a physical failure: `outcome_state=unknown` means that the side effect may have happened. An explicit reconciliation may move this one case from `timeout` to `succeeded` with `reconciled=true`.

## Claim and ordering

`POST /api/hubs/:id/sync` claims commands in one SQLite transaction. A claim contains `claimed_by`, a random `claim_token`, a 45-second `lease_until` and an attempt number. The query selects only the head command for each device, so `INSTALL -> START`, `START_SESSION -> END_SESSION`, and app switches cannot overtake one another. Different devices have independent locks and are processed concurrently by the Hub.

The same live claim may be returned by a duplicate poll with the same token; the Hub journal suppresses the second execution. An expired claim is reassigned with a new token. A late result carrying the old token is rejected. Production deployments may use `HUB_TOKENS_JSON` for per-Hub credentials; `HUB_TOKEN` remains the single-Hub development configuration.

## Identity and integrity

The command records `target_stable_id`, `target_android_id` and `target_agent_id` at creation. Before an ADB side effect, the Hub verifies the resolved route using stable serial and, when available, `android_id`. IP addresses and USB/Wi-Fi routes are transport details, not identity. A command ID is permanently bound to its canonical payload SHA-256; reusing the ID with a different payload or target is an integrity violation.

## Local journal and result outbox

The Hub persists execution state in `.cache/local-hub/command-state.sqlite`. Its journal records `received`, `running`, `effect_applied`, `completed`, `unknown_outcome` or `cancelled`. A terminal result is written to `result_outbox` in the same local transaction as completion. The Hub retries result delivery with exponential backoff, a maximum of eight delivery attempts per pass, and retains undelivered results for later recovery. Cloud accepts an identical terminal result repeatedly and rejects an incompatible result hash.

Completed journal/outbox rows are pruned after 30 days (with a row cap), while pending results are never silently discarded.

## Restart and crash recovery

- Before journal claim: the Cloud command remains durable and is claimed after the next sync.
- After claim/running but before an effect: safe-to-retry commands may continue; dangerous commands are not blindly replayed.
- After an effect and before local completion: reconcilable commands use a probe first. Launch/session commands inspect the foreground package; install commands inspect package presence/version; uninstall/stop commands inspect absence/not-foreground. Reboot, forget and other non-probed operations become `COMMAND_OUTCOME_UNKNOWN`.
- After local completion but before Cloud ACK: the outbox resends the exact result. No new ADB effect is run.

This closes the critical `effect -> ACK` crash window without pretending that ADB itself provides a transactional commit.

An unknown outcome is also a per-device queue barrier: later commands for that Quest wait until reconciliation succeeds or an operator resolves the command.

## Policies and retry

The registry in `local-hub/command-reliability.js` defines timeout, retryability, idempotence, reconciliation and danger. Status/diagnostic/read-like commands have bounded transport retries. Installation, session mutations, uninstall, reboot and forget are not blindly retried. `REBOOT_DEVICE` and `FORGET_DEVICE` have one physical attempt. ADB transport timeout on a dangerous command is reported as unknown, not definitive failed.

## Cancellation

Commands in `created`, `sent_to_hub` or `accepted_by_hub` can become `cancelled` before execution. A running command records `cancel_requested_at`; it is not labelled cancelled while its physical operation may still be active. Cancellation of an APK install or session mutation therefore remains visible as a request until the actual outcome is known.

## Sessions and operator states

Session lifecycle side effects are applied only from a command result. A successful start makes the device/session running; a known failure marks the session failed. An unknown timeout creates a critical `command_outcome_unknown` event and does not claim that the session failed. API command rows expose `operator_state`: `queued`, `sending_to_hub`, `running`, `result_unknown`, or the terminal status, together with `error_code`, `next_operator_step` and retry safety.

## Remaining limits

ADB `reboot`, `forget` and any future handler without a reliable probe cannot provide exactly-once physical semantics. A result can also remain pending if Cloud is unavailable longer than the bounded delivery attempts; it stays durable and is retried on subsequent Hub syncs. Production should provision per-Hub tokens and monitor `CLOUD_RESULT_DELIVERY_FAILED`, `COMMAND_OUTCOME_UNKNOWN`, lease reclamation and growing outbox depth.
