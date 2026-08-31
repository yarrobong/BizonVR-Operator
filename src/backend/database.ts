import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";

type SqliteDatabase = Database.Database;

type CreateOrganizationInput = {
  name: string;
  slug: string;
  status?: string;
};

type CreateClubInput = {
  organizationId: number;
  name: string;
  slug: string;
  timezone?: string;
  address?: string;
};

type CreateZoneInput = {
  clubId: number;
  name: string;
  slug: string;
  sortOrder?: number;
};

type CreateRoomInput = {
  clubId: number;
  zoneId?: number | null;
  name: string;
  slug: string;
  capacity?: number;
  sortOrder?: number;
  mapX?: number;
  mapY?: number;
  mapW?: number;
  mapH?: number;
};

type CreateHubInput = {
  clubId: number;
  name: string;
  status?: string;
  host?: string;
};

type CreateDeviceInput = {
  clubId: number;
  roomId?: number | null;
  localHubId?: number | null;
  name: string;
  serialNumber: string;
  stableId?: string | null;
  agentId?: string | null;
  androidId?: string | null;
  pairingId?: string | null;
  model?: string;
  status?: string;
  connectionStatus?: string;
  batteryPercent?: number;
};

type CreateAppInput = {
  organizationId?: number | null;
  name: string;
  slug: string;
  packageName: string;
  visibility?: string;
};

type CreateAppVersionInput = {
  appId: number;
  versionName: string;
  versionCode?: number | null;
  apkChecksum: string;
  downloadUrl?: string | null;
};

type UpsertDeviceAppInput = {
  deviceId: number;
  appId?: number | null;
  appVersionId?: number | null;
  packageName: string;
  versionName?: string | null;
  versionCode?: number | null;
  installState?: string;
};

type CreateCommandInput = {
  deviceId: number;
  localHubId: number;
  type: string;
  payload?: Record<string, unknown>;
  createdByUserId?: number | null;
  sessionId?: number | null;
  actor?: PermissionActor | null;
};

type CreateSessionInput = {
  title: string;
  roomId?: number | null;
  deviceIds: number[];
  appPackage: string;
  appActivity?: string;
  durationMinutes: number;
  requireScrcpy?: boolean;
  operatorNotes?: string;
  createdByUserId?: number | null;
  actor?: PermissionActor | null;
};

export type PermissionActor = {
  userId: number;
  organizationId: number;
  role: "owner" | "admin" | "operator" | "technician" | "viewer";
  clubIds?: number[];
};

type SubscriptionState = {
  status: string;
  deviceLimit: number | null;
  features: Record<string, unknown>;
};

const PACKAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const ACTIVE_SESSION_STATUSES = ["preparing", "ready", "starting", "running", "paused", "extended", "finishing"];
const ACTIVE_SESSION_DEVICE_STATUSES = ["preparing", "ready", "running", "paused"];
const TECHNICAL_COMMAND_TYPES = new Set([
  "INSTALL_APP",
  "INSTALL_APK",
  "UNINSTALL_APP",
  "REBOOT_DEVICE",
  "OPEN_SCRCPY",
  "CLOSE_SCRCPY",
  "RUN_DIAGNOSTICS",
  "FORGET_DEVICE",
  "RECONNECT_ADB",
  "RELAUNCH_AGENT",
]);
const SESSION_CONTROL_COMMAND_TYPES = new Set([
  "START_SESSION",
  "PAUSE_SESSION",
  "RESUME_SESSION",
  "SWITCH_SESSION_APP",
  "END_SESSION",
]);
const COMMAND_TRANSITIONS: Record<string, string[]> = {
  created: ["sent_to_hub", "accepted_by_hub", "cancelled", "timeout"],
  sent_to_hub: ["accepted_by_hub", "cancelled", "timeout"],
  accepted_by_hub: ["running", "succeeded", "failed", "timeout", "cancelled"],
  running: ["succeeded", "failed", "timeout", "cancelled"],
  succeeded: [],
  failed: [],
  timeout: [],
  cancelled: [],
};

function isValidPackageName(packageName: string) {
  return PACKAGE_NAME_PATTERN.test(packageName);
}

