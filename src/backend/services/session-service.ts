import type { SqliteDatabase, PermissionActor, CreateSessionInput, SessionActionInput } from "../db/types";
import { ACTIVE_SESSION_STATUSES, PACKAGE_NAME_PATTERN } from "../db/types";
import { formatSqliteTimestamp, parseSqliteTimestamp } from "../db/json";
import { assertActorCanAccessClub, assertDeviceLimit, assertRole, assertSubscriptionFeature } from "./authorization";
import { createDeviceCommand } from "./command-service";
import { getDeviceContext, getLatestDeviceConnectivity } from "../repositories/devices";
import { getLatestAppVersionForPackage } from "../repositories/apps";
import { writeAuditLog } from "../repositories/audit";
import { appendSessionEvent, buildSessionStatePayload, computeRemainingSeconds, findExistingSessionAction, getActiveSessionForDevice, getActiveSessionRowBySessionId, getActiveSessionRowForDevice, mapActiveSessionRow, resolveActiveSessionReference, refreshSessionAggregate, appendSessionActionRequest, resolveAppName, transitionSessionStatus } from "./session-state";

const isValidPackageName = (packageName: string) => PACKAGE_NAME_PATTERN.test(packageName);

export function extendSession(
  db: SqliteDatabase,
  sessionId: number,
  minutes: number,
  actor?: PermissionActor | null,
  options: SessionActionInput = {},
) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) throw new Error("Active session not found");
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new Error("Extension must be a positive whole number of minutes");
  }
  if (!['running', 'paused'].includes(active.session_device_status)) {
    throw new Error("Extend is only available for a running or paused session");
  }
  assertActorCanAccessClub(actor, active.organization_id, active.club_id);
  assertRole(actor, ["owner", "admin", "operator"], "extend session");
  assertSubscriptionFeature(db, active.organization_id, "sessions");
  if (!active.local_hub_id) throw new Error("Device is not attached to a Local Hub");
  if (findExistingSessionAction(db, active.session_id, active.device_id, "extend", options.idempotencyKey)) {
    return getActiveSessionForDevice(db, active.device_id);
  }

  const tx = db.transaction(() => {
    const nextSessionStatus = active.session_device_status === "paused" ? "extended" : "extended";
    const marked = db.prepare(`
      UPDATE session_devices
      SET revision = revision + 1, operation_state = 'extend_pending', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('running', 'paused') AND operation_state = 'idle'
    `).run(active.session_device_id);
    if (marked.changes !== 1) {
      if (findExistingSessionAction(db, active.session_id, active.device_id, "extend", options.idempotencyKey)) {
        return getActiveSessionForDevice(db, active.device_id);
      }
      throw new Error("Session action is already in progress");
    }
    if (active.session_status !== nextSessionStatus) transitionSessionStatus(db, active.session_id, nextSessionStatus, ["running", "paused", "extended"]);
    db.prepare(`
      UPDATE sessions
      SET extension_minutes = extension_minutes + ?, revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'extended'
    `).run(minutes, active.session_id);
    const summary = getActiveSessionForDevice(db, active.device_id);
    const extensionPayload = {
      package: active.current_app_package ?? active.launch_package_name,
      extension_minutes: minutes,
      session_state: summary ? buildSessionStatePayload(summary) : undefined,
    };
    let commandId: number;
    try {
      commandId = createDeviceCommand(db, {
        deviceId: active.device_id,
        localHubId: active.local_hub_id,
        type: "EXTEND_SESSION",
        sessionId: active.session_id,
        actor: actor ?? null,
        payload: extensionPayload,
      });
    } catch (error) {
      // Databases upgraded from the pre-0006 command CHECK constraint use the
      // existing idempotent RESUME transport as a sync-only compatibility
      // path. Fresh databases use the explicit EXTEND_SESSION command.
      if (!String(error).includes("CHECK constraint failed")) throw error;
      commandId = createDeviceCommand(db, {
        deviceId: active.device_id,
        localHubId: active.local_hub_id,
        type: "RESUME_SESSION",
        sessionId: active.session_id,
        actor: actor ?? null,
        payload: { ...extensionPayload, resync_only: true },
      });
    }
    db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(commandId, active.session_device_id);
    const revision = db.prepare(`SELECT revision FROM session_devices WHERE id = ?`).get(active.session_device_id) as { revision: number };
    appendSessionActionRequest(db, {
      sessionId: active.session_id,
      deviceId: active.device_id,
      action: "extend",
      idempotencyKey: options.idempotencyKey,
      commandId,
      revision: revision.revision,
    });
    appendSessionEvent(db, {
      sessionId: active.session_id,
      sessionDeviceId: active.session_device_id,
      deviceId: active.device_id,
      type: "session_extended",
      message: `Session ${active.session_id} extended by ${minutes} minutes`,
      payload: { extension_minutes: minutes, command_id: commandId, idempotency_key: options.idempotencyKey ?? null },
    });
  });
  tx();
  return getActiveSessionForDevice(db, active.device_id);
}

