import type { SqliteDatabase, CreateDeviceInput, DeviceDetail, DeviceIdentity } from "../db/types";
import { parseJsonArray } from "../db/json";
import { writeAuditLog } from "./audit";
function dedupeIps(...groups: Array<Array<string | null | undefined> | undefined>) {
  const ordered: string[] = [];
  for (const group of groups) {
    for (const ip of group ?? []) {
      if (!ip || ordered.includes(ip)) {
        continue;
      }
      ordered.push(ip);
    }
  }
  return ordered;
}

export function mergePreviousIps(existingValue: string | null | undefined, nextIp?: string | null, reportedIps?: string[]) {
  const existing = parseJsonArray(existingValue);
  const merged = dedupeIps([nextIp ?? null], reportedIps, existing);
  return JSON.stringify(merged.slice(0, 8));
}

export function computeConnectionStatus(detail: DeviceDetail, existingStatus?: string | null) {
  if (detail.connection_status) {
    return detail.connection_status;
  }

  const adbStatus = detail.adb_status ?? "unknown";
  const agentStatus = detail.agent_status ?? "unknown";
  const adbOnline = adbStatus === "online";

  if (adbStatus === "unauthorized") {
    return "usb_unauthorized";
  }
  if (adbOnline && agentStatus === "online") {
    return "online";
  }
  if (adbOnline && detail.wifi_ready) {
    return "wifi_ready";
  }
  if (adbOnline) {
    return "adb_online_agent_offline";
  }
  if (agentStatus === "online") {
    return "agent_online_adb_offline";
  }
  if (detail.usb_repair_required) {
    return "usb_repair_required";
  }
  if (detail.ip_address && adbStatus === "offline") {
    return existingStatus === "new" ? "pairing_in_progress" : "offline_sleeping";
  }
  return existingStatus === "new" ? "new" : "unknown_error";
}

export function findDeviceByIdentity(db: SqliteDatabase, identity: DeviceIdentity) {
  const lookups: Array<{ sql: string; value: string | null | undefined }> = [
    { sql: `SELECT id FROM devices WHERE agent_id = ?`, value: identity.agentId },
    { sql: `SELECT id FROM devices WHERE pairing_id = ?`, value: identity.agentId },
    { sql: `SELECT id FROM devices WHERE stable_id = ?`, value: identity.stableId },
    { sql: `SELECT id FROM devices WHERE serial_number = ?`, value: identity.serialNumber },
    { sql: `SELECT id FROM devices WHERE android_id = ?`, value: identity.androidId },
  ];

  for (const lookup of lookups) {
    if (!lookup.value) {
      continue;
    }
    const existing = db.prepare(lookup.sql).get(lookup.value) as { id: number } | undefined;
    if (existing) {
      return existing;
    }
  }

  return undefined;
}

