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

type CommandStatusOptions = {
  errorCode?: string | null;
  result?: Record<string, unknown> | null;
  outcomeState?: "pending" | "known" | "unknown" | "reconciled";
  hubId?: number | null;
  hubInstanceId?: string | null;
  claimToken?: string | null;
  route?: string | null;
  reconciled?: boolean;
  resultDeliveryAttempt?: number | null;
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

type SessionActionInput = {
  idempotencyKey?: string | null;
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
const TERMINAL_SESSION_STATUSES = ["completed", "cancelled", "failed"];
const SESSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["preparing", "cancelled"],
  preparing: ["ready", "starting", "finishing", "cancelled", "failed"],
  ready: ["starting", "finishing", "cancelled", "failed"],
  starting: ["running", "finishing", "cancelled", "failed"],
  running: ["paused", "extended", "finishing", "failed"],
  paused: ["running", "extended", "finishing", "failed"],
  extended: ["running", "paused", "finishing", "failed"],
  finishing: ["completed", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};
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
  "EXTEND_SESSION",
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
  hub_instance_id?: string;
  agent_heartbeats?: Array<{
    agent_id?: string;
    pairing_id?: string;
    stable_id?: string;
    android_id?: string;
    model?: string;
    session_seconds?: number;
    remaining_seconds?: number;
    session_id?: number | null;
    session_revision?: number;
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
    timestamp?: number;
  }>;
};

type DeviceIdentity = {
  serialNumber?: string | null;
  stableId?: string | null;
  agentId?: string | null;
  androidId?: string | null;
};

const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || "com.bizonvr.spatialspike";

const COMMAND_TYPES = new Set([
  "PING", "REFRESH_STATUS", "INSTALL_APP", "INSTALL_APK", "UNINSTALL_APP", "LAUNCH_APP", "STOP_APP",
  "REBOOT_DEVICE", "OPEN_SCRCPY", "CLOSE_SCRCPY", "SHOW_MESSAGE", "START_SESSION", "PAUSE_SESSION",
  "RESUME_SESSION", "EXTEND_SESSION", "SWITCH_SESSION_APP", "END_SESSION", "OPEN_LAUNCHER", "RUN_DIAGNOSTICS", "FORGET_DEVICE",
]);

const COMMAND_POLICIES: Record<string, { maxAttempts: number; retryable: boolean; reconciliable: boolean; dangerous: boolean }> = {
  PING: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  REFRESH_STATUS: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  RUN_DIAGNOSTICS: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  OPEN_LAUNCHER: { maxAttempts: 2, retryable: true, reconciliable: true, dangerous: false },
  LAUNCH_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: false },
  STOP_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: false },
  OPEN_SCRCPY: { maxAttempts: 2, retryable: true, reconciliable: true, dangerous: false },
  CLOSE_SCRCPY: { maxAttempts: 2, retryable: true, reconciliable: true, dangerous: false },
  RECONNECT_ADB: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  INSTALL_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  INSTALL_APK: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  UNINSTALL_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  START_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  PAUSE_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  RESUME_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  EXTEND_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  SWITCH_SESSION_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  END_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  FORGET_DEVICE: { maxAttempts: 1, retryable: false, reconciliable: false, dangerous: true },
  REBOOT_DEVICE: { maxAttempts: 1, retryable: false, reconciliable: false, dangerous: true },
};

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function canonicalCommandPayload(payload: Record<string, unknown> | string | null | undefined) {
  let parsed: unknown = payload ?? {};
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed || "{}"); } catch { parsed = {}; }
  }
  return JSON.stringify(canonicalizeJson(parsed || {}));
}

export function commandPayloadHash(payload: Record<string, unknown> | string | null | undefined) {
  return crypto.createHash("sha256").update(canonicalCommandPayload(payload)).digest("hex");
}