export function createSession(db: SqliteDatabase, input: CreateSessionInput) {
  const deviceIds = [...new Set(input.deviceIds.map(Number).filter(Number.isInteger))];
  if (deviceIds.length === 0) {
    throw new Error("At least one device is required");
  }
  if (!isValidPackageName(input.appPackage)) {
    throw new Error("Invalid app package name");
  }

  const firstDevice = getDeviceContext(db, deviceIds[0]);
  if (!firstDevice) {
    throw new Error("Primary device not found");
  }
  if (!firstDevice.local_hub_id) {
    throw new Error("Primary device is not attached to a Local Hub");
  }
  assertActorCanAccessClub(input.actor, firstDevice.organization_id, firstDevice.club_id);
  assertRole(input.actor, ["owner", "admin", "operator"], "start session");
  assertSubscriptionFeature(db, firstDevice.organization_id, "sessions");
  if (input.requireScrcpy) {
    assertSubscriptionFeature(db, firstDevice.organization_id, "scrcpy");
  }
  assertDeviceLimit(db, firstDevice.organization_id);
  const preflight = validateSessionPreflight(db, { ...input, deviceIds }, firstDevice);
  if (!preflight.ok) {
    throw new Error(`Preflight failed: ${preflight.errors.join("; ")}`);
  }

  const roomId = input.roomId ?? firstDevice.room_id ?? null;
  const requireScrcpy = input.requireScrcpy ? 1 : 0;
  const appName = resolveAppName(db, input.appPackage);
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      organization_id, club_id, room_id, local_hub_id, title, status, duration_minutes, require_scrcpy,
      operator_notes, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?)
  `);
  const insertSessionDevice = db.prepare(`
    INSERT INTO session_devices (
      session_id, device_id, role, status, launch_package_name, current_app_package, current_app_name, scrcpy_requested, scrcpy_required
    ) VALUES (?, ?, 'player', 'preparing', ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const sessionResult = insertSession.run(
      firstDevice.organization_id,
      firstDevice.club_id,
      roomId,
      firstDevice.local_hub_id,
      input.title,
      input.durationMinutes,
      requireScrcpy,
      input.operatorNotes ?? null,
      input.createdByUserId ?? null,
    );

    const sessionId = Number(sessionResult.lastInsertRowid);
    db.prepare(`UPDATE sessions SET revision = 1 WHERE id = ?`).run(sessionId);
    for (const deviceId of deviceIds) {
      const context = getDeviceContext(db, deviceId);
      if (!context || context.club_id !== firstDevice.club_id) {
        throw new Error("All session devices must belong to the same club");
      }

      let sessionDeviceResult;
      try {
        sessionDeviceResult = insertSessionDevice.run(
        sessionId,
        deviceId,
        input.appPackage,
        input.appPackage,
        appName,
        requireScrcpy,
        requireScrcpy,
        );
      } catch (error) {
        if (String(error).includes("uq_session_devices_one_active_per_device") || String(error).includes("UNIQUE constraint failed: session_devices.device_id")) {
          throw new Error(`Device ${deviceId} already has active session`);
        }
        throw error;
      }
      const sessionDeviceId = Number(sessionDeviceResult.lastInsertRowid);
      db.prepare(`
        UPDATE session_devices
        SET revision = 1, operation_state = 'start_pending'
        WHERE id = ?
      `).run(sessionDeviceId);

      db.prepare(`
        UPDATE devices
        SET status = 'busy', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(deviceId);

      createDeviceCommand(db, {
        deviceId,
        localHubId: context.local_hub_id ?? firstDevice.local_hub_id,
        type: "START_SESSION",
        sessionId,
        createdByUserId: input.createdByUserId ?? null,
        actor: input.actor ?? null,
        payload: {
          session_id: sessionId,
          package: input.appPackage,
          app_name: appName,
          activity: input.appActivity,
          duration_minutes: input.durationMinutes,
          require_scrcpy: Boolean(input.requireScrcpy),
          session_state: {
            session_id: sessionId,
            session_status: "running",
            remaining_seconds: input.durationMinutes * 60,
            duration_seconds: input.durationMinutes * 60,
            current_app_package: input.appPackage,
            current_app_name: appName,
            app_package: input.appPackage,
            app_name: appName,
            paused: false,
            started_at: null,
            last_app_switch_at: null,
            total_paused_seconds: 0,
            is_expired: false,
            revision: 1,
            operation_state: "start_pending",
          },
        },
      });
      const startCommand = db.prepare(`SELECT id FROM device_commands WHERE session_id = ? AND device_id = ? AND type = 'START_SESSION' ORDER BY id DESC LIMIT 1`).get(sessionId, deviceId) as { id: number };
      db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(startCommand.id, sessionDeviceId);

      appendSessionEvent(db, {
        sessionId,
        sessionDeviceId,
        deviceId,
        type: "session_device_preparing",
        message: `Device ${deviceId} is preparing session ${sessionId}`,
        payload: { app_package: input.appPackage, preflight: preflight.checks },
      });
    }

    writeAuditLog(db, {
      action: "session.created",
      entityType: "session",
      entityId: sessionId,
      organizationId: firstDevice.organization_id,
      clubId: firstDevice.club_id,
      localHubId: firstDevice.local_hub_id ?? null,
      sessionId,
      userId: input.createdByUserId ?? null,
      details: input,
    });

    return sessionId;
  });

  return tx();
}

function validateSessionPreflight(db: SqliteDatabase, input: CreateSessionInput, firstDevice: NonNullable<ReturnType<typeof getDeviceContext>>) {
  const errors: string[] = [];
  const checks: Record<string, unknown> = {};
  const hub = db.prepare(`SELECT id, status FROM local_hubs WHERE id = ?`).get(firstDevice.local_hub_id) as
    | { id: number; status: string }
    | undefined;

  checks.local_hub_online = hub?.status === "online";
  if (hub?.status !== "online") {
    errors.push("Local Hub is offline");
  }

  for (const deviceId of input.deviceIds) {
    const context = getDeviceContext(db, deviceId);
    const connectivity = getLatestDeviceConnectivity(db, deviceId);
    const canWakeOverWifi = Boolean(connectivity.wake_supported || connectivity.wifi_ip);
    if (!context) {
      errors.push(`Device ${deviceId} not found`);
      continue;
    }
    if (context.club_id !== firstDevice.club_id) {
      errors.push(`Device ${deviceId} belongs to another club`);
    }
    if (context.local_hub_id !== firstDevice.local_hub_id) {
      errors.push(`Device ${deviceId} is attached to another Local Hub`);
    }
    if (context.status !== "online" && !canWakeOverWifi) {
      errors.push(`Device ${deviceId} is not online`);
    }
    if (context.adb_status !== "online") {
      errors.push(`Device ${deviceId} ADB is not available`);
    }
    if (context.agent_status !== "online" && !canWakeOverWifi) {
      errors.push(`Device ${deviceId} Quest Agent is not available`);
    }
    if (context.battery_percent < 5) {
      errors.push(`Device ${deviceId} battery is below 5%`);
    }
    if (context.storage_free_mb !== null && context.storage_free_mb < 1024) {
      errors.push(`Device ${deviceId} has less than 1GB free storage`);
    }

    const installedApp = db.prepare(`
      SELECT app_version_id, version_code, install_state
      FROM device_apps
      WHERE device_id = ? AND package_name = ? AND install_state = 'installed'
    `).get(deviceId, input.appPackage) as { app_version_id: number | null; version_code: number | null; install_state: string } | undefined;
    if (!installedApp) {
      errors.push(`App ${input.appPackage} is not installed on device ${deviceId}`);
    } else {
      const activeVersion = getLatestAppVersionForPackage(db, input.appPackage);
      if (activeVersion) {
        const versionIdMismatch = installedApp.app_version_id !== null && installedApp.app_version_id !== activeVersion.id;
        const versionCodeMismatch = activeVersion.version_code !== null && installedApp.version_code !== activeVersion.version_code;
        const missingVersionCode = activeVersion.version_code !== null && installedApp.version_code === null;
        if (versionIdMismatch || versionCodeMismatch || missingVersionCode) {
          errors.push(`App ${input.appPackage} version is not compatible on device ${deviceId}`);
        }
      }
    }

    const activeConflict = db.prepare(`
      SELECT s.id
      FROM session_devices sd
      JOIN sessions s ON s.id = sd.session_id
      WHERE sd.device_id = ?
        AND sd.status IN ('preparing', 'ready', 'running', 'paused')
        AND s.status IN (${ACTIVE_SESSION_STATUSES.map(() => "?").join(",")})
      LIMIT 1
    `).get(deviceId, ...ACTIVE_SESSION_STATUSES) as { id: number } | undefined;
    if (activeConflict) {
      errors.push(`Device ${deviceId} already has active session ${activeConflict.id}`);
    }
  }

  checks.device_count = input.deviceIds.length;
  checks.app_package = input.appPackage;
  checks.wake_supported = input.deviceIds.every((deviceId) => {
    const connectivity = getLatestDeviceConnectivity(db, deviceId);
    return Boolean(connectivity.wake_supported || connectivity.wifi_ip);
  });
  return { ok: errors.length === 0, errors, checks };
}

export function finishActiveSessionForDevice(db: SqliteDatabase, deviceId: number, actor?: PermissionActor | null, options: SessionActionInput = {}) {
  const active = getActiveSessionRowForDevice(db, deviceId);

  if (!active) {
    return null;
  }
  assertActorCanAccessClub(actor, active.organization_id, active.club_id);
  assertRole(actor, ["owner", "admin", "operator"], "finish session");
  assertSubscriptionFeature(db, active.organization_id, "sessions");
  if (!active.local_hub_id) {
    throw new Error("Device is not attached to a Local Hub");
  }

  const existingAction = findExistingSessionAction(db, active.session_id, deviceId, "end", options.idempotencyKey);
  if (existingAction) return active.session_id;
  if (active.session_status === "finishing" || active.operation_state === "finish_pending") {
    return active.session_id;
  }

  const tx = db.transaction(() => {
    const marked = db.prepare(`
      UPDATE session_devices
      SET revision = revision + 1,
          operation_state = 'finish_pending',
          end_reason = 'operator_stop',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('preparing', 'ready', 'running', 'paused') AND operation_state != 'finish_pending'
    `).run(active.session_device_id);
    if (marked.changes !== 1) {
      return active.session_id;
    }

    transitionSessionStatus(db, active.session_id, "finishing");
    const revisionRow = db.prepare(`SELECT revision FROM session_devices WHERE id = ?`).get(active.session_device_id) as { revision: number };

    const summary = mapActiveSessionRow({
      ...active,
      session_status: "finishing",
    });

    createDeviceCommand(db, {
      deviceId,
      localHubId: active.local_hub_id,
      type: "END_SESSION",
      sessionId: active.session_id,
      actor: actor ?? null,
      payload: {
        package: active.current_app_package ?? active.launch_package_name,
        return_to_launcher: true,
        session_state: summary ? buildSessionStatePayload({ ...summary, status: "ended", remaining_seconds: summary.remaining_seconds }) : undefined,
      },
    });
    const endCommand = db.prepare(`SELECT id FROM device_commands WHERE session_id = ? AND device_id = ? AND type = 'END_SESSION' ORDER BY id DESC LIMIT 1`).get(active.session_id, deviceId) as { id: number };
    db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(endCommand.id, active.session_device_id);
    appendSessionActionRequest(db, {
      sessionId: active.session_id,
      deviceId,
      action: "end",
      idempotencyKey: options.idempotencyKey,
      commandId: endCommand.id,
      revision: revisionRow.revision,
    });

    appendSessionEvent(db, {
      sessionId: active.session_id,
      sessionDeviceId: active.session_device_id,
      deviceId,
      type: "session_device_finishing",
      message: `Device ${deviceId} is finishing session ${active.session_id}`,
      payload: { return_to_launcher: true },
    });

    return active.session_id;
  });

  return tx();
}

export function pauseSession(db: SqliteDatabase, sessionId: number, actor?: PermissionActor | null, options: SessionActionInput = {}) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) {
    throw new Error("Active session not found");
  }
  if (options.idempotencyKey) {
    const existingAction = findExistingSessionAction(db, active.session_id, active.device_id, "pause", options.idempotencyKey);
    if (existingAction) return getActiveSessionForDevice(db, active.device_id);
  }
  if (active.session_device_status !== "running") {
    throw new Error("Pause is only available for a running session");
  }
  assertActorCanAccessClub(actor, active.organization_id, active.club_id);
  assertRole(actor, ["owner", "admin", "operator"], "pause session");
  assertSubscriptionFeature(db, active.organization_id, "sessions");
  if (!active.local_hub_id) {
    throw new Error("Device is not attached to a Local Hub");
  }

  const remainingSeconds = computeRemainingSeconds(active);
  const pausedAt = formatSqliteTimestamp(new Date());
  const previousSummary = mapActiveSessionRow(active);
  const tx = db.transaction(() => {
    const marked = db.prepare(`
      UPDATE session_devices
      SET status = 'paused',
          revision = revision + 1,
          operation_state = 'pause_pending',
          paused_at = ?,
          paused_remaining_seconds = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND operation_state = 'idle'
    `).run(pausedAt, remainingSeconds, active.session_device_id);
    if (marked.changes !== 1) {
      if (findExistingSessionAction(db, active.session_id, active.device_id, "pause", options.idempotencyKey)) {
        return getActiveSessionForDevice(db, active.device_id);
      }
      throw new Error("Session action is already in progress");
    }

    transitionSessionStatus(db, active.session_id, "paused", ["running", "extended"]);

    const summary = getActiveSessionForDevice(db, active.device_id);
    createDeviceCommand(db, {
      deviceId: active.device_id,
      localHubId: active.local_hub_id,
      type: "PAUSE_SESSION",
      sessionId: active.session_id,
      actor: actor ?? null,
      payload: {
        package: active.current_app_package ?? active.launch_package_name,
        current_app_package: active.current_app_package ?? active.launch_package_name,
        current_app_name: active.current_app_name ?? active.launch_app_name,
        previous_session_state: previousSummary ? buildSessionStatePayload(previousSummary) : undefined,
        session_state: summary ? buildSessionStatePayload(summary) : undefined,
      },
    });
    const pauseCommand = db.prepare(`SELECT id FROM device_commands WHERE session_id = ? AND device_id = ? AND type = 'PAUSE_SESSION' ORDER BY id DESC LIMIT 1`).get(active.session_id, active.device_id) as { id: number };
    const revisionRow = db.prepare(`SELECT revision FROM session_devices WHERE id = ?`).get(active.session_device_id) as { revision: number };
    db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(pauseCommand.id, active.session_device_id);
    appendSessionActionRequest(db, {
      sessionId: active.session_id,
      deviceId: active.device_id,
      action: "pause",
      idempotencyKey: options.idempotencyKey,
      commandId: pauseCommand.id,
      revision: revisionRow.revision,
    });

    appendSessionEvent(db, {
      sessionId: active.session_id,
      sessionDeviceId: active.session_device_id,
      deviceId: active.device_id,
      type: "session_paused",
      message: `Session ${active.session_id} paused on device ${active.device_id}`,
      payload: { remaining_seconds: remainingSeconds },
    });
  });

  tx();
  return getActiveSessionForDevice(db, active.device_id);
}

export function resumeSession(db: SqliteDatabase, sessionId: number, actor?: PermissionActor | null, options: SessionActionInput = {}) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) {
    throw new Error("Active session not found");
  }
  if (options.idempotencyKey) {
    const existingAction = findExistingSessionAction(db, active.session_id, active.device_id, "resume", options.idempotencyKey);
    if (existingAction) return getActiveSessionForDevice(db, active.device_id);
  }
  if (active.session_device_status !== "paused") {
    throw new Error("Resume is only available for a paused session");
  }
  assertActorCanAccessClub(actor, active.organization_id, active.club_id);
  assertRole(actor, ["owner", "admin", "operator"], "resume session");
  assertSubscriptionFeature(db, active.organization_id, "sessions");
  if (!active.local_hub_id) {
    throw new Error("Device is not attached to a Local Hub");
  }

  const pausedAt = parseSqliteTimestamp(active.paused_at);
  const additionalPausedSeconds = pausedAt ? Math.max(0, Math.floor((Date.now() - pausedAt.getTime()) / 1000)) : 0;
  const remainingSeconds = active.paused_remaining_seconds ?? computeRemainingSeconds(active);
  const previousSummary = mapActiveSessionRow(active);

  const tx = db.transaction(() => {
    const marked = db.prepare(`
      UPDATE session_devices
      SET status = 'running',
          revision = revision + 1,
          operation_state = 'resume_pending',
          paused_at = NULL,
          paused_remaining_seconds = NULL,
          total_paused_seconds = total_paused_seconds + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'paused' AND operation_state IN ('idle', 'pause_pending')
    `).run(additionalPausedSeconds, active.session_device_id);
    if (marked.changes !== 1) {
      if (findExistingSessionAction(db, active.session_id, active.device_id, "resume", options.idempotencyKey)) {
        return getActiveSessionForDevice(db, active.device_id);
      }
      throw new Error("Session action is already in progress");
    }

    transitionSessionStatus(db, active.session_id, "running", ["paused", "extended"]);

    const summary = getActiveSessionForDevice(db, active.device_id);
    createDeviceCommand(db, {
      deviceId: active.device_id,
      localHubId: active.local_hub_id,
      type: "RESUME_SESSION",
      sessionId: active.session_id,
      actor: actor ?? null,
      payload: {
        package: active.current_app_package ?? active.launch_package_name,
        current_app_package: active.current_app_package ?? active.launch_package_name,
        current_app_name: active.current_app_name ?? active.launch_app_name,
        remaining_seconds: remainingSeconds,
        previous_session_state: previousSummary ? buildSessionStatePayload(previousSummary) : undefined,
        session_state: summary ? buildSessionStatePayload(summary) : undefined,
      },
    });
    const resumeCommand = db.prepare(`SELECT id FROM device_commands WHERE session_id = ? AND device_id = ? AND type = 'RESUME_SESSION' ORDER BY id DESC LIMIT 1`).get(active.session_id, active.device_id) as { id: number };
    const revisionRow = db.prepare(`SELECT revision FROM session_devices WHERE id = ?`).get(active.session_device_id) as { revision: number };
    db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(resumeCommand.id, active.session_device_id);
    appendSessionActionRequest(db, {
      sessionId: active.session_id,
      deviceId: active.device_id,
      action: "resume",
      idempotencyKey: options.idempotencyKey,
      commandId: resumeCommand.id,
      revision: revisionRow.revision,
    });

    appendSessionEvent(db, {
      sessionId: active.session_id,
      sessionDeviceId: active.session_device_id,
      deviceId: active.device_id,
      type: "session_resumed",
      message: `Session ${active.session_id} resumed on device ${active.device_id}`,
      payload: { remaining_seconds: remainingSeconds, additional_paused_seconds: additionalPausedSeconds },
    });
  });

  tx();
  return getActiveSessionForDevice(db, active.device_id);
}

export function switchSessionApp(
  db: SqliteDatabase,
  sessionId: number,
  input: { appPackage: string; appActivity?: string; actor?: PermissionActor | null } & SessionActionInput,
) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) {
    throw new Error("Active session not found");
  }
  if (input.idempotencyKey) {
    const existingAction = findExistingSessionAction(db, active.session_id, active.device_id, "switch", input.idempotencyKey);
    if (existingAction) return getActiveSessionForDevice(db, active.device_id);
  }
  if (!["running", "paused"].includes(active.session_device_status)) {
    throw new Error("Switch App is only available for a running or paused session");
  }
  if (!isValidPackageName(input.appPackage)) {
    throw new Error("Invalid app package name");
  }
  assertActorCanAccessClub(input.actor, active.organization_id, active.club_id);
  assertRole(input.actor, ["owner", "admin", "operator"], "switch app");
  assertSubscriptionFeature(db, active.organization_id, "sessions");
  if (!active.local_hub_id) {
    throw new Error("Device is not attached to a Local Hub");
  }

  const installedApp = db.prepare(`
    SELECT app_version_id, version_code
    FROM device_apps
    WHERE device_id = ? AND package_name = ? AND install_state = 'installed'
  `).get(active.device_id, input.appPackage) as { app_version_id: number | null; version_code: number | null } | undefined;
  if (!installedApp) {
    throw new Error(`App ${input.appPackage} is not installed on device ${active.device_id}`);
  }

  const currentAppName = resolveAppName(db, input.appPackage) ?? input.appPackage;
  const previousSummary = mapActiveSessionRow(active);
  const tx = db.transaction(() => {
    const marked = db.prepare(`
      UPDATE session_devices
      SET current_app_package = ?,
          current_app_name = ?,
          desired_app_package = ?,
          desired_app_activity = ?,
          operation_state = 'switch_pending',
          revision = revision + 1,
          last_app_switch_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('running', 'paused') AND operation_state = 'idle'
    `).run(input.appPackage, currentAppName, input.appPackage, input.appActivity ?? null, active.session_device_id);
    if (marked.changes !== 1) {
      if (findExistingSessionAction(db, active.session_id, active.device_id, "switch", input.idempotencyKey)) {
        return getActiveSessionForDevice(db, active.device_id);
      }
      throw new Error("Session action is already in progress");
    }
    db.prepare(`UPDATE sessions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('running', 'paused', 'extended')`).run(active.session_id);

    const summary = getActiveSessionForDevice(db, active.device_id);
    createDeviceCommand(db, {
      deviceId: active.device_id,
      localHubId: active.local_hub_id,
      type: "SWITCH_SESSION_APP",
      sessionId: active.session_id,
      actor: input.actor ?? null,
      payload: {
        package: input.appPackage,
        app_name: currentAppName,
        activity: input.appActivity,
        launch_immediately: active.session_device_status === "running",
        previous_session_state: previousSummary ? buildSessionStatePayload(previousSummary) : undefined,
        session_state: summary ? buildSessionStatePayload(summary) : undefined,
      },
    });
    const switchCommand = db.prepare(`SELECT id FROM device_commands WHERE session_id = ? AND device_id = ? AND type = 'SWITCH_SESSION_APP' ORDER BY id DESC LIMIT 1`).get(active.session_id, active.device_id) as { id: number };
    const revisionRow = db.prepare(`SELECT revision FROM session_devices WHERE id = ?`).get(active.session_device_id) as { revision: number };
    db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(switchCommand.id, active.session_device_id);
    appendSessionActionRequest(db, {
      sessionId: active.session_id,
      deviceId: active.device_id,
      action: "switch",
      idempotencyKey: input.idempotencyKey,
      commandId: switchCommand.id,
      revision: revisionRow.revision,
    });

    appendSessionEvent(db, {
      sessionId: active.session_id,
      sessionDeviceId: active.session_device_id,
      deviceId: active.device_id,
      type: "session_app_switched",
      message: `Session ${active.session_id} switched to ${input.appPackage}`,
      payload: { current_app_package: input.appPackage, launch_immediately: active.session_device_status === "running" },
    });
  });

  tx();
  return getActiveSessionForDevice(db, active.device_id);
}


export function listSessions(db: SqliteDatabase, actor?: PermissionActor | null) {
  if (!actor) return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC, id DESC`).all();
  return db.prepare(`SELECT * FROM sessions WHERE organization_id = ? AND club_id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"}) ORDER BY created_at DESC, id DESC`)
    .all(actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1]));
}

