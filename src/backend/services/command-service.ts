import crypto from "crypto";
import type { SqliteDatabase, PermissionActor, CommandStatusOptions, CreateCommandInput } from "../db/types";
import { COMMAND_TRANSITIONS, TECHNICAL_COMMAND_TYPES, PACKAGE_NAME_PATTERN } from "../db/types";
import { assertNoRawCredentialFields, parseJsonObject, redactSecrets } from "../db/json";
import { formatSqliteTimestamp } from "../db/json";
import { assertActorCanAccessClub, assertRole, assertSubscriptionFeature } from "./authorization";
import { commandPayloadHash, canonicalCommandPayload, getCommandPolicy } from "../db/command-policy";
import { writeAuditLog } from "../repositories/audit";
import { getDeviceContext } from "../repositories/devices";
import { appendSessionEvent, buildSessionStatePayload, getActiveSessionRowForDevice, mapActiveSessionRow, refreshSessionAggregate, getActiveSessionForDevice } from "./session-state";

const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || "com.bizonvr.spatialspike";
const isValidPackageName = (packageName: string) => PACKAGE_NAME_PATTERN.test(packageName);
const COMMAND_TYPES = new Set([
  "PING", "REFRESH_STATUS", "INSTALL_APP", "INSTALL_APK", "UNINSTALL_APP", "LAUNCH_APP", "STOP_APP",
  "REBOOT_DEVICE", "OPEN_SCRCPY", "CLOSE_SCRCPY", "SHOW_MESSAGE", "START_SESSION", "PAUSE_SESSION",
  "RESUME_SESSION", "EXTEND_SESSION", "SWITCH_SESSION_APP", "END_SESSION", "OPEN_LAUNCHER", "RUN_DIAGNOSTICS", "FORGET_DEVICE",
]);

export function getCommandHubId(db: SqliteDatabase, commandId: number) {
  return db.prepare(`SELECT local_hub_id FROM device_commands WHERE id = ?`).get(commandId) as { local_hub_id: number } | undefined;
}
export function createDeviceCommand(db: SqliteDatabase, input: CreateCommandInput) {
  if (!COMMAND_TYPES.has(input.type)) {
    throw new Error(`Unsupported device command type: ${input.type}`);
  }
  if (input.type === "RUN_SHELL" || input.type === "EXECUTE_SHELL") {
    throw new Error("Arbitrary shell commands are not supported");
  }
  const payload = input.payload ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Command payload must be a JSON object");
  }
  assertNoRawCredentialFields(payload);
  for (const key of ["package", "package_name", "app_package", "current_app_package"]) {
    const candidate = payload[key];
    if (candidate !== undefined && (typeof candidate !== "string" || !isValidPackageName(candidate))) {
      throw new Error(`Invalid package name in command payload: ${key}`);
    }
  }
  const context = getDeviceContext(db, input.deviceId);
  if (!context) {
    throw new Error("Device not found");
  }
  assertActorCanAccessClub(input.actor, context.organization_id, context.club_id);
  assertRole(input.actor, TECHNICAL_COMMAND_TYPES.has(input.type) ? ["owner", "admin", "technician"] : ["owner", "admin", "operator", "technician"], "device command");
  if (TECHNICAL_COMMAND_TYPES.has(input.type)) {
    assertSubscriptionFeature(db, context.organization_id, input.type === "INSTALL_APK" ? "apk_upload" : "technical_commands");
  }
  if (input.type === "OPEN_SCRCPY") {
    assertSubscriptionFeature(db, context.organization_id, "scrcpy");
  }
  if (!context.local_hub_id || context.local_hub_id !== input.localHubId) {
    throw new Error("Device is not attached to the requested Local Hub");
  }
  if (input.type === "FORGET_DEVICE" && ["busy", "in_session"].includes(context.status)) {
    throw new Error("Device has an active session and cannot be removed");
  }

  const hub = db.prepare(`
    SELECT id, club_id, status FROM local_hubs WHERE id = ?
  `).get(input.localHubId) as { id: number; club_id: number; status: string } | undefined;
  if (!hub || hub.club_id !== context.club_id) {
    throw new Error("Local Hub is not in the same club as device");
  }

  const payloadJson = canonicalCommandPayload(payload);
  const payloadHash = commandPayloadHash(payloadJson);
  const policy = getCommandPolicy(input.type);
  const result = db.prepare(`
    INSERT INTO device_commands (
      organization_id, club_id, local_hub_id, device_id, session_id, type, payload, payload_sha256,
      status, max_attempts, target_stable_id, target_android_id, target_agent_id, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)
  `).run(
    context.organization_id,
    context.club_id,
    input.localHubId,
    input.deviceId,
    input.sessionId ?? null,
    input.type,
    payloadJson,
    payloadHash,
    policy.maxAttempts,
    context.stable_id || context.id.toString(),
    context.android_id,
    context.agent_id,
    input.createdByUserId ?? null,
  );

  writeAuditLog(db, {
    action: "device_command.created",
    entityType: "device_command",
    entityId: Number(result.lastInsertRowid),
    organizationId: context.organization_id,
    clubId: context.club_id,
    localHubId: input.localHubId,
    deviceId: input.deviceId,
    sessionId: input.sessionId ?? null,
    commandId: Number(result.lastInsertRowid),
    userId: input.createdByUserId ?? null,
    details: input,
  });

  return Number(result.lastInsertRowid);
}