function formatSqliteTimestamp(date: Date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseSqliteTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

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

function mergePreviousIps(existingValue: string | null | undefined, nextIp?: string | null, reportedIps?: string[]) {
  const existing = parseJsonArray(existingValue);
  const merged = dedupeIps([nextIp ?? null], reportedIps, existing);
  return JSON.stringify(merged.slice(0, 8));
}

function computeConnectionStatus(detail: DeviceDetail, existingStatus?: string | null) {
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

function findDeviceByIdentity(db: SqliteDatabase, identity: DeviceIdentity) {
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

function getSubscriptionState(db: SqliteDatabase, organizationId: number): SubscriptionState | null {
  const row = db.prepare(`
    SELECT
      os.status,
      COALESCE(os.device_limit, sp.max_devices) AS device_limit,
      sp.features_json,
      os.features_override_json
    FROM organization_subscriptions os
    JOIN subscription_plans sp ON sp.id = os.plan_id
    WHERE os.organization_id = ?
    ORDER BY os.created_at DESC, os.id DESC
    LIMIT 1
  `).get(organizationId) as
    | { status: string; device_limit: number | null; features_json: string; features_override_json: string }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    status: row.status,
    deviceLimit: row.device_limit,
    features: {
      ...parseJsonObject(row.features_json),
      ...parseJsonObject(row.features_override_json),
    },
  };
}

function assertActorCanAccessClub(actor: PermissionActor | null | undefined, organizationId: number, clubId: number) {
  if (!actor) {
    return;
  }
  if (actor.organizationId !== organizationId) {
    throw new Error("Permission denied: organization scope mismatch");
  }
  if (actor.clubIds && !actor.clubIds.includes(clubId)) {
    throw new Error("Permission denied: club scope mismatch");
  }
}

function assertRole(actor: PermissionActor | null | undefined, allowedRoles: PermissionActor["role"][], action: string) {
  if (!actor) {
    return;
  }
  if (!allowedRoles.includes(actor.role)) {
    throw new Error(`Permission denied: ${action} requires ${allowedRoles.join(" or ")}`);
  }
}

function assertSubscriptionFeature(db: SqliteDatabase, organizationId: number, feature: string) {
  const subscription = getSubscriptionState(db, organizationId);
  if (!subscription || !["trialing", "active"].includes(subscription.status)) {
    throw new Error("Subscription blocked: active subscription is required");
  }
  if (subscription.features[feature] !== true) {
    throw new Error(`Subscription blocked: ${feature} feature is not enabled`);
  }
}

function assertDeviceLimit(db: SqliteDatabase, organizationId: number) {
  const subscription = getSubscriptionState(db, organizationId);
  if (subscription?.deviceLimit === null || subscription?.deviceLimit === undefined) {
    return;
  }

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM devices d
    JOIN clubs c ON c.id = d.club_id
    WHERE c.organization_id = ? AND d.status != 'disabled'
  `).get(organizationId) as { count: number };

  if (row.count > subscription.deviceLimit) {
    throw new Error(`Subscription blocked: device limit exceeded (${row.count}/${subscription.deviceLimit})`);
  }
}

type DeviceDetail = {
  serial: string;
  stable_id?: string;
  usb_serial?: string | null;
  agent_id?: string | null;
  android_id?: string | null;
  model?: string;
  battery?: number;
  installed_apps?: Array<{ package: string; name?: string; version_name?: string; version_code?: number }>;
  storage_free_mb?: number;
  storage_total_mb?: number;
  wifi_ssid?: string;
  ip_address?: string;
  previous_ips?: string[];
  active_route?: string | null;
  current_app_package?: string;
  app_version?: string | null;
  is_charging?: boolean;
  adb_status?: "unknown" | "online" | "offline" | "reconnecting" | "unauthorized" | "tcpip_unavailable" | "port_closed" | "different_device" | "unavailable";
  agent_status?: "unknown" | "online" | "offline" | "missing" | "error";
  adb_recovery_status?: string | null;
  adb_recovery_permission?: string | null;
  wifi_ready?: boolean;
  usb_repair_required?: boolean;
  status_reason?: string;
  next_step?: string;
  transport?: string;
  wake_supported?: boolean;
  ip_changed?: boolean;
  connection_status?: "new" | "usb_pairing_required" | "usb_unauthorized" | "pairing_in_progress" | "wifi_ready" | "online" | "agent_online_adb_offline" | "adb_online_agent_offline" | "vpn_or_lan_blocked" | "usb_repair_required" | "offline_sleeping" | "unknown_error";
};

type SyncPayload = {
  active_serials?: string[];
  device_details?: DeviceDetail[];
  hub_host?: string;
  agent_heartbeats?: Array<{
    agent_id?: string;
    pairing_id?: string;
    stable_id?: string;
    android_id?: string;
    model?: string;
    session_seconds?: number;
    remaining_seconds?: number;
    session_status?: string;
    paused?: boolean;
    current_app_package?: string;
    current_app_name?: string;
    in_session?: boolean;
    local_ip?: string;
    app_version?: string;
    battery_level?: number;
    charging_state?: string;
    foreground_state?: string;
  }>;
};

type DeviceIdentity = {
  serialNumber?: string | null;
  stableId?: string | null;
  agentId?: string | null;
  androidId?: string | null;
};

const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || "com.bizonvr.spatialspike";

function readMigration(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function listMigrationFiles() {
  return fs.readdirSync(path.join(process.cwd(), "db", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function resolveSeedQuestAgentChecksum() {
  const apkPath = process.env.QUEST_AGENT_APK_PATH
    ? path.resolve(process.env.QUEST_AGENT_APK_PATH)
    : path.join(process.cwd(), "quest-agent-spatial-spike", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

  try {
    const apkBytes = fs.readFileSync(apkPath);
    return crypto.createHash("sha256").update(apkBytes).digest("hex");
  } catch {
    return "dev-launcher-checksum";
  }
}

export function createDatabase(filename = ":memory:"): SqliteDatabase {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  applyMigrations(db);
  return db;
}

function ensureSchemaCompatibility(db: SqliteDatabase, migrationFile?: string) {
  const columns = db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if ((!migrationFile || migrationFile === "0002_device_route_columns.sql") && !columnNames.has("active_route")) {
    db.exec(`ALTER TABLE devices ADD COLUMN active_route TEXT`);
  }
  if ((!migrationFile || migrationFile === "0002_device_route_columns.sql") && !columnNames.has("last_adb_seen_at")) {
    db.exec(`ALTER TABLE devices ADD COLUMN last_adb_seen_at TEXT`);
  }
  if (!migrationFile || migrationFile === "0004_session_lifecycle.sql") {
    const hasSessionDevices = Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_devices'`).get());
    if (hasSessionDevices) {
      const sessionDeviceColumns = new Set((db.prepare(`PRAGMA table_info(session_devices)`).all() as Array<{ name: string }>).map((column) => column.name));
      if (!sessionDeviceColumns.has("paused_at")) db.exec(`ALTER TABLE session_devices ADD COLUMN paused_at TEXT`);
      if (!sessionDeviceColumns.has("total_paused_seconds")) db.exec(`ALTER TABLE session_devices ADD COLUMN total_paused_seconds INTEGER NOT NULL DEFAULT 0`);
      if (!sessionDeviceColumns.has("paused_remaining_seconds")) db.exec(`ALTER TABLE session_devices ADD COLUMN paused_remaining_seconds INTEGER`);
      if (!sessionDeviceColumns.has("current_app_package")) db.exec(`ALTER TABLE session_devices ADD COLUMN current_app_package TEXT`);
      if (!sessionDeviceColumns.has("current_app_name")) db.exec(`ALTER TABLE session_devices ADD COLUMN current_app_name TEXT`);
      if (!sessionDeviceColumns.has("last_app_switch_at")) db.exec(`ALTER TABLE session_devices ADD COLUMN last_app_switch_at TEXT`);
      db.exec(`UPDATE session_devices SET current_app_package = COALESCE(current_app_package, launch_package_name) WHERE current_app_package IS NULL`);
    }
  }
}