export function createDevice(db: SqliteDatabase, input: CreateDeviceInput) {
  const result = db.prepare(`
    INSERT INTO devices (
      club_id, room_id, local_hub_id, name, serial_number, stable_id, agent_id, android_id, pairing_id, model, status,
      connection_status, battery_percent, adb_status, agent_status, last_heartbeat_at, last_seen_at, identity_last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    input.clubId,
    input.roomId ?? null,
    input.localHubId ?? null,
    input.name,
    input.serialNumber,
    input.stableId ?? input.serialNumber,
    input.agentId ?? input.pairingId ?? null,
    input.androidId ?? null,
    input.pairingId ?? null,
    input.model ?? "Meta Quest 3",
    input.status ?? "online",
    input.connectionStatus ?? "online",
    input.batteryPercent ?? 100,
  );
  const club = db.prepare(`SELECT organization_id FROM clubs WHERE id = ?`).get(input.clubId) as { organization_id: number } | undefined;
  writeAuditLog(db, {
    action: "device.created",
    entityType: "device",
    entityId: Number(result.lastInsertRowid),
    organizationId: club?.organization_id,
    clubId: input.clubId,
    localHubId: input.localHubId ?? null,
    deviceId: Number(result.lastInsertRowid),
    details: input,
  });
  return Number(result.lastInsertRowid);
}


export function getDeviceContext(db: SqliteDatabase, deviceId: number) {
  return db.prepare(`
    SELECT
      d.id,
      d.club_id,
      d.local_hub_id,
      d.room_id,
      d.status,
      d.adb_status,
      d.agent_status,
      d.battery_percent,
      d.storage_free_mb,
      d.storage_total_mb,
      d.stable_id,
      d.android_id,
      d.agent_id,
      c.organization_id
    FROM devices d
    JOIN clubs c ON c.id = d.club_id
    WHERE d.id = ?
  `).get(deviceId) as
    | {
        id: number;
        club_id: number;
        local_hub_id: number | null;
        room_id: number | null;
        status: string;
        adb_status: string;
        agent_status: string;
        battery_percent: number;
        storage_free_mb: number | null;
        storage_total_mb: number | null;
        stable_id: string | null;
        android_id: string | null;
        agent_id: string | null;
        organization_id: number;
      }
    | undefined;
}

export function getInstalledAppsForDevice(db: SqliteDatabase, deviceId: number) {
  return db.prepare(`
    SELECT
      da.package_name AS package,
      COALESCE(a.name, da.package_name) AS name,
      da.version_name,
      da.version_code,
      da.install_state
    FROM device_apps da
    LEFT JOIN apps a ON a.id = da.app_id
    WHERE da.device_id = ? AND da.install_state IN ('installed', 'installing')
    ORDER BY name
  `).all(deviceId);
}


export function getLatestDeviceConnectivity(db: SqliteDatabase, deviceId: number) {
  const rows = db.prepare(`
    SELECT raw_payload
    FROM device_telemetry
    WHERE device_id = ? AND raw_payload IS NOT NULL AND raw_payload != '{}'
    ORDER BY captured_at DESC, id DESC
    LIMIT 10
  `).all(deviceId) as Array<{ raw_payload: string }>;

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.raw_payload);
      const hasConnectivityFields = [
        payload.connection_status,
        payload.status_reason,
        payload.next_step,
        payload.transport,
        payload.active_route,
        payload.ip_address,
        payload.wifi_ready,
        payload.usb_repair_required,
        payload.wake_supported,
      ].some((value) => value !== undefined && value !== null);

      if (!hasConnectivityFields) {
        continue;
      }

      return {
        connection_status: payload.connection_status ? String(payload.connection_status) : null,
        wifi_ready: Boolean(payload.wifi_ready),
        usb_repair_required: Boolean(payload.usb_repair_required),
        status_reason: payload.status_reason ? String(payload.status_reason) : null,
        next_operator_step: payload.next_step ? String(payload.next_step) : null,
        wake_supported: Boolean(payload.wake_supported),
        transport: payload.transport ? String(payload.transport) : null,
        active_route: payload.active_route ? String(payload.active_route) : null,
        wifi_ip: payload.ip_address ? String(payload.ip_address) : null,
        ip_changed: Boolean(payload.ip_changed),
        adb_recovery_status: payload.adb_recovery_status ? String(payload.adb_recovery_status) : null,
        adb_recovery_permission: payload.adb_recovery_permission ? String(payload.adb_recovery_permission) : null,
      };
    } catch {
      continue;
    }
  }

  return {};
}

export function cleanupDuplicateDeviceAliases(db: SqliteDatabase, canonicalDeviceId: number, detail: Pick<DeviceDetail, "serial" | "active_route" | "ip_address">) {
  const routeSerials = [detail.active_route, detail.serial]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (routeSerials.length === 0) {
    return;
  }

  const duplicates = db.prepare(`
    SELECT id
    FROM devices
    WHERE id != ?
      AND (serial_number IN (${routeSerials.map(() => "?").join(",")}) OR stable_id IN (${routeSerials.map(() => "?").join(",")}))
      AND agent_id IS NULL
      AND android_id IS NULL
      AND status NOT IN ('busy', 'in_session')
  `).all(canonicalDeviceId, ...routeSerials, ...routeSerials) as Array<{ id: number }>;

  for (const duplicate of duplicates) {
    db.prepare(`DELETE FROM devices WHERE id = ?`).run(duplicate.id);
  }
}



export function markDevicePairing(db: SqliteDatabase, deviceId: number, requestedName?: string | null) {
  db.prepare(`UPDATE devices SET name = COALESCE(NULLIF(?, ''), name), status = 'pairing_required', connection_status = CASE WHEN connection_status = 'new' THEN 'pairing_in_progress' ELSE connection_status END, next_operator_step = 'Wait for Local Hub to install Agent and enable Wi-Fi ADB.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(requestedName || null, deviceId);
}