export function listCommands(db: SqliteDatabase, actor?: PermissionActor | null) {
  const scope = actor ? `WHERE c.organization_id = ? AND dc.club_id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"})` : "";
  const rows = db.prepare(`SELECT dc.* FROM device_commands dc JOIN clubs c ON c.id = dc.club_id ${scope} ORDER BY dc.created_at DESC, dc.id DESC`)
    .all(...(actor ? [actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1])] : [])) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    payload: JSON.stringify(redactSecrets(parseJsonObject(String(row.payload ?? "{}")))),
    operator_state: row.status === "timeout" && row.outcome_state === "unknown"
      ? "result_unknown"
      : row.status === "created" || row.status === "sent_to_hub"
        ? "queued"
        : row.status === "accepted_by_hub"
          ? "sending_to_hub"
          : row.status === "running"
            ? "running"
            : row.status,
    retryable: getCommandPolicy(String(row.type)).retryable,
    safe_to_retry: getCommandPolicy(String(row.type)).retryable && row.status !== "running",
  }));
}

function applyAgentProvisioningResult(
  db: SqliteDatabase,
  command: { type: string; device_id: number; payload: string },
  status: string,
  result: Record<string, unknown> | null,
) {
  if (status !== "succeeded") return;
  const payload = parseJsonObject(command.payload);
  if (command.type !== "INSTALL_APK" || payload.target !== "quest_agent" || payload.rotate_agent_credential !== true) return;

  const agentTokenHash = result?.agent_token_hash;
  if (typeof agentTokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(agentTokenHash)) {
    throw new Error("Quest Agent provisioning requires a valid SHA-256 agent_token_hash result");
  }
  const updated = db.prepare(`
    UPDATE devices
    SET agent_token_hash = ?, agent_token_issued_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(agentTokenHash.toLowerCase(), command.device_id);
  if (updated.changes !== 1) throw new Error("Quest Agent provisioning target device was not found");
}

export function updateCommandStatus(
  db: SqliteDatabase,
  commandId: number,
  status: string,
  errorMessage?: string | null,
  options: CommandStatusOptions = {},
) {
  if (options.result !== undefined && options.result !== null) {
    assertNoRawCredentialFields(options.result, "result");
  }
  const command = db.prepare(`
    SELECT id, status, type, session_id, device_id, local_hub_id, payload, payload_sha256,
      claim_token, claimed_by, attempt, result_sha256, result_json, outcome_state
    FROM device_commands
    WHERE id = ?
  `).get(commandId) as
    | { id: number; status: string; type: string; session_id: number | null; device_id: number; local_hub_id: number;
        payload: string; payload_sha256?: string; claim_token?: string | null; claimed_by?: string | null; attempt: number;
        result_sha256?: string | null; result_json?: string | null; outcome_state?: string }
    | undefined;
  if (!command) {
    const tombstone = db.prepare(`SELECT command_id, status, result_sha256 FROM device_command_tombstones WHERE command_id = ?`).get(commandId) as { command_id: number; status: string; result_sha256: string | null } | undefined;
    if (tombstone && tombstone.status === status) {
      if (options.result && tombstone.result_sha256 && commandPayloadHash(options.result) !== tombstone.result_sha256) {
        throw new Error(`Command ${commandId} terminal result conflict`);
      }
      return { id: commandId, status, idempotent: true, tombstoned: true };
    }
    throw new Error("Command not found");
  }

  if (options.hubId !== undefined && options.hubId !== null && command.local_hub_id !== options.hubId) {
    throw new Error("Permission denied: command belongs to another Local Hub");
  }
  if (options.claimToken && command.claim_token && options.claimToken !== command.claim_token) {
    throw new Error("Command claim token is stale or belongs to another Hub instance");
  }

  const isTerminal = ["succeeded", "failed", "timeout", "cancelled"].includes(command.status);
  if (isTerminal && command.status === status) {
    const nextResult = options.result ? JSON.stringify(options.result) : null;
    const nextHash = options.result ? commandPayloadHash(options.result) : null;
    if (nextHash && command.result_sha256 && nextHash !== command.result_sha256) {
      throw new Error(`Command ${commandId} terminal result conflict`);
    }
    return { ...command, idempotent: true };
  }
  const reconciledUnknownOutcome = command.status === "timeout" && command.outcome_state === "unknown" && status === "succeeded" && options.reconciled === true;
  if (options.outcomeState && !["pending", "known", "unknown", "reconciled"].includes(options.outcomeState)) {
    throw new Error(`Invalid command outcome state: ${options.outcomeState}`);
  }
  if (!COMMAND_TRANSITIONS[command.status]?.includes(status) && !reconciledUnknownOutcome) {
    throw new Error(`Invalid command status transition: ${command.status} -> ${status}`);
  }

  const transitions: Record<string, string> = {
    accepted_by_hub: "accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP)",
    running: "started_at = COALESCE(started_at, CURRENT_TIMESTAMP)",
    succeeded: "finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)",
    failed: "finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)",
    timeout: "finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)",
    cancelled: "finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)",
  };

  const resultJson = options.result ? JSON.stringify(options.result) : null;
  const resultHash = options.result ? commandPayloadHash(options.result) : null;
  const outcomeState = options.outcomeState ?? (status === "succeeded" || status === "failed" ? "known" : status === "timeout" ? "unknown" : "pending");
  const transitionSql = transitions[status] ?? "";
  const tx = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE device_commands
      SET status = ?, error_code = ?, error_message = ?, outcome_state = ?, result_json = COALESCE(?, result_json),
          result_sha256 = COALESCE(?, result_sha256), last_transition_at = CURRENT_TIMESTAMP
          ${transitionSql ? `, ${transitionSql}` : ""}
      WHERE id = ? AND status = ?
    `).run(status, options.errorCode ?? null, errorMessage ?? null, outcomeState, resultJson, resultHash, commandId, command.status);
    if (updated.changes !== 1) {
      throw new Error(`Command ${commandId} status changed concurrently; refusing last-write-wins update`);
    }
    db.prepare(`
      INSERT INTO device_command_events (
        command_id, previous_status, new_status, hub_id, hub_instance_id, attempt, route, error_code, error_message, reconciled, result_delivery_attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(commandId, command.status, status, options.hubId ?? command.local_hub_id, options.hubInstanceId ?? command.claimed_by ?? null,
      command.attempt ?? 0, options.route ?? null, options.errorCode ?? null, errorMessage ?? null, options.reconciled ? 1 : 0, options.resultDeliveryAttempt ?? null);
    applyAgentProvisioningResult(db, command, status, options.result ?? null);
    applyCommandLifecycleSideEffects(db, { ...command, outcome_state: outcomeState, result_sha256: resultHash }, status, errorMessage ?? null);
  });
  tx();
  return { ...command, status, outcome_state: outcomeState, result_sha256: resultHash, idempotent: false };
}

export function cancelDeviceCommand(db: SqliteDatabase, commandId: number, actor?: PermissionActor | null) {
  const command = db.prepare(`
    SELECT dc.id, dc.status, dc.device_id, dc.local_hub_id, c.organization_id, c.id AS club_id
    FROM device_commands dc JOIN clubs c ON c.id = dc.club_id WHERE dc.id = ?
  `).get(commandId) as { id: number; status: string; device_id: number; local_hub_id: number; organization_id: number; club_id: number } | undefined;
  if (!command) throw new Error("Command not found");
  assertActorCanAccessClub(actor, command.organization_id, command.club_id);
  assertRole(actor, ["owner", "admin", "operator", "technician"], "cancel device command");
  if (["succeeded", "failed", "timeout", "cancelled"].includes(command.status)) {
    return { status: command.status, already_terminal: true };
  }
  if (command.status === "running") {
    db.prepare(`UPDATE device_commands SET cancel_requested_at = COALESCE(cancel_requested_at, CURRENT_TIMESTAMP), last_transition_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`).run(commandId);
    db.prepare(`INSERT INTO device_command_events (command_id, previous_status, new_status, hub_id, error_code, error_message) VALUES (?, 'running', 'running', ?, 'COMMAND_CANCEL_REQUESTED', 'Cancellation requested; the physical operation may already be in progress')`).run(commandId, command.local_hub_id);
    return { status: "running", cancel_requested: true };
  }
  updateCommandStatus(db, commandId, "cancelled", "Cancelled before execution", { errorCode: "COMMAND_CANCELLED" });
  return { status: "cancelled", cancel_requested: false };
}

function applyCommandLifecycleSideEffects(
  db: SqliteDatabase,
  command: { id: number; type: string; session_id: number | null; device_id: number; payload: string; outcome_state?: string; result_sha256?: string | null },
  status: string,
  errorMessage: string | null,
) {
  if (status === "timeout" && command.outcome_state === "unknown" && command.session_id) {
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "command_outcome_unknown",
      severity: "critical",
      message: errorMessage ?? "Local Hub lost the result; physical session state requires reconciliation",
      payload: { command_status: status, outcome_state: command.outcome_state },
    });
    return;
  }
  if (status === "running" && command.type === "START_SESSION" && command.session_id) {
    db.prepare(`UPDATE sessions SET status = 'starting', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('preparing', 'ready')`).run(command.session_id);
    db.prepare(`INSERT INTO session_events (session_id, device_id, type, severity, message, payload) VALUES (?, ?, 'session_start_running', 'info', 'Local Hub started executing the session start command', ?)`)
      .run(command.session_id, command.device_id, JSON.stringify({ command_id: command.id }));
  }
  if (command.type === "FORGET_DEVICE" && status === "succeeded") {
    const device = db.prepare(`
      SELECT d.id, d.club_id, d.local_hub_id, c.organization_id
      FROM devices d
      JOIN clubs c ON c.id = d.club_id
      WHERE d.id = ?
    `).get(command.device_id) as
      | { id: number; club_id: number; local_hub_id: number | null; organization_id: number }
      | undefined;

      if (device) {
      db.prepare(`INSERT OR IGNORE INTO device_command_tombstones (command_id, type, status, result_sha256) VALUES (?, ?, 'succeeded', ?)`)
        .run(command.id, command.type, command.result_sha256 ?? null);
      writeAuditLog(db, {
        action: "device.deleted",
        entityType: "device",
        entityId: device.id,
        organizationId: device.organization_id,
        clubId: device.club_id,
        localHubId: device.local_hub_id,
        deviceId: device.id,
        details: { source: "forget_device_command" },
      });

      db.prepare(`DELETE FROM devices WHERE id = ?`).run(device.id);
    }
    return;
  }

  if (!["succeeded", "failed", "timeout", "cancelled"].includes(status) || !command.session_id) {
    return;
  }

  const payload = parseJsonObject(command.payload);
  const sessionState = payload.session_state && typeof payload.session_state === "object"
    ? payload.session_state as Record<string, unknown>
    : null;
  const previousSessionState = payload.previous_session_state && typeof payload.previous_session_state === "object"
    ? payload.previous_session_state as Record<string, unknown>
    : null;

  const restoreSessionState = (state: Record<string, unknown> | null | undefined, expectedOperationState: string) => {
    if (!state || !command.session_id) {
      return;
    }
    const restored = db.prepare(`
      UPDATE session_devices
      SET
        status = ?,
        paused_at = ?,
        total_paused_seconds = ?,
        paused_remaining_seconds = ?,
        current_app_package = ?,
        current_app_name = ?,
        last_app_switch_at = ?,
        desired_app_package = NULL,
        desired_app_activity = NULL,
        operation_state = 'idle',
        updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND device_id = ?
        AND operation_state = ?
    `).run(
      String(state.session_status) === "paused" ? "paused" : "running",
      state.paused ? (state.paused_at ? String(state.paused_at) : formatSqliteTimestamp(new Date())) : null,
      Number(state.total_paused_seconds ?? 0),
      state.paused ? Number(state.remaining_seconds ?? 0) : null,
      String(state.current_app_package ?? payload.package ?? QUEST_AGENT_PACKAGE),
      state.current_app_name ? String(state.current_app_name) : null,
      state.last_app_switch_at ? String(state.last_app_switch_at) : null,
      command.session_id,
      command.device_id,
      expectedOperationState,
    );
    if (restored.changes !== 1) return;
    db.prepare(`
      UPDATE sessions
      SET status = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed', 'finishing')
    `).run(String(state.session_status) === "paused" ? "paused" : "running", command.session_id);
  };

  if (command.type === "START_SESSION") {
    if (status === "succeeded") {
      const session = db.prepare(`SELECT duration_minutes, extension_minutes FROM sessions WHERE id = ?`).get(command.session_id) as
        | { duration_minutes: number; extension_minutes: number }
        | undefined;
      const updatedDevice = db.prepare(`
        UPDATE session_devices
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            current_app_package = ?,
            current_app_name = COALESCE(?, current_app_name),
            desired_app_package = NULL,
            desired_app_activity = NULL,
            operation_state = 'idle',
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND device_id = ? AND operation_state = 'start_pending'
      `).run(
        String(payload.package ?? QUEST_AGENT_PACKAGE),
        payload.app_name ? String(payload.app_name) : null,
        command.session_id,
        command.device_id,
      );
      if (updatedDevice.changes !== 1) return;
      db.prepare(`
        UPDATE sessions
        SET started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            ends_at = COALESCE(ends_at, datetime(CURRENT_TIMESTAMP, '+' || (? + ?) || ' minutes')),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('preparing', 'ready', 'starting', 'running')
      `).run(session?.duration_minutes ?? 0, session?.extension_minutes ?? 0, command.session_id);
      refreshSessionAggregate(db, command.session_id);
      db.prepare(`
        UPDATE devices
        SET status = 'in_session', current_app_package = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(String(payload.package ?? QUEST_AGENT_PACKAGE), command.device_id);
      appendSessionEvent(db, {
        sessionId: command.session_id,
        deviceId: command.device_id,
        type: "session_device_started",
        message: `Local Hub confirmed session start for device ${command.device_id}`,
        payload: { command_status: status },
      });
      return;
    }

    db.prepare(`
      UPDATE session_devices
      SET status = 'failed', operation_state = 'idle', end_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND device_id = ? AND operation_state = 'start_pending'
    `).run(errorMessage ?? status, command.session_id, command.device_id);
    db.prepare(`
      UPDATE devices
      SET status = 'error', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(command.device_id);
    refreshSessionAggregate(db, command.session_id);
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "session_start_failed",
      severity: "critical",
      message: errorMessage ?? `Local Hub reported ${status} while starting session`,
      payload: { command_status: status },
    });
  }

  if (command.type === "PAUSE_SESSION") {
    if (status === "succeeded") {
      db.prepare(`UPDATE session_devices SET operation_state = 'idle', updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND device_id = ? AND operation_state = 'pause_pending'`).run(command.session_id, command.device_id);
      db.prepare(`
        UPDATE devices
        SET status = 'in_session', current_app_package = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(QUEST_AGENT_PACKAGE, command.device_id);
      appendSessionEvent(db, {
        sessionId: command.session_id,
        deviceId: command.device_id,
        type: "session_pause_confirmed",
        message: `Local Hub confirmed session pause for device ${command.device_id}`,
        payload: { command_status: status },
      });
      return;
    }

    restoreSessionState(previousSessionState, "pause_pending");
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "session_pause_failed",
      severity: "warning",
      message: errorMessage ?? `Local Hub reported ${status} while pausing session`,
      payload: { command_status: status },
    });
    return;
  }

  if (command.type === "RESUME_SESSION") {
    if (status === "succeeded") {
      db.prepare(`UPDATE session_devices SET operation_state = 'idle', updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND device_id = ? AND operation_state = 'resume_pending'`).run(command.session_id, command.device_id);
      db.prepare(`
        UPDATE devices
        SET status = 'in_session', current_app_package = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(String(payload.current_app_package ?? payload.package ?? QUEST_AGENT_PACKAGE), command.device_id);
      appendSessionEvent(db, {
        sessionId: command.session_id,
        deviceId: command.device_id,
        type: "session_resume_confirmed",
        message: `Local Hub confirmed session resume for device ${command.device_id}`,
        payload: { command_status: status },
      });
      return;
    }

    restoreSessionState(previousSessionState, "resume_pending");
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "session_resume_failed",
      severity: "warning",
      message: errorMessage ?? `Local Hub reported ${status} while resuming session`,
      payload: { command_status: status },
    });
    return;
  }

  if (command.type === "EXTEND_SESSION") {
    if (status === "succeeded") {
      db.prepare(`UPDATE session_devices SET operation_state = 'idle', updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND device_id = ? AND operation_state = 'extend_pending'`).run(command.session_id, command.device_id);
      appendSessionEvent(db, {
        sessionId: command.session_id,
        deviceId: command.device_id,
        type: "session_extension_confirmed",
        message: `Local Hub confirmed session extension for device ${command.device_id}`,
        payload: { command_status: status },
      });
      return;
    }
    db.prepare(`UPDATE session_devices SET operation_state = 'reconciliation_required', updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND device_id = ? AND operation_state = 'extend_pending'`).run(command.session_id, command.device_id);
    db.prepare(`UPDATE sessions SET recovery_state = 'reconciliation_required', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('completed', 'cancelled')`).run(command.session_id);
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "session_extension_failed",
      severity: "warning",
      message: errorMessage ?? `Local Hub reported ${status} while extending session`,
      payload: { command_status: status },
    });
    return;
  }

  if (command.type === "SWITCH_SESSION_APP") {
    if (status === "succeeded") {
      db.prepare(`
        UPDATE session_devices
        SET desired_app_package = NULL, desired_app_activity = NULL, operation_state = 'idle', updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND device_id = ? AND operation_state = 'switch_pending'
      `).run(command.session_id, command.device_id);
      db.prepare(`
        UPDATE devices
        SET status = 'in_session',
            current_app_package = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        sessionState?.session_status === "paused"
          ? QUEST_AGENT_PACKAGE
          : String(payload.package ?? payload.current_app_package ?? QUEST_AGENT_PACKAGE),
        command.device_id,
      );
      appendSessionEvent(db, {
        sessionId: command.session_id,
        deviceId: command.device_id,
        type: "session_app_switch_confirmed",
        message: `Local Hub confirmed app switch for session ${command.session_id}`,
        payload: { command_status: status, current_app_package: payload.package ?? null },
      });
      return;
    }

    restoreSessionState(previousSessionState, "switch_pending");
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "session_app_switch_failed",
      severity: "warning",
      message: errorMessage ?? `Local Hub reported ${status} while switching session app`,
      payload: { command_status: status },
    });
    return;
  }

  if (command.type === "END_SESSION") {
    if (status === "succeeded") {
      db.prepare(`
      UPDATE session_devices
        SET status = 'finished', operation_state = 'idle', desired_app_package = NULL, desired_app_activity = NULL,
            finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND device_id = ? AND operation_state = 'finish_pending'
      `).run(command.session_id, command.device_id);
      db.prepare(`
        UPDATE devices
        SET status = 'online',
            current_app_package = ?,
            needs_operator_help = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(QUEST_AGENT_PACKAGE, command.device_id);
      appendSessionEvent(db, {
        sessionId: command.session_id,
        deviceId: command.device_id,
        type: "session_device_finished",
        message: `Local Hub confirmed session finish for device ${command.device_id}`,
        payload: { return_to_launcher: true },
      });

      const remaining = db.prepare(`
        SELECT COUNT(*) AS count
        FROM session_devices
        WHERE session_id = ? AND status IN ('preparing', 'ready', 'running', 'paused')
      `).get(command.session_id) as { count: number };
      if (remaining.count === 0) {
        db.prepare(`
          UPDATE sessions
          SET status = 'completed', recovery_state = 'none', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP), revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'finishing'
        `).run(command.session_id);
      }
      return;
    }

    const failedDevice = db.prepare(`
      UPDATE session_devices
      SET status = 'failed', end_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND device_id = ? AND operation_state = 'finish_pending'
    `).run(errorMessage ?? status, command.session_id, command.device_id);
    if (failedDevice.changes !== 1) return;
    db.prepare(`
      UPDATE devices SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(command.device_id);
    db.prepare(`
      UPDATE sessions SET status = 'failed', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'finishing'
    `).run(command.session_id);
    appendSessionEvent(db, {
      sessionId: command.session_id,
      deviceId: command.device_id,
      type: "session_finish_failed",
      severity: "critical",
      message: errorMessage ?? `Local Hub reported ${status} while finishing session`,
      payload: { command_status: status },
    });
  }
}
