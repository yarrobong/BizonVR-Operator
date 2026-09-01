import type { SqliteDatabase, PermissionActor, DeviceDetail } from "../db/types";
import { parseJsonArray } from "../db/json";
import { assertActorCanAccessClub, assertDeviceLimit, assertRole, assertSubscriptionFeature } from "./authorization";
import { getActiveSessionForDevice } from "./session-state";
import { computeConnectionStatus, getDeviceContext, getInstalledAppsForDevice, getLatestDeviceConnectivity } from "../repositories/devices";

export function listDevices(db: SqliteDatabase, actor?: PermissionActor | null) {
  const scope = actor ? `WHERE c.organization_id = ? AND d.club_id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"})` : "";
  const devices = db.prepare(`
    SELECT
      d.*,
      d.battery_percent AS battery,
      d.needs_operator_help AS needs_help,
      d.last_heartbeat_at AS last_heartbeat,
      r.name AS room_name,
      h.name AS local_hub_name
    FROM devices d
    JOIN clubs c ON c.id = d.club_id
    LEFT JOIN club_rooms r ON r.id = d.room_id
    LEFT JOIN local_hubs h ON h.id = d.local_hub_id
    ${scope}
    ORDER BY d.id
  `).all(...(actor ? [actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1])] : [])) as Array<Record<string, unknown>>;

  for (const device of devices) {
    const apps = getInstalledAppsForDevice(db, Number(device.id));
    const activeSession = getActiveSessionForDevice(db, Number(device.id));
    device.installed_apps = JSON.stringify(apps);
    device.session_seconds = getCurrentSessionSeconds(db, Number(device.id));
    device.active_session = activeSession;
    device.remaining_seconds = activeSession?.remaining_seconds ?? 0;
    device.previous_ips = parseJsonArray(String(device.previous_ips ?? "[]"));
    delete device.agent_token_hash;
    delete device.agent_token_issued_at;
    device.device_status = device.status;
    Object.assign(device, getLatestDeviceConnectivity(db, Number(device.id)));
    device.connection_status = computeConnectionStatus(
      {
        serial: typeof device.serial_number === "string" ? String(device.serial_number) : String(device.id ?? ""),
        connection_status: typeof device.connection_status === "string" ? (device.connection_status as DeviceDetail["connection_status"]) : undefined,
        adb_status: typeof device.adb_status === "string" ? (device.adb_status as DeviceDetail["adb_status"]) : undefined,
        agent_status: typeof device.agent_status === "string" ? (device.agent_status as DeviceDetail["agent_status"]) : undefined,
        wifi_ready: Boolean(device.wifi_ready),
        usb_repair_required: Boolean(device.usb_repair_required),
        ip_address:
          typeof device.wifi_ip === "string"
            ? String(device.wifi_ip)
            : typeof device.ip_address === "string"
              ? String(device.ip_address)
              : undefined,
      },
      typeof device.status === "string" ? String(device.status) : null,
    );
  }

  return devices;
}

export function listDevicesForHub(db: SqliteDatabase, localHubId: number) {
  const hub = db.prepare(`
    SELECT h.club_id, c.organization_id
    FROM local_hubs h JOIN clubs c ON c.id = h.club_id
    WHERE h.id = ?
  `).get(localHubId) as { club_id: number; organization_id: number } | undefined;
  if (!hub) return [];
  return listDevices(db, { userId: 0, organizationId: hub.organization_id, role: "technician", clubIds: [hub.club_id] });
}

export function assignDeviceToRoom(db: SqliteDatabase, deviceId: number, roomId: number, actor?: PermissionActor | null) {
  const room = db.prepare(`SELECT club_id FROM club_rooms WHERE id = ?`).get(roomId) as { club_id: number } | undefined;
  if (!room) {
    throw new Error("Room not found");
  }
  const device = getDeviceContext(db, deviceId);
  if (!device) {
    throw new Error("Device not found");
  }
  assertActorCanAccessClub(actor, device.organization_id, device.club_id);
  assertRole(actor, ["owner", "admin", "technician"], "assign device");
  assertSubscriptionFeature(db, device.organization_id, "device_assignment");
  assertDeviceLimit(db, device.organization_id);
  if (device.club_id !== room.club_id) {
    throw new Error("Device and room must belong to the same club");
  }

  db.prepare(`
    UPDATE devices
    SET room_id = ?, status = CASE WHEN status = 'new' THEN 'online' ELSE status END, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(roomId, deviceId);
}

export function dismissHelpRequest(db: SqliteDatabase, deviceId: number, actor?: PermissionActor | null) {
  const device = getDeviceContext(db, deviceId);
  if (!device) {
    throw new Error("Device not found");
  }
  assertActorCanAccessClub(actor, device.organization_id, device.club_id);
  assertRole(actor, ["owner", "admin", "operator", "technician"], "dismiss help request");

  db.prepare(`
    UPDATE devices
    SET needs_operator_help = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(deviceId);
}

function getCurrentSessionSeconds(db: SqliteDatabase, deviceId: number) {
  const row = db.prepare(`
    SELECT MAX(session_seconds) AS session_seconds
    FROM device_telemetry
    WHERE device_id = ?
  `).get(deviceId) as { session_seconds: number | null };
  return row.session_seconds ?? 0;
}
