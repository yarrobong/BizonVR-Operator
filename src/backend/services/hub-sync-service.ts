import crypto from "crypto";
import type { SqliteDatabase, SyncPayload, DeviceDetail, AgentHeartbeat } from "../db/types";
import { ACTIVE_SESSION_STATUSES } from "../db/types";
import { formatSqliteTimestamp } from "../db/json";
import { getCommandPolicy } from "../db/command-policy";
import { appendSessionEvent, getActiveSessionRowForDevice } from "./session-state";
import { createDevice, cleanupDuplicateDeviceAliases, findDeviceByIdentity, getLatestDeviceConnectivity, mergePreviousIps, computeConnectionStatus } from "../repositories/devices";
import { upsertDeviceApp } from "../repositories/apps";

const AGENT_HEARTBEAT_MAX_AGE_MS = Number(process.env.AGENT_HEARTBEAT_MAX_AGE_MS || 60_000);

function reconcileSessionFromHeartbeat(db: SqliteDatabase, deviceId: number, heartbeat: AgentHeartbeat) {
  if (heartbeat.session_id === undefined || heartbeat.session_id === null) return false;
  const active = getActiveSessionRowForDevice(db, deviceId);
  if (!active || active.session_id !== Number(heartbeat.session_id)) return false;
  const timestamp = Number(heartbeat.timestamp ?? 0);
  if (timestamp > 0 && active.last_agent_timestamp_ms !== null && timestamp <= active.last_agent_timestamp_ms) return false;
  const heartbeatRevision = heartbeat.session_revision === undefined ? null : Number(heartbeat.session_revision);
  if (heartbeatRevision !== null && heartbeatRevision < Number(active.device_revision ?? 0)) return false;
  db.prepare(`UPDATE session_devices SET last_agent_heartbeat_at = CURRENT_TIMESTAMP, last_agent_timestamp_ms = ?, agent_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(timestamp || null, active.session_id, active.session_device_id);
  const expectedPackage = active.desired_app_package ?? active.current_app_package ?? active.launch_package_name;
  const packageMatches = !heartbeat.current_app_package || heartbeat.current_app_package === expectedPackage;
  if (heartbeat.session_status === "running" && heartbeat.in_session && packageMatches && ["starting", "running", "extended"].includes(active.session_status)) {
    const changed = db.prepare(`UPDATE session_devices SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), operation_state = 'idle', current_app_package = COALESCE(?, current_app_package), current_app_name = COALESCE(?, current_app_name), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('preparing', 'ready', 'running', 'paused') AND operation_state != 'finish_pending'`).run(heartbeat.current_app_package ?? null, heartbeat.current_app_name ?? null, active.session_device_id);
    if (changed.changes === 1 && ["starting", "preparing", "ready"].includes(active.session_status)) {
      db.prepare(`UPDATE sessions SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), ends_at = COALESCE(ends_at, datetime(CURRENT_TIMESTAMP, '+' || (SELECT duration_minutes + extension_minutes FROM sessions WHERE id = ?) || ' minutes')), recovery_state = 'none', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('starting', 'preparing', 'ready')`).run(active.session_id, active.session_id);
      appendSessionEvent(db, { sessionId: active.session_id, deviceId, type: "session_reconciled_running", message: `Heartbeat reconciled session ${active.session_id} as running`, payload: { revision: heartbeatRevision, current_app_package: heartbeat.current_app_package ?? null } });
    }
  } else if (heartbeat.session_status === "paused" && heartbeat.in_session && packageMatches && ["running", "extended", "paused"].includes(active.session_status)) {
    const changed = db.prepare(`UPDATE session_devices SET status = 'paused', paused_at = COALESCE(paused_at, CURRENT_TIMESTAMP), paused_remaining_seconds = ?, operation_state = 'idle', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running' AND operation_state != 'finish_pending'`).run(Math.max(0, Number(heartbeat.remaining_seconds ?? 0)), active.session_device_id);
    if (changed.changes === 1 && active.session_status !== "paused") {
      db.prepare(`UPDATE sessions SET status = 'paused', recovery_state = 'none', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('running', 'extended')`).run(active.session_id);
      appendSessionEvent(db, { sessionId: active.session_id, deviceId, type: "session_reconciled_paused", message: `Heartbeat reconciled session ${active.session_id} as paused`, payload: { remaining_seconds: heartbeat.remaining_seconds ?? null } });
    }
  }
  return heartbeat.in_session === true && active.session_status !== "finishing" && packageMatches;
}