/**
 * Cloud is the single owner of the auto-end decision. It only enqueues one
 * END_SESSION command per device; physical cleanup and completion still need
 * the normal command result/reconciliation path.
 */
export function reconcileExpiredSessions(db: SqliteDatabase, now = new Date()) {
  const candidates = db.prepare(`
    SELECT sd.id AS session_device_id, sd.device_id, sd.session_id
    FROM session_devices sd
    JOIN sessions s ON s.id = sd.session_id
    WHERE sd.status IN ('running', 'paused')
      AND sd.status != 'paused'
      AND s.status IN ('running', 'extended')
      AND sd.finished_at IS NULL
  `).all() as Array<{ session_device_id: number; device_id: number; session_id: number }>;
  const createdCommandIds: number[] = [];
  for (const candidate of candidates) {
    const active = getActiveSessionRowBySessionId(db, candidate.session_id);
    if (!active || active.device_id !== candidate.device_id || computeRemainingSeconds(active, now) > 0) continue;
    const tx = db.transaction(() => {
      const claimed = db.prepare(`
        UPDATE sessions
        SET status = 'finishing', auto_end_requested_at = COALESCE(auto_end_requested_at, CURRENT_TIMESTAMP),
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('running', 'extended') AND auto_end_requested_at IS NULL
      `).run(candidate.session_id);
      if (claimed.changes !== 1) return null;
      const deviceUpdate = db.prepare(`
        UPDATE session_devices
        SET revision = revision + 1, operation_state = 'finish_pending', end_reason = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('running', 'paused') AND operation_state != 'finish_pending'
      `).run(candidate.session_device_id);
      if (deviceUpdate.changes !== 1) return null;
      const commandId = createDeviceCommand(db, {
        deviceId: candidate.device_id,
        localHubId: active.local_hub_id ?? 0,
        type: "END_SESSION",
        sessionId: candidate.session_id,
        payload: {
          package: active.current_app_package ?? active.launch_package_name,
          return_to_launcher: true,
          auto_end: true,
          session_state: buildSessionStatePayload({ ...mapActiveSessionRow(active)!, status: "ended" }),
        },
      });
      db.prepare(`UPDATE session_devices SET last_command_id = ? WHERE id = ?`).run(commandId, candidate.session_device_id);
      appendSessionEvent(db, {
        sessionId: candidate.session_id,
        sessionDeviceId: candidate.session_device_id,
        deviceId: candidate.device_id,
        type: "session_auto_end_requested",
        message: `Session ${candidate.session_id} expired; cleanup was requested`,
        payload: { command_id: commandId, remaining_seconds: 0 },
      });
      return commandId;
    });
    const commandId = tx();
    if (commandId) createdCommandIds.push(commandId);
  }
  return createdCommandIds;
}