export function getCommandPolicy(type: string) {
  return COMMAND_POLICIES[type] ?? { maxAttempts: 1, retryable: false, reconciliable: false, dangerous: true };
}

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
  // Older test/dev databases may contain only the device inventory tables and
  // no command table at all.  They are valid partial legacy databases; the
  // normal migration will add command reliability fields once commands exist.
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
      if (!["0002_device_route_columns.sql", "0004_session_lifecycle.sql", "0005_device_command_reliability.sql", "0006_session_reliability.sql"].includes(migrationFile)) {
        throw error;
      }
      ensureSchemaCompatibility(db, migrationFile);
    }

    ensureSchemaCompatibility(db, migrationFile);
    db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(migrationFile);
  }

  // 0005 adds the durable command fields. Backfill hashes in application code
  // so the canonical JSON representation is identical in Cloud and Local Hub.
  const reliabilityColumns = new Set((db.prepare(`PRAGMA table_info(device_commands)`).all() as Array<{ name: string }>).map((column) => column.name));
  if (reliabilityColumns.has("payload_sha256")) {
    const commands = db.prepare(`SELECT id, type, payload FROM device_commands WHERE payload_sha256 = '' OR payload_sha256 IS NULL`).all() as Array<{ id: number; type: string; payload: string }>;
    const updateHash = db.prepare(`UPDATE device_commands SET payload_sha256 = ?, max_attempts = ? WHERE id = ?`);
    const backfill = db.transaction(() => {
      for (const command of commands) updateHash.run(commandPayloadHash(command.payload), getCommandPolicy(command.type).maxAttempts, command.id);
    });
    backfill();
    db.exec(`
      UPDATE device_commands
      SET target_stable_id = COALESCE(target_stable_id, (SELECT stable_id FROM devices WHERE devices.id = device_commands.device_id)),
          target_android_id = COALESCE(target_android_id, (SELECT android_id FROM devices WHERE devices.id = device_commands.device_id)),
          target_agent_id = COALESCE(target_agent_id, (SELECT agent_id FROM devices WHERE devices.id = device_commands.device_id))
      WHERE target_stable_id IS NULL OR target_android_id IS NULL OR target_agent_id IS NULL
    `);
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
    revision: summary.revision ?? 0,
    operation_state: summary.operation_state ?? "idle",
  };
}

function transitionSessionStatus(db: SqliteDatabase, sessionId: number, nextStatus: string, expectedStatuses?: string[]) {
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

function refreshSessionAggregate(db: SqliteDatabase, sessionId: number) {
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

function appendSessionActionRequest(db: SqliteDatabase, input: {
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

function findExistingSessionAction(db: SqliteDatabase, sessionId: number, deviceId: number, action: string, idempotencyKey?: string | null) {
  if (!idempotencyKey) return undefined;
  return db.prepare(`
    SELECT command_id, revision FROM session_action_requests
    WHERE session_id = ? AND device_id = ? AND action = ? AND idempotency_key = ?
    LIMIT 1
  `).get(sessionId, deviceId, action, idempotencyKey) as { command_id: number | null; revision: number } | undefined;
}

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
  const rows = db.prepare(`SELECT * FROM device_commands ORDER BY created_at DESC, id DESC`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
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

export function listSessions(db: SqliteDatabase) {
  return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC, id DESC`).all();
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
  options: CommandStatusOptions = {},
) {
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

function reconcileSessionFromHeartbeat(db: SqliteDatabase, deviceId: number, heartbeat: NonNullable<SyncPayload["agent_heartbeats"]>[number]) {
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
    const changed = db.prepare(`
      UPDATE session_devices
      SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), operation_state = 'idle',
          current_app_package = COALESCE(?, current_app_package), current_app_name = COALESCE(?, current_app_name), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('preparing', 'ready', 'running', 'paused')
        AND operation_state != 'finish_pending'
    `).run(heartbeat.current_app_package ?? null, heartbeat.current_app_name ?? null, active.session_device_id);
    if (changed.changes === 1 && ["starting", "preparing", "ready"].includes(active.session_status)) {
      db.prepare(`UPDATE sessions SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), ends_at = COALESCE(ends_at, datetime(CURRENT_TIMESTAMP, '+' || (SELECT duration_minutes + extension_minutes FROM sessions WHERE id = ?) || ' minutes')), recovery_state = 'none', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('starting', 'preparing', 'ready')`).run(active.session_id, active.session_id);
      appendSessionEvent(db, { sessionId: active.session_id, deviceId, type: "session_reconciled_running", message: `Heartbeat reconciled session ${active.session_id} as running`, payload: { revision: heartbeatRevision, current_app_package: heartbeat.current_app_package ?? null } });
    }
  } else if (heartbeat.session_status === "paused" && heartbeat.in_session && packageMatches && ["running", "extended", "paused"].includes(active.session_status)) {
    const changed = db.prepare(`
      UPDATE session_devices
      SET status = 'paused', paused_at = COALESCE(paused_at, CURRENT_TIMESTAMP), paused_remaining_seconds = ?, operation_state = 'idle', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND operation_state != 'finish_pending'
    `).run(Math.max(0, Number(heartbeat.remaining_seconds ?? 0)), active.session_device_id);
    if (changed.changes === 1 && active.session_status !== "paused") {
      db.prepare(`UPDATE sessions SET status = 'paused', recovery_state = 'none', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('running', 'extended')`).run(active.session_id);
      appendSessionEvent(db, { sessionId: active.session_id, deviceId, type: "session_reconciled_paused", message: `Heartbeat reconciled session ${active.session_id} as paused`, payload: { remaining_seconds: heartbeat.remaining_seconds ?? null } });
    }
  }
  return heartbeat.in_session === true && active.session_status !== "finishing" && packageMatches;
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