function isFreshAgentHeartbeat(heartbeat: AgentHeartbeat, now = Date.now()) {
  if (heartbeat.timestamp === undefined || heartbeat.timestamp === null) return true;
  const timestamp = Number(heartbeat.timestamp);
  return Number.isFinite(timestamp) && Math.abs(now - timestamp) <= AGENT_HEARTBEAT_MAX_AGE_MS;
}


export function syncHubState(db: SqliteDatabase, hubId: number, payload: SyncPayload) {
  const hub = db.prepare(`
    SELECT h.id, h.club_id, c.organization_id
    FROM local_hubs h
    JOIN clubs c ON c.id = h.club_id
    WHERE h.id = ?
  `).get(hubId) as { id: number; club_id: number; organization_id: number } | undefined;

  if (!hub) {
    throw new Error("Local Hub not found");
  }

  db.prepare(`
    UPDATE local_hubs
    SET
      host = COALESCE(?, host),
      last_heartbeat_at = CURRENT_TIMESTAMP,
      last_sync_at = CURRENT_TIMESTAMP,
      status = 'online',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(payload.hub_host ?? null, hubId);

  const detailsArray: DeviceDetail[] =
    payload.device_details ?? payload.active_serials?.map((serial) => ({ serial })) ?? [];
  const tx = db.transaction(() => {
    for (const detail of detailsArray) {
      const existing = findDeviceByIdentity(db, {
        serialNumber: detail.serial,
        stableId: detail.stable_id ?? detail.usb_serial ?? detail.serial,
        agentId: detail.agent_id ?? null,
        androidId: detail.android_id ?? null,
      });
      const existingRow = existing
        ? db.prepare(`SELECT status, previous_ips FROM devices WHERE id = ?`).get(existing.id) as { status: string; previous_ips: string | null }
        : null;
      const adbStatus = detail.adb_status ?? "unknown";
      const agentStatus = detail.agent_status ?? (detail.agent_id ? "online" : "unknown");
      const connectionStatus = computeConnectionStatus(detail, existingRow?.status ?? "new");

      const deviceId = existing?.id ?? createDevice(db, {
        clubId: hub.club_id,
        localHubId: hubId,
        name: `Quest ${String(detail.model ?? "Device")} ${detail.serial.slice(0, 4)}`,
        serialNumber: detail.serial,
        stableId: detail.stable_id ?? detail.usb_serial ?? detail.serial,
        agentId: detail.agent_id ?? null,
        androidId: detail.android_id ?? null,
        pairingId: detail.agent_id ?? null,
        model: detail.model ?? "Meta Quest",
        status: "new",
        connectionStatus: connectionStatus === "online" ? "wifi_ready" : connectionStatus,
        batteryPercent: detail.battery ?? 100,
      });

      db.prepare(`
        UPDATE devices
        SET
          club_id = ?,
          local_hub_id = ?,
          serial_number = COALESCE(?, serial_number),
          stable_id = COALESCE(?, stable_id),
          agent_id = COALESCE(?, agent_id),
          android_id = COALESCE(?, android_id),
          pairing_id = COALESCE(?, pairing_id),
          model = COALESCE(?, model),
          battery_percent = COALESCE(?, battery_percent),
          is_charging = COALESCE(?, is_charging),
          storage_free_mb = COALESCE(?, storage_free_mb),
          storage_total_mb = COALESCE(?, storage_total_mb),
          wifi_ssid = COALESCE(?, wifi_ssid),
          ip_address = COALESCE(?, ip_address),
          last_known_ip = COALESCE(?, last_known_ip),
          previous_ips = ?,
          active_route = COALESCE(?, active_route),
          current_app_package = COALESCE(?, current_app_package),
          agent_version = COALESCE(?, agent_version),
          adb_status = ?,
          agent_status = ?,
          connection_status = ?,
          status_reason = ?,
          next_operator_step = ?,
          identity_last_verified_at = CURRENT_TIMESTAMP,
          last_diagnostics_at = CURRENT_TIMESTAMP,
          last_heartbeat_at = CASE WHEN ? = 'online' THEN CURRENT_TIMESTAMP ELSE last_heartbeat_at END,
          last_adb_seen_at = CASE WHEN ? = 'online' THEN CURRENT_TIMESTAMP ELSE last_adb_seen_at END,
          last_seen_at = CURRENT_TIMESTAMP,
          status = CASE
            WHEN ? = 'online' THEN CASE WHEN status IN ('busy', 'in_session') THEN status ELSE 'online' END
            WHEN ? = 'online' THEN CASE WHEN status IN ('busy', 'in_session') THEN status ELSE 'online' END
            WHEN ? = 'new' THEN 'new'
            WHEN ? IN ('usb_pairing_required', 'usb_unauthorized', 'pairing_in_progress') AND status NOT IN ('busy', 'in_session') THEN 'pairing_required'
            WHEN status NOT IN ('busy', 'in_session') THEN 'offline'
            ELSE status
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        hub.club_id,
        hubId,
        detail.serial,
        detail.stable_id ?? detail.usb_serial ?? detail.serial,
        detail.agent_id ?? null,
        detail.android_id ?? null,
        detail.agent_id ?? null,
        detail.model ?? null,
        detail.battery ?? null,
        detail.is_charging === undefined ? null : Number(detail.is_charging),
        detail.storage_free_mb ?? null,
        detail.storage_total_mb ?? null,
        detail.wifi_ssid ?? null,
        detail.ip_address ?? null,
        detail.ip_address ?? null,
        mergePreviousIps(existingRow?.previous_ips, detail.ip_address ?? null, detail.previous_ips),
        detail.active_route ?? null,
        detail.current_app_package ?? null,
        detail.app_version ?? null,
        adbStatus,
        agentStatus,
        connectionStatus,
        detail.status_reason ?? null,
        detail.next_step ?? null,
        agentStatus,
        adbStatus,
        connectionStatus,
        agentStatus,
        connectionStatus,
        connectionStatus,
        deviceId,
      );

      if (detail.installed_apps) {
        for (const app of detail.installed_apps) {
          upsertDeviceApp(db, {
            deviceId,
            packageName: app.package,
            versionName: app.version_name ?? null,
            versionCode: app.version_code ?? null,
          });
        }
      }

      db.prepare(`
        INSERT INTO device_telemetry (
          device_id, local_hub_id, battery_percent, is_charging, storage_free_mb, storage_total_mb,
          wifi_ssid, current_app_package, agent_status, adb_status, connection_status, raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        hubId,
        detail.battery ?? null,
        detail.is_charging === undefined ? null : Number(detail.is_charging),
        detail.storage_free_mb ?? null,
        detail.storage_total_mb ?? null,
        detail.wifi_ssid ?? null,
        detail.current_app_package ?? null,
        agentStatus,
        adbStatus,
        connectionStatus,
        JSON.stringify(detail),
      );

      cleanupDuplicateDeviceAliases(db, deviceId, {
        serial: detail.serial,
        active_route: detail.active_route ?? null,
        ip_address: detail.ip_address ?? null,
      });
    }

    for (const heartbeat of payload.agent_heartbeats ?? []) {
      if (!isFreshAgentHeartbeat(heartbeat)) continue;
      const device = findDeviceByIdentity(db, {
        serialNumber: heartbeat.stable_id ?? null,
        stableId: heartbeat.stable_id ?? null,
        agentId: heartbeat.agent_id ?? heartbeat.pairing_id ?? null,
        androidId: heartbeat.android_id ?? null,
      });
      if (!device) {
        continue;
      }

      const row = db.prepare(`SELECT adb_status, previous_ips, android_id FROM devices WHERE id = ?`).get(device.id) as { adb_status: string; previous_ips: string | null; android_id: string | null };
      const connectionStatus = row.adb_status === "online" ? "online" : "agent_online_adb_offline";
      const sessionRealityMatches = reconcileSessionFromHeartbeat(db, device.id, heartbeat);
      const heartbeatAndroidId =
        heartbeat.android_id && row.android_id && row.android_id !== heartbeat.android_id
          ? row.android_id
          : (heartbeat.android_id ?? null);

      db.prepare(`
        UPDATE devices
        SET
          agent_id = COALESCE(?, agent_id),
          pairing_id = COALESCE(?, pairing_id),
          stable_id = COALESCE(?, stable_id),
          android_id = COALESCE(?, android_id),
          model = COALESCE(?, model),
          ip_address = COALESCE(?, ip_address),
          last_known_ip = COALESCE(?, last_known_ip),
          previous_ips = CASE
            WHEN ? IS NOT NULL THEN ?
            ELSE previous_ips
          END,
          agent_version = COALESCE(?, agent_version),
          battery_percent = COALESCE(?, battery_percent),
          is_charging = COALESCE(?, is_charging),
          agent_status = 'online',
          connection_status = ?,
          last_heartbeat_at = CURRENT_TIMESTAMP,
          last_seen_at = CURRENT_TIMESTAMP,
          status = CASE
            WHEN ? = 1 AND ? = 1 THEN 'in_session'
            WHEN status IN ('new', 'pairing_required') AND ? = 'online' THEN 'online'
            ELSE status
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        heartbeat.agent_id ?? heartbeat.pairing_id ?? null,
        heartbeat.agent_id ?? heartbeat.pairing_id ?? null,
        heartbeat.stable_id ?? null,
        heartbeatAndroidId,
        heartbeat.model ?? null,
        heartbeat.local_ip ?? null,
        heartbeat.local_ip ?? null,
        heartbeat.local_ip ? mergePreviousIps(row.previous_ips, heartbeat.local_ip, []) : null,
        heartbeat.local_ip ? mergePreviousIps(row.previous_ips, heartbeat.local_ip, []) : null,
        heartbeat.app_version ?? null,
        heartbeat.battery_level ?? null,
        heartbeat.charging_state ? Number(String(heartbeat.charging_state).toLowerCase() === "charging") : null,
        connectionStatus,
        heartbeat.in_session ? 1 : 0,
        sessionRealityMatches ? 1 : 0,
        connectionStatus,
        device.id,
      );

      db.prepare(`
        INSERT INTO device_telemetry (device_id, local_hub_id, session_seconds, agent_status, connection_status, raw_payload)
        VALUES (?, ?, ?, 'online', ?, ?)
      `).run(device.id, hubId, heartbeat.session_seconds ?? 0, connectionStatus, JSON.stringify(heartbeat));
    }
  });
  tx();

  const instanceId = String(payload.hub_instance_id || `hub-${hubId}`);
  const leaseSeconds = 45;
  const pendingCommands: Array<Record<string, unknown>> = [];
  const claimTx = db.transaction(() => {
    const candidates = db.prepare(`
      SELECT dc.*, COALESCE(d.stable_id, d.serial_number) AS device_serial_number
      FROM device_commands dc
      JOIN devices d ON d.id = dc.device_id
      WHERE dc.local_hub_id = ?
        AND (
          dc.status IN ('created', 'sent_to_hub')
          OR (dc.status IN ('accepted_by_hub', 'running') AND dc.claimed_by = ? AND dc.lease_until > CURRENT_TIMESTAMP)
          OR (dc.status IN ('accepted_by_hub', 'running') AND dc.lease_until IS NOT NULL AND dc.lease_until <= CURRENT_TIMESTAMP)
          OR (dc.status = 'timeout' AND dc.outcome_state = 'unknown')
        )
        AND NOT EXISTS (
            SELECT 1 FROM device_commands earlier
          WHERE earlier.device_id = dc.device_id
            AND (earlier.created_at < dc.created_at OR (earlier.created_at = dc.created_at AND earlier.id < dc.id))
            AND (earlier.status NOT IN ('succeeded', 'failed', 'timeout', 'cancelled')
              OR (earlier.status = 'timeout' AND earlier.outcome_state = 'unknown'))
        )
      ORDER BY dc.created_at ASC, dc.id ASC
    `).all(hubId, instanceId) as Array<Record<string, unknown>>;

    for (const candidate of candidates) {
      const currentStatus = String(candidate.status);
      const activeOwnedByThisInstance = (currentStatus === "accepted_by_hub" || currentStatus === "running")
        && String(candidate.claimed_by || "") === instanceId
        && String(candidate.lease_until || "") > formatSqliteTimestamp(new Date()).slice(0, 19);
      const recovery = (currentStatus === "accepted_by_hub" || currentStatus === "running" || (currentStatus === "timeout" && candidate.outcome_state === "unknown")) && !activeOwnedByThisInstance;
      const claimToken = crypto.randomUUID();
      if (!recovery && (currentStatus === "created" || currentStatus === "sent_to_hub") && Number(candidate.attempt || 0) >= Number(candidate.max_attempts || getCommandPolicy(String(candidate.type)).maxAttempts)) {
        db.prepare(`UPDATE device_commands SET status = 'failed', error_code = 'COMMAND_RETRY_EXHAUSTED', error_message = 'Command delivery attempt budget exhausted', outcome_state = 'known', finished_at = CURRENT_TIMESTAMP, last_transition_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`)
          .run(Number(candidate.id), currentStatus);
        db.prepare(`INSERT INTO device_command_events (command_id, previous_status, new_status, hub_id, hub_instance_id, attempt, error_code, error_message) VALUES (?, ?, 'failed', ?, ?, ?, 'COMMAND_RETRY_EXHAUSTED', 'Command delivery attempt budget exhausted')`)
          .run(Number(candidate.id), currentStatus, hubId, instanceId, Number(candidate.attempt || 0));
        continue;
      }
      const updated = db.prepare(`
        UPDATE device_commands
        SET status = CASE WHEN status IN ('created', 'sent_to_hub') THEN 'accepted_by_hub' ELSE status END,
            accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP), claimed_by = ?,
            claim_token = CASE WHEN status IN ('created', 'sent_to_hub') OR lease_until <= CURRENT_TIMESTAMP OR (status = 'timeout' AND outcome_state = 'unknown') THEN ? ELSE claim_token END,
            lease_until = datetime('now', '+' || ? || ' seconds'), attempt = attempt + CASE WHEN status IN ('created', 'sent_to_hub') OR lease_until <= CURRENT_TIMESTAMP OR (status = 'timeout' AND outcome_state = 'unknown') THEN 1 ELSE 0 END,
            last_transition_at = CURRENT_TIMESTAMP
        WHERE id = ? AND local_hub_id = ?
          AND (
            status IN ('created', 'sent_to_hub')
            OR (status IN ('accepted_by_hub', 'running') AND ((claimed_by = ? AND lease_until > CURRENT_TIMESTAMP) OR lease_until <= CURRENT_TIMESTAMP))
            OR (status = 'timeout' AND outcome_state = 'unknown')
          )
      `).run(instanceId, claimToken, leaseSeconds, Number(candidate.id), hubId, instanceId);
      if (updated.changes !== 1) continue;
      if (!recovery && currentStatus !== "accepted_by_hub") {
        db.prepare(`INSERT INTO device_command_events (command_id, previous_status, new_status, hub_id, hub_instance_id, attempt) VALUES (?, ?, 'accepted_by_hub', ?, ?, ?)`)
          .run(Number(candidate.id), currentStatus, hubId, instanceId, Number(candidate.attempt || 0));
      } else if (recovery) {
        db.prepare(`INSERT INTO device_command_events (command_id, previous_status, new_status, hub_id, hub_instance_id, attempt, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, 'COMMAND_LEASE_RECLAIMED', 'Lease expired; Local Hub must reconcile before executing')`)
          .run(Number(candidate.id), currentStatus, currentStatus, hubId, instanceId, Number(candidate.attempt || 0));
      }
      const claimed = db.prepare(`SELECT dc.*, COALESCE(d.stable_id, d.serial_number) AS device_serial_number FROM device_commands dc JOIN devices d ON d.id = dc.device_id WHERE dc.id = ?`).get(Number(candidate.id)) as Record<string, unknown>;
      pendingCommands.push({ ...claimed, recovery_required: recovery, hub_instance_id: instanceId });
    }
  });
  claimTx();
  return pendingCommands;
}