function applyMigrations(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const existingTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name != 'schema_migrations'
  `).all() as Array<{ name: string }>;
  const appliedVersions = new Set(
    (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: string }>)
      .map((row) => row.version)
  );

  if (existingTables.length > 0 && !appliedVersions.has("0001_initial.sql")) {
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)`).run("0001_initial.sql");
    appliedVersions.add("0001_initial.sql");
  }

  for (const migrationFile of listMigrationFiles()) {
    if (appliedVersions.has(migrationFile)) {
      continue;
    }

    try {
      db.exec(readMigration(path.join("db", "migrations", migrationFile)));
    } catch (error) {
      if (!["0002_device_route_columns.sql", "0004_session_lifecycle.sql"].includes(migrationFile)) {
        throw error;
      }
      ensureSchemaCompatibility(db, migrationFile);
    }

    ensureSchemaCompatibility(db, migrationFile);
    db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(migrationFile);
  }
}

export function writeAuditLog(
  db: SqliteDatabase,
  params: {
    action: string;
    entityType: string;
    entityId: number | string;
    organizationId?: number | null;
    clubId?: number | null;
    userId?: number | null;
    localHubId?: number | null;
    deviceId?: number | null;
    sessionId?: number | null;
    commandId?: number | null;
    details?: Record<string, unknown>;
  },
) {
  db.prepare(`
    INSERT INTO audit_logs (
      organization_id, club_id, user_id, local_hub_id, device_id, session_id, command_id,
      action, entity_type, entity_id, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.organizationId ?? null,
    params.clubId ?? null,
    params.userId ?? null,
    params.localHubId ?? null,
    params.deviceId ?? null,
    params.sessionId ?? null,
    params.commandId ?? null,
    params.action,
    params.entityType,
    String(params.entityId),
    JSON.stringify(params.details ?? {}),
  );
}

export function createOrganization(db: SqliteDatabase, input: CreateOrganizationInput) {
  const result = db.prepare(`
    INSERT INTO organizations (name, slug, status) VALUES (?, ?, ?)
  `).run(input.name, input.slug, input.status ?? "active");
  writeAuditLog(db, {
    action: "organization.created",
    entityType: "organization",
    entityId: Number(result.lastInsertRowid),
    organizationId: Number(result.lastInsertRowid),
    details: input,
  });
  return Number(result.lastInsertRowid);
}

export function createUser(
  db: SqliteDatabase,
  input: { organizationId: number; email: string; fullName: string; role: string; status?: string },
) {
  const result = db.prepare(`
    INSERT INTO users (organization_id, email, full_name, role, status) VALUES (?, ?, ?, ?, ?)
  `).run(input.organizationId, input.email, input.fullName, input.role, input.status ?? "active");
  writeAuditLog(db, {
    action: "user.created",
    entityType: "user",
    entityId: Number(result.lastInsertRowid),
    organizationId: input.organizationId,
    userId: Number(result.lastInsertRowid),
    details: input,
  });
  return Number(result.lastInsertRowid);
}

export function getPermissionActor(db: SqliteDatabase, userId: number): PermissionActor | null {
  const user = db.prepare(`
    SELECT id, organization_id, role, status
    FROM users
    WHERE id = ?
  `).get(userId) as
    | { id: number; organization_id: number; role: PermissionActor["role"]; status: string }
    | undefined;

  if (!user || user.status !== "active") {
    return null;
  }

  const clubs = db.prepare(`
    SELECT id FROM clubs WHERE organization_id = ? AND status != 'archived'
  `).all(user.organization_id) as Array<{ id: number }>;

  return {
    userId: user.id,
    organizationId: user.organization_id,
    role: user.role,
    clubIds: clubs.map((club) => club.id),
  };
}

export function getDefaultPermissionActor(db: SqliteDatabase): PermissionActor | null {
  const user = db.prepare(`
    SELECT id FROM users WHERE status = 'active' ORDER BY id ASC LIMIT 1
  `).get() as { id: number } | undefined;
  return user ? getPermissionActor(db, user.id) : null;
}

export function createClub(db: SqliteDatabase, input: CreateClubInput) {
  const result = db.prepare(`
    INSERT INTO clubs (organization_id, name, slug, timezone, address) VALUES (?, ?, ?, ?, ?)
  `).run(input.organizationId, input.name, input.slug, input.timezone ?? "UTC", input.address ?? null);
  writeAuditLog(db, {
    action: "club.created",
    entityType: "club",
    entityId: Number(result.lastInsertRowid),
    organizationId: input.organizationId,
    clubId: Number(result.lastInsertRowid),
    details: input,
  });
  return Number(result.lastInsertRowid);
}

export function createClubZone(db: SqliteDatabase, input: CreateZoneInput) {
  const result = db.prepare(`
    INSERT INTO club_zones (club_id, name, slug, sort_order) VALUES (?, ?, ?, ?)
  `).run(input.clubId, input.name, input.slug, input.sortOrder ?? 0);
  const club = db.prepare(`SELECT organization_id FROM clubs WHERE id = ?`).get(input.clubId) as { organization_id: number } | undefined;
  writeAuditLog(db, {
    action: "zone.created",
    entityType: "club_zone",
    entityId: Number(result.lastInsertRowid),
    organizationId: club?.organization_id,
    clubId: input.clubId,
    details: input,
  });
  return Number(result.lastInsertRowid);
}

export function createClubRoom(db: SqliteDatabase, input: CreateRoomInput) {
  const result = db.prepare(`
    INSERT INTO club_rooms (club_id, zone_id, name, slug, capacity, sort_order, map_x, map_y, map_w, map_h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.clubId,
    input.zoneId ?? null,
    input.name,
    input.slug,
    input.capacity ?? 1,
    input.sortOrder ?? 0,
    input.mapX ?? 0,
    input.mapY ?? 0,
    input.mapW ?? 1,
    input.mapH ?? 1,
  );
  const club = db.prepare(`SELECT organization_id FROM clubs WHERE id = ?`).get(input.clubId) as { organization_id: number } | undefined;
  writeAuditLog(db, {
    action: "room.created",
    entityType: "club_room",
    entityId: Number(result.lastInsertRowid),
    organizationId: club?.organization_id,
    clubId: input.clubId,
    details: input,
  });
  return Number(result.lastInsertRowid);
}

export function createLocalHub(db: SqliteDatabase, input: CreateHubInput) {
  const result = db.prepare(`
    INSERT INTO local_hubs (club_id, name, status, host, last_heartbeat_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(input.clubId, input.name, input.status ?? "online", input.host ?? null);
  const club = db.prepare(`SELECT organization_id FROM clubs WHERE id = ?`).get(input.clubId) as { organization_id: number } | undefined;
  writeAuditLog(db, {
    action: "local_hub.created",
    entityType: "local_hub",
    entityId: Number(result.lastInsertRowid),
    organizationId: club?.organization_id,
    clubId: input.clubId,
    localHubId: Number(result.lastInsertRowid),
    details: input,
  });
  return Number(result.lastInsertRowid);
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

export function createApp(db: SqliteDatabase, input: CreateAppInput) {
  const result = db.prepare(`
    INSERT INTO apps (organization_id, name, slug, package_name, visibility)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.organizationId ?? null, input.name, input.slug, input.packageName, input.visibility ?? "global");
  writeAuditLog(db, {
    action: "app.created",
    entityType: "app",
    entityId: Number(result.lastInsertRowid),
    organizationId: input.organizationId ?? null,
    details: input,
  });
  return Number(result.lastInsertRowid);
}

export function createAppVersion(db: SqliteDatabase, input: CreateAppVersionInput) {
  const result = db.prepare(`
    INSERT INTO app_versions (app_id, version_name, version_code, apk_checksum, download_url)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.appId, input.versionName, input.versionCode ?? null, input.apkChecksum, input.downloadUrl ?? null);
  return Number(result.lastInsertRowid);
}

export function getLatestAppVersionForPackage(db: SqliteDatabase, packageName: string) {
  return db.prepare(`
    SELECT
      av.id,
      av.version_name,
      av.version_code,
      av.apk_checksum,
      av.download_url,
      a.package_name
    FROM app_versions av
    JOIN apps a ON a.id = av.app_id
    WHERE a.package_name = ? AND av.is_active = 1
    ORDER BY av.created_at DESC, av.id DESC
    LIMIT 1
  `).get(packageName) as
    | {
        id: number;
        version_name: string;
        version_code: number | null;
        apk_checksum: string;
        download_url: string | null;
        package_name: string;
      }
    | undefined;
}

export function upsertDeviceApp(db: SqliteDatabase, input: UpsertDeviceAppInput) {
  db.prepare(`
    INSERT INTO device_apps (
      device_id, app_id, app_version_id, package_name, version_name, version_code, install_state, installed_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id, package_name) DO UPDATE SET
      app_id = excluded.app_id,
      app_version_id = excluded.app_version_id,
      version_name = excluded.version_name,
      version_code = excluded.version_code,
      install_state = excluded.install_state,
      last_checked_at = CURRENT_TIMESTAMP
  `).run(
    input.deviceId,
    input.appId ?? null,
    input.appVersionId ?? null,
    input.packageName,
    input.versionName ?? null,
    input.versionCode ?? null,
    input.installState ?? "installed",
  );
}

export function createSubscriptionPlan(
  db: SqliteDatabase,
  input: { code: string; name: string; maxClubs?: number | null; maxDevices?: number | null; features?: Record<string, unknown> },
) {
  const result = db.prepare(`
    INSERT INTO subscription_plans (code, name, max_clubs, max_devices, features_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.code,
    input.name,
    input.maxClubs ?? null,
    input.maxDevices ?? null,
    JSON.stringify(input.features ?? {}),
  );
  return Number(result.lastInsertRowid);
}

export function createOrganizationSubscription(
  db: SqliteDatabase,
  input: { organizationId: number; planId: number; clubLimit?: number | null; deviceLimit?: number | null; status?: string },
) {
  const result = db.prepare(`
    INSERT INTO organization_subscriptions (organization_id, plan_id, club_limit, device_limit, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.organizationId, input.planId, input.clubLimit ?? null, input.deviceLimit ?? null, input.status ?? "active");
  return Number(result.lastInsertRowid);
}

function getDeviceContext(db: SqliteDatabase, deviceId: number) {
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
        organization_id: number;
      }
    | undefined;
}

export function createDeviceCommand(db: SqliteDatabase, input: CreateCommandInput) {
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

  const result = db.prepare(`
    INSERT INTO device_commands (
      organization_id, club_id, local_hub_id, device_id, session_id, type, payload, status, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?)
  `).run(
    context.organization_id,
    context.club_id,
    input.localHubId,
    input.deviceId,
    input.sessionId ?? null,
    input.type,
    JSON.stringify(input.payload ?? {}),
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
    JSON.stringify(input.payload ?? {}),
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
  status: "running" | "paused" | "ended";
  app_package: string;
  app_name: string | null;
  current_app_package: string;
  current_app_name: string | null;
  last_app_switch_at: string | null;
  is_expired: boolean;
};

function resolveAppName(db: SqliteDatabase, packageName: string | null | undefined) {
  if (!packageName) {
    return null;
  }
  const row = db.prepare(`SELECT name FROM apps WHERE package_name = ? LIMIT 1`).get(packageName) as { name: string } | undefined;
  return row?.name ?? null;
}

function getSessionDurationSeconds(row: Pick<ActiveSessionRow, "duration_minutes" | "extension_minutes">) {
  return Math.max(0, (Number(row.duration_minutes) + Number(row.extension_minutes || 0)) * 60);
}

function computeRemainingSeconds(row: Pick<ActiveSessionRow, "duration_minutes" | "extension_minutes" | "started_at" | "paused_at" | "paused_remaining_seconds" | "total_paused_seconds" | "session_device_status" | "finished_at">, now = new Date()) {
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

function mapActiveSessionRow(row: ActiveSessionRow | undefined | null, now = new Date()): ActiveSessionSummary | null {
  if (!row) {
    return null;
  }
  const remainingSeconds = computeRemainingSeconds(row, now);
  const currentAppPackage = row.current_app_package ?? row.launch_package_name;
  const currentAppName = row.current_app_name ?? row.launch_app_name ?? null;
  const status = row.finished_at
    ? "ended"
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
  };
}

function getActiveSessionRowForDevice(db: SqliteDatabase, deviceId: number) {
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
      sd.last_app_switch_at
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

function getActiveSessionRowBySessionId(db: SqliteDatabase, sessionId: number) {
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
      sd.last_app_switch_at
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

function resolveActiveSessionReference(db: SqliteDatabase, referenceId: number, mode: "session" | "device" | "either" = "either") {
  if (mode === "session") {
    return getActiveSessionRowBySessionId(db, referenceId);
  }
  if (mode === "device") {
    return getActiveSessionRowForDevice(db, referenceId);
  }
  return getActiveSessionRowBySessionId(db, referenceId) ?? getActiveSessionRowForDevice(db, referenceId);
}

function buildSessionStatePayload(summary: ActiveSessionSummary) {
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
  };
}

export function createSession(db: SqliteDatabase, input: CreateSessionInput) {
  if (input.deviceIds.length === 0) {
    throw new Error("At least one device is required");
  }
  if (!isValidPackageName(input.appPackage)) {
    throw new Error("Invalid app package name");
  }

  const firstDevice = getDeviceContext(db, input.deviceIds[0]);
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
  const preflight = validateSessionPreflight(db, input, firstDevice);
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
    for (const deviceId of input.deviceIds) {
      const context = getDeviceContext(db, deviceId);
      if (!context || context.club_id !== firstDevice.club_id) {
        throw new Error("All session devices must belong to the same club");
      }

      const sessionDeviceResult = insertSessionDevice.run(
        sessionId,
        deviceId,
        input.appPackage,
        input.appPackage,
        appName,
        requireScrcpy,
        requireScrcpy,
      );

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
          },
        },
      });

      appendSessionEvent(db, {
        sessionId,
        sessionDeviceId: Number(sessionDeviceResult.lastInsertRowid),
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

export function finishActiveSessionForDevice(db: SqliteDatabase, deviceId: number, actor?: PermissionActor | null) {
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

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE session_devices
      SET status = CASE WHEN status = 'preparing' THEN 'preparing' ELSE status END,
          end_reason = 'operator_stop',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(active.session_device_id);

    db.prepare(`
      UPDATE sessions SET status = 'finishing', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(active.session_id);

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

export function pauseSession(db: SqliteDatabase, sessionId: number, actor?: PermissionActor | null) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) {
    throw new Error("Active session not found");
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
    db.prepare(`
      UPDATE session_devices
      SET status = 'paused',
          paused_at = ?,
          paused_remaining_seconds = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(pausedAt, remainingSeconds, active.session_device_id);

    db.prepare(`
      UPDATE sessions
      SET status = 'paused', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(active.session_id);

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

export function resumeSession(db: SqliteDatabase, sessionId: number, actor?: PermissionActor | null) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) {
    throw new Error("Active session not found");
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
    db.prepare(`
      UPDATE session_devices
      SET status = 'running',
          paused_at = NULL,
          paused_remaining_seconds = NULL,
          total_paused_seconds = total_paused_seconds + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(additionalPausedSeconds, active.session_device_id);

    db.prepare(`
      UPDATE sessions
      SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(active.session_id);

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
  input: { appPackage: string; appActivity?: string; actor?: PermissionActor | null },
) {
  const active = resolveActiveSessionReference(db, sessionId, "session");
  if (!active) {
    throw new Error("Active session not found");
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
    db.prepare(`
      UPDATE session_devices
      SET current_app_package = ?,
          current_app_name = ?,
          last_app_switch_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(input.appPackage, currentAppName, active.session_device_id);

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

export function listRooms(db: SqliteDatabase) {
  return db.prepare(`
    SELECT
      r.*,
      z.name AS zone_name,
      c.name AS club_name
    FROM club_rooms r
    LEFT JOIN club_zones z ON z.id = r.zone_id
    JOIN clubs c ON c.id = r.club_id
    ORDER BY c.id, r.sort_order, r.id
  `).all();
}

export function listClubs(db: SqliteDatabase) {
  return db.prepare(`SELECT * FROM clubs ORDER BY id`).all();
}

export function listLocalHubs(db: SqliteDatabase) {
  return db.prepare(`SELECT * FROM local_hubs ORDER BY id`).all();
}

function getInstalledAppsForDevice(db: SqliteDatabase, deviceId: number) {
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

export function listDevices(db: SqliteDatabase) {
  const devices = db.prepare(`
    SELECT
      d.*,
      d.battery_percent AS battery,
      d.needs_operator_help AS needs_help,
      d.last_heartbeat_at AS last_heartbeat,
      r.name AS room_name,
      h.name AS local_hub_name
    FROM devices d
    LEFT JOIN club_rooms r ON r.id = d.room_id
    LEFT JOIN local_hubs h ON h.id = d.local_hub_id
    ORDER BY d.id
  `).all() as Array<Record<string, unknown>>;

  for (const device of devices) {
    const apps = getInstalledAppsForDevice(db, Number(device.id));
    const activeSession = getActiveSessionForDevice(db, Number(device.id));
    device.installed_apps = JSON.stringify(apps);
    device.session_seconds = getCurrentSessionSeconds(db, Number(device.id));
    device.active_session = activeSession;
    device.remaining_seconds = activeSession?.remaining_seconds ?? 0;
    device.previous_ips = parseJsonArray(String(device.previous_ips ?? "[]"));
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

function getLatestDeviceConnectivity(db: SqliteDatabase, deviceId: number) {
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

function cleanupDuplicateDeviceAliases(db: SqliteDatabase, canonicalDeviceId: number, detail: Pick<DeviceDetail, "serial" | "active_route" | "ip_address">) {
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

function getCurrentSessionSeconds(db: SqliteDatabase, deviceId: number) {
  const row = db.prepare(`
    SELECT MAX(session_seconds) AS session_seconds
    FROM device_telemetry
    WHERE device_id = ?
  `).get(deviceId) as { session_seconds: number | null };
  return row.session_seconds ?? 0;
}

export function listCommands(db: SqliteDatabase) {
  return db.prepare(`SELECT * FROM device_commands ORDER BY created_at DESC, id DESC`).all();
}

export function listSessions(db: SqliteDatabase) {
  return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC, id DESC`).all();
}

export function listAuditLogs(db: SqliteDatabase) {
  return db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 50`).all();
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

export function markOperatorCall(db: SqliteDatabase, pairingId: string) {
  db.prepare(`
    UPDATE devices
    SET needs_operator_help = 1, updated_at = CURRENT_TIMESTAMP
    WHERE pairing_id = ?
  `).run(pairingId);
}

export function updateCommandStatus(
  db: SqliteDatabase,
  commandId: number,
  status: string,
  errorMessage?: string | null,
) {
  const command = db.prepare(`
    SELECT id, status, type, session_id, device_id, payload
    FROM device_commands
    WHERE id = ?
  `).get(commandId) as
    | { id: number; status: string; type: string; session_id: number | null; device_id: number; payload: string }
    | undefined;
  if (!command) {
    throw new Error("Command not found");
  }
  if (!COMMAND_TRANSITIONS[command.status]?.includes(status)) {
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

  const transitionSql = transitions[status];
  if (transitionSql) {
    db.prepare(`
      UPDATE device_commands
      SET status = ?, error_message = ?, ${transitionSql}
      WHERE id = ?
    `).run(status, errorMessage ?? null, commandId);
  } else {
    db.prepare(`
      UPDATE device_commands
      SET status = ?, error_message = ?
      WHERE id = ?
    `).run(status, errorMessage ?? null, commandId);
  }

  applyCommandLifecycleSideEffects(db, command, status, errorMessage ?? null);
}

function applyCommandLifecycleSideEffects(
  db: SqliteDatabase,
  command: { type: string; session_id: number | null; device_id: number; payload: string },
  status: string,
  errorMessage: string | null,
) {
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

  const restoreSessionState = (state: Record<string, unknown> | null | undefined) => {
    if (!state || !command.session_id) {
      return;
    }
    db.prepare(`
      UPDATE session_devices
      SET
        status = ?,
        paused_at = ?,
        total_paused_seconds = ?,
        paused_remaining_seconds = ?,
        current_app_package = ?,
        current_app_name = ?,
        last_app_switch_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND device_id = ?
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
    );
    db.prepare(`
      UPDATE sessions
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(state.session_status) === "paused" ? "paused" : "running", command.session_id);
  };

  if (command.type === "START_SESSION") {
    if (status === "succeeded") {
      const session = db.prepare(`SELECT duration_minutes FROM sessions WHERE id = ?`).get(command.session_id) as
        | { duration_minutes: number }
        | undefined;
      db.prepare(`
        UPDATE session_devices
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            current_app_package = ?,
            current_app_name = COALESCE(?, current_app_name),
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND device_id = ?
      `).run(
        String(payload.package ?? QUEST_AGENT_PACKAGE),
        payload.app_name ? String(payload.app_name) : null,
        command.session_id,
        command.device_id,
      );
      db.prepare(`
        UPDATE sessions
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            ends_at = COALESCE(ends_at, datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes')),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(session?.duration_minutes ?? 0, command.session_id);
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
      SET status = 'failed', end_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND device_id = ?
    `).run(errorMessage ?? status, command.session_id, command.device_id);
    db.prepare(`
      UPDATE devices
      SET status = 'error', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(command.device_id);
    db.prepare(`
      UPDATE sessions
      SET status = 'failed', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(command.session_id);
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

    restoreSessionState(previousSessionState);
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

    restoreSessionState(previousSessionState);
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

  if (command.type === "SWITCH_SESSION_APP") {
    if (status === "succeeded") {
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

    restoreSessionState(previousSessionState);
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
        SET status = 'finished', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND device_id = ?
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
          SET status = 'completed', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(command.session_id);
      }
      return;
    }

    db.prepare(`
      UPDATE session_devices
      SET status = 'failed', end_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND device_id = ?
    `).run(errorMessage ?? status, command.session_id, command.device_id);
    db.prepare(`
      UPDATE devices SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(command.device_id);
    db.prepare(`
      UPDATE sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?
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

export function syncHubState(db: SqliteDatabase, hubId: number, payload: SyncPayload) {
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

  const hub = db.prepare(`
    SELECT h.id, h.club_id, c.organization_id
    FROM local_hubs h
    JOIN clubs c ON c.id = h.club_id
    WHERE h.id = ?
  `).get(hubId) as { id: number; club_id: number; organization_id: number } | undefined;

  if (!hub) {
    throw new Error("Local Hub not found");
  }

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
            WHEN ? = 1 THEN 'in_session'
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

  const pendingCommands = db.prepare(`
    SELECT dc.*, COALESCE(d.stable_id, d.serial_number) AS device_serial_number
    FROM device_commands dc
    JOIN devices d ON d.id = dc.device_id
    WHERE dc.local_hub_id = ? AND dc.status IN ('created', 'sent_to_hub')
    ORDER BY dc.created_at ASC, dc.id ASC
  `).all(hubId) as Array<Record<string, unknown>>;

  if (pendingCommands.length > 0) {
    const ids = pendingCommands.map((command) => Number(command.id));
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(`
      UPDATE device_commands
      SET status = 'accepted_by_hub', accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP)
      WHERE id IN (${placeholders})
    `).run(...ids);
  }

  return pendingCommands;
}

export function seedDemoData(db: SqliteDatabase, options?: { seedMockDevice?: boolean }) {
  const hasOrganizations = db.prepare(`SELECT COUNT(*) AS count FROM organizations`).get() as { count: number };
  if (hasOrganizations.count > 0) {
    return;
  }

  const questAgentChecksum = resolveSeedQuestAgentChecksum();
  const organizationId = createOrganization(db, { name: "BizonVR", slug: "bizonvr" });
  const userId = createUser(db, {
    organizationId,
    email: "operator@bizonvr.local",
    fullName: "Main Operator",
    role: "owner",
  });
  const clubId = createClub(db, {
    organizationId,
    name: "BizonVR Main",
    slug: "bizonvr-main",
    timezone: "Asia/Yekaterinburg",
  });
  const zoneId = createClubZone(db, { clubId, name: "Main Floor", slug: "main-floor", sortOrder: 1 });
  const roomA = createClubRoom(db, { clubId, zoneId, name: "Main Arena", slug: "main-arena", capacity: 6, sortOrder: 1, mapW: 2, mapH: 2 });
  createClubRoom(db, { clubId, zoneId, name: "Private Room A", slug: "private-room-a", capacity: 2, sortOrder: 2 });
  const hubId = createLocalHub(db, { clubId, name: "Hub 1", status: "online" });
  const planId = createSubscriptionPlan(db, {
    code: "start",
    name: "Start",
    maxClubs: 1,
    maxDevices: 12,
    features: { sessions: true, monitoring: true, scrcpy: true, technical_commands: true, apk_upload: true, device_assignment: true },
  });
  createOrganizationSubscription(db, {
    organizationId,
    planId,
    clubLimit: 1,
    deviceLimit: 12,
  });
  const launcherAppId = createApp(db, {
    organizationId,
    name: "BizonVR Club Launcher",
    slug: "bizonvr-club-launcher",
    packageName: QUEST_AGENT_PACKAGE,
    visibility: "organization",
  });
  createAppVersion(db, {
    appId: launcherAppId,
    versionName: "0.1.0",
    versionCode: 1,
    apkChecksum: questAgentChecksum,
  });

  if (options?.seedMockDevice) {
    const deviceId = createDevice(db, {
      clubId,
      roomId: roomA,
      localHubId: hubId,
      name: "Quest 3 - 01",
      serialNumber: "1G0YK01234",
      pairingId: "1234",
      batteryPercent: 90,
    });

    upsertDeviceApp(db, {
      deviceId,
      appId: launcherAppId,
      packageName: QUEST_AGENT_PACKAGE,
      versionName: "0.1.0",
      versionCode: 1,
    });
  }

  writeAuditLog(db, {
    action: "seed.completed",
    entityType: "organization",
    entityId: organizationId,
    organizationId,
    clubId,
    userId,
    details: { seedMockDevice: Boolean(options?.seedMockDevice) },
  });
}
