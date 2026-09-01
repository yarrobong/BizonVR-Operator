import type { SqliteDatabase, AgentHeartbeat, PermissionActor } from "../db/types";
import { ACTIVE_SESSION_DEVICE_STATUSES, ACTIVE_SESSION_STATUSES, TERMINAL_SESSION_STATUSES, SESSION_STATUS_TRANSITIONS } from "../db/types";
import { formatSqliteTimestamp, parseJsonObject, parseSqliteTimestamp, redactSecrets } from "../db/json";
export function appendSessionEvent(
  db: SqliteDatabase,
  input: {
    sessionId: number;
    sessionDeviceId?: number | null;
    deviceId?: number | null;
    type: string;
    severity?: string;
    message: string;
    payload?: Record<string, unknown>;
  },
) {
  db.prepare(`
    INSERT INTO session_events (session_id, session_device_id, device_id, type, severity, message, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.sessionDeviceId ?? null,
    input.deviceId ?? null,
    input.type,
    input.severity ?? "info",
    input.message,
    JSON.stringify(redactSecrets(input.payload ?? {})),
  );
}

type ActiveSessionRow = {
  session_id: number;
  device_id: number;
  session_device_id: number;
  local_hub_id: number | null;
  club_id: number;
  organization_id: number;
  session_status: string;
  session_device_status: string;
  duration_minutes: number;
  extension_minutes: number;
  started_at: string | null;
  finished_at: string | null;
  paused_at: string | null;
  total_paused_seconds: number;
  paused_remaining_seconds: number | null;
  launch_package_name: string;
  launch_app_name: string | null;
  current_app_package: string | null;
  current_app_name: string | null;
  last_app_switch_at: string | null;
  session_revision: number;
  session_recovery_state: string;
  device_revision: number;
  operation_state: string;
  desired_app_package: string | null;
  desired_app_activity: string | null;
  last_command_id: number | null;
  agent_session_id: number | null;
  last_agent_timestamp_ms: number | null;
};

export type ActiveSessionSummary = {
  session_id: number;
  device_id: number;
  session_device_id: number;
  duration_seconds: number;
  started_at: string | null;
  finished_at: string | null;
  paused_at: string | null;
  total_paused_seconds: number;
  remaining_seconds: number;
  status: "starting" | "running" | "paused" | "finishing" | "ended";
  app_package: string;
  app_name: string | null;
  current_app_package: string;
  current_app_name: string | null;
  last_app_switch_at: string | null;
  is_expired: boolean;
  revision?: number;
  operation_state?: string;
  desired_app_package?: string | null;
  recovery_state?: string;
};

export function resolveAppName(db: SqliteDatabase, packageName: string | null | undefined) {
  if (!packageName) {
    return null;
  }
  const row = db.prepare(`SELECT name FROM apps WHERE package_name = ? LIMIT 1`).get(packageName) as { name: string } | undefined;
  return row?.name ?? null;
}

export function getSessionDurationSeconds(row: Pick<ActiveSessionRow, "duration_minutes" | "extension_minutes">) {
  return Math.max(0, (Number(row.duration_minutes) + Number(row.extension_minutes || 0)) * 60);
}

export function computeRemainingSeconds(row: Pick<ActiveSessionRow, "duration_minutes" | "extension_minutes" | "started_at" | "paused_at" | "paused_remaining_seconds" | "total_paused_seconds" | "session_device_status" | "finished_at">, now = new Date()) {
  const durationSeconds = getSessionDurationSeconds(row);
  if (row.finished_at) {
    return 0;
  }
  if (!row.started_at) {
    return durationSeconds;
  }
  if (row.session_device_status === "paused" && row.paused_remaining_seconds !== null) {
    return Math.max(0, Number(row.paused_remaining_seconds));
  }

  const startedAt = parseSqliteTimestamp(row.started_at);
  if (!startedAt) {
    return durationSeconds;
  }

  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
  const pausedSeconds = Math.max(0, Number(row.total_paused_seconds || 0));
  return Math.max(0, durationSeconds - Math.max(0, elapsedSeconds - pausedSeconds));
}

export function mapActiveSessionRow(row: ActiveSessionRow | undefined | null, now = new Date()): ActiveSessionSummary | null {
  if (!row) {
    return null;
  }
  const remainingSeconds = computeRemainingSeconds(row, now);
  const currentAppPackage = row.current_app_package ?? row.launch_package_name;
  const currentAppName = row.current_app_name ?? row.launch_app_name ?? null;
  const status = row.finished_at
    ? "ended"
    : row.session_status === "finishing"
      ? "finishing"
      : ["preparing", "ready", "starting"].includes(row.session_status)
        ? "starting"
    : row.session_device_status === "paused"
      ? "paused"
      : "running";

  return {
    session_id: row.session_id,
    device_id: row.device_id,
    session_device_id: row.session_device_id,
    duration_seconds: getSessionDurationSeconds(row),
    started_at: row.started_at,
    finished_at: row.finished_at,
    paused_at: row.paused_at,
    total_paused_seconds: Number(row.total_paused_seconds || 0),
    remaining_seconds: remainingSeconds,
    status,
    app_package: row.launch_package_name,
    app_name: row.launch_app_name ?? null,
    current_app_package: currentAppPackage,
    current_app_name: currentAppName,
    last_app_switch_at: row.last_app_switch_at,
    is_expired: remainingSeconds <= 0 && !row.finished_at,
    revision: Number(row.device_revision ?? row.session_revision ?? 0),
    operation_state: row.operation_state ?? "idle",
    desired_app_package: row.desired_app_package ?? null,
    recovery_state: row.session_recovery_state ?? "none",
  };
}

export function getActiveSessionRowForDevice(db: SqliteDatabase, deviceId: number) {
  return db.prepare(`
    SELECT
      s.id AS session_id,
      sd.device_id,
      sd.id AS session_device_id,
      d.local_hub_id,
      s.club_id,
      s.organization_id,
      s.status AS session_status,
      sd.status AS session_device_status,
      s.duration_minutes,
      s.extension_minutes,
      sd.started_at,
      sd.finished_at,
      sd.paused_at,
      sd.total_paused_seconds,
      sd.paused_remaining_seconds,
      sd.launch_package_name,
      launch_app.name AS launch_app_name,
      COALESCE(sd.current_app_package, sd.launch_package_name) AS current_app_package,
      COALESCE(sd.current_app_name, current_app.name, launch_app.name) AS current_app_name,
      sd.last_app_switch_at,
      s.revision AS session_revision,
      s.recovery_state AS session_recovery_state,
      sd.revision AS device_revision,
      sd.operation_state,
      sd.desired_app_package,
      sd.desired_app_activity,
      sd.last_command_id,
      sd.agent_session_id,
      sd.last_agent_timestamp_ms
    FROM session_devices sd
    JOIN sessions s ON s.id = sd.session_id
    JOIN devices d ON d.id = sd.device_id
    LEFT JOIN apps launch_app ON launch_app.package_name = sd.launch_package_name
    LEFT JOIN apps current_app ON current_app.package_name = sd.current_app_package
    WHERE sd.device_id = ?
      AND sd.status IN (${ACTIVE_SESSION_DEVICE_STATUSES.map(() => "?").join(",")})
      AND s.status IN (${ACTIVE_SESSION_STATUSES.map(() => "?").join(",")})
    ORDER BY COALESCE(sd.started_at, s.created_at) DESC, s.id DESC
    LIMIT 1
  `).get(deviceId, ...ACTIVE_SESSION_DEVICE_STATUSES, ...ACTIVE_SESSION_STATUSES) as ActiveSessionRow | undefined;
}

export function getActiveSessionForDevice(db: SqliteDatabase, deviceId: number) {
  return mapActiveSessionRow(getActiveSessionRowForDevice(db, deviceId));
}

export function getActiveSessionRowBySessionId(db: SqliteDatabase, sessionId: number) {
  return db.prepare(`
    SELECT
      s.id AS session_id,
      sd.device_id,
      sd.id AS session_device_id,
      d.local_hub_id,
      s.club_id,
      s.organization_id,
      s.status AS session_status,
      sd.status AS session_device_status,
      s.duration_minutes,
      s.extension_minutes,
      sd.started_at,
      sd.finished_at,
      sd.paused_at,
      sd.total_paused_seconds,
      sd.paused_remaining_seconds,
      sd.launch_package_name,
      launch_app.name AS launch_app_name,
      COALESCE(sd.current_app_package, sd.launch_package_name) AS current_app_package,
      COALESCE(sd.current_app_name, current_app.name, launch_app.name) AS current_app_name,
      sd.last_app_switch_at,
      s.revision AS session_revision,
      s.recovery_state AS session_recovery_state,
      sd.revision AS device_revision,
      sd.operation_state,
      sd.desired_app_package,
      sd.desired_app_activity,
      sd.last_command_id,
      sd.agent_session_id,
      sd.last_agent_timestamp_ms
    FROM sessions s
    JOIN session_devices sd ON sd.session_id = s.id
    JOIN devices d ON d.id = sd.device_id
    LEFT JOIN apps launch_app ON launch_app.package_name = sd.launch_package_name
    LEFT JOIN apps current_app ON current_app.package_name = sd.current_app_package
    WHERE s.id = ?
      AND sd.status IN (${ACTIVE_SESSION_DEVICE_STATUSES.map(() => "?").join(",")})
      AND s.status IN (${ACTIVE_SESSION_STATUSES.map(() => "?").join(",")})
    ORDER BY sd.id ASC
    LIMIT 1
  `).get(sessionId, ...ACTIVE_SESSION_DEVICE_STATUSES, ...ACTIVE_SESSION_STATUSES) as ActiveSessionRow | undefined;
}

export function resolveActiveSessionReference(db: SqliteDatabase, referenceId: number, mode: "session" | "device" | "either" = "either") {
  if (mode === "session") {
    return getActiveSessionRowBySessionId(db, referenceId);
  }
  if (mode === "device") {
    return getActiveSessionRowForDevice(db, referenceId);
  }
  return getActiveSessionRowBySessionId(db, referenceId) ?? getActiveSessionRowForDevice(db, referenceId);
}

export function buildSessionStatePayload(summary: ActiveSessionSummary) {
  return {
    session_id: summary.session_id,
    session_status: summary.status,
    remaining_seconds: summary.remaining_seconds,
    duration_seconds: summary.duration_seconds,
    current_app_package: summary.current_app_package,
    current_app_name: summary.current_app_name,
    app_package: summary.app_package,
    app_name: summary.app_name,
    paused: summary.status === "paused",
    started_at: summary.started_at,
    last_app_switch_at: summary.last_app_switch_at,
    total_paused_seconds: summary.total_paused_seconds,
    is_expired: summary.is_expired,
    revision: summary.revision ?? 0,
    operation_state: summary.operation_state ?? "idle",
  };
}

export function transitionSessionStatus(db: SqliteDatabase, sessionId: number, nextStatus: string, expectedStatuses?: string[]) {
  const current = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as { status: string } | undefined;
  if (!current) throw new Error("Session not found");
  if (current.status === nextStatus) return false;
  if (TERMINAL_SESSION_STATUSES.includes(current.status)) {
    throw new Error(`Invalid session transition: ${current.status} -> ${nextStatus}`);
  }
  if (expectedStatuses && !expectedStatuses.includes(current.status)) {
    throw new Error(`Invalid session transition: ${current.status} -> ${nextStatus}`);
  }
  if (!SESSION_STATUS_TRANSITIONS[current.status]?.includes(nextStatus)) {
    throw new Error(`Invalid session transition: ${current.status} -> ${nextStatus}`);
  }
  const updated = db.prepare(`
    UPDATE sessions
    SET status = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = ?
  `).run(nextStatus, sessionId, current.status);
  if (updated.changes !== 1) throw new Error(`Session ${sessionId} changed concurrently`);
  return true;
}

export function refreshSessionAggregate(db: SqliteDatabase, sessionId: number) {
  const session = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as { status: string } | undefined;
  if (!session || TERMINAL_SESSION_STATUSES.includes(session.status) || session.status === "finishing") return session?.status;
  const rows = db.prepare(`SELECT status FROM session_devices WHERE session_id = ?`).all(sessionId) as Array<{ status: string }>;
  const statuses = rows.map((row) => row.status);
  if (statuses.length === 0) return session.status;
  const target = statuses.every((status) => status === "finished")
    ? "completed"
    : statuses.every((status) => status === "failed")
      ? "failed"
      : statuses.some((status) => status === "running")
        ? "running"
        : statuses.some((status) => status === "paused")
          ? (statuses.every((status) => ["paused", "failed", "finished"].includes(status)) ? "paused" : "running")
          : statuses.some((status) => ["preparing", "ready"].includes(status))
            ? "starting"
            : session.status;
  if (target !== session.status && SESSION_STATUS_TRANSITIONS[session.status]?.includes(target)) {
    db.prepare(`UPDATE sessions SET status = ?, revision = revision + 1, finished_at = CASE WHEN ? IN ('completed', 'failed') THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE finished_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`)
      .run(target, target, sessionId, session.status);
  }
  return target;
}

export function appendSessionActionRequest(db: SqliteDatabase, input: {
  sessionId: number;
  deviceId: number;
  action: string;
  idempotencyKey?: string | null;
  commandId: number;
  revision: number;
}) {
  if (!input.idempotencyKey) return;
  db.prepare(`
    INSERT OR IGNORE INTO session_action_requests
      (session_id, device_id, action, idempotency_key, command_id, revision)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.sessionId, input.deviceId, input.action, input.idempotencyKey, input.commandId, input.revision);
}

export function findExistingSessionAction(db: SqliteDatabase, sessionId: number, deviceId: number, action: string, idempotencyKey?: string | null) {
  if (!idempotencyKey) return undefined;
  return db.prepare(`
    SELECT command_id, revision FROM session_action_requests
    WHERE session_id = ? AND device_id = ? AND action = ? AND idempotency_key = ?
    LIMIT 1
  `).get(sessionId, deviceId, action, idempotencyKey) as { command_id: number | null; revision: number } | undefined;
}
