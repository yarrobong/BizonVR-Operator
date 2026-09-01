import fs from "fs";
import path from "path";
import { redactLegacyRawCredentialFields, parseJsonObject } from "./json";
import type { SqliteDatabase } from "./types";
import { commandPayloadHash, getCommandPolicy } from "./command-policy";

function readMigration(relativePath: string, migrationsDir = path.join(process.cwd(), "db", "migrations")) {
  return fs.readFileSync(path.join(migrationsDir, relativePath), "utf8");
}

function listMigrationFiles(migrationsDir = path.join(process.cwd(), "db", "migrations")) {
  return fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
}

function scrubLegacyAgentCredentials(db: SqliteDatabase) {
  const scrubJsonColumn = (table: "device_commands" | "audit_logs" | "session_events", column: "payload" | "result_json" | "details") => {
    const tableExists = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
    if (!tableExists) return;
    const rows = db.prepare(`SELECT rowid AS row_id, ${column} FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ row_id: number; [key: string]: unknown }>;
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
    for (const row of rows) {
      const original = String(row[column]);
      const redacted = JSON.stringify(redactLegacyRawCredentialFields(parseJsonObject(original)));
      if (redacted !== original) update.run(redacted, row.row_id);
    }
  };
  scrubJsonColumn("device_commands", "payload");
  scrubJsonColumn("device_commands", "result_json");
  scrubJsonColumn("audit_logs", "details");
  scrubJsonColumn("session_events", "payload");
}

function ensureSchemaCompatibility(db: SqliteDatabase, migrationFile?: string) {
  const columns = db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if ((!migrationFile || migrationFile === "0002_device_route_columns.sql") && !columnNames.has("active_route")) db.exec(`ALTER TABLE devices ADD COLUMN active_route TEXT`);
  if ((!migrationFile || migrationFile === "0002_device_route_columns.sql") && !columnNames.has("last_adb_seen_at")) db.exec(`ALTER TABLE devices ADD COLUMN last_adb_seen_at TEXT`);
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

export function applyMigrations(db: SqliteDatabase, migrationsDir = path.join(process.cwd(), "db", "migrations")) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const existingTables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`).all() as Array<{ name: string }>;
  const appliedVersions = new Set((db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: string }>).map((row) => row.version));
  if (existingTables.length > 0 && !appliedVersions.has("0001_initial.sql")) {
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)`).run("0001_initial.sql");
    appliedVersions.add("0001_initial.sql");
  }

  for (const migrationFile of listMigrationFiles(migrationsDir)) {
    if (appliedVersions.has(migrationFile)) continue;
    const applyMigration = db.transaction(() => {
      const routeColumns = new Set((db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>).map((column) => column.name));
      const alreadyCompatible = migrationFile === "0002_device_route_columns.sql" && routeColumns.has("active_route") && routeColumns.has("last_adb_seen_at");
      const hasTable = (table: string) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
      const isPartialLegacySnapshot =
        (migrationFile === "0004_session_lifecycle.sql" && !hasTable("session_devices"))
        || (migrationFile === "0005_device_command_reliability.sql" && !hasTable("device_commands"))
        || (migrationFile === "0006_session_reliability.sql" && (!hasTable("sessions") || !hasTable("session_devices")));
      if (!alreadyCompatible && !isPartialLegacySnapshot) db.exec(readMigration(migrationFile, migrationsDir));
      if (migrationFile === "0008_scrub_agent_credentials.sql") scrubLegacyAgentCredentials(db);
      ensureSchemaCompatibility(db, migrationFile);
      db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(migrationFile);
    });
    applyMigration();
  }

  const reliabilityColumns = new Set((db.prepare(`PRAGMA table_info(device_commands)`).all() as Array<{ name: string }>).map((column) => column.name));
  if (reliabilityColumns.has("payload_sha256")) {
    const commands = db.prepare(`SELECT id, type, payload FROM device_commands WHERE payload_sha256 = '' OR payload_sha256 IS NULL`).all() as Array<{ id: number; type: string; payload: string }>;
    const updateHash = db.prepare(`UPDATE device_commands SET payload_sha256 = ?, max_attempts = ? WHERE id = ?`);
    db.transaction(() => {
      for (const command of commands) updateHash.run(commandPayloadHash(command.payload), getCommandPolicy(command.type).maxAttempts, command.id);
    })();
    db.exec(`UPDATE device_commands SET target_stable_id = COALESCE(target_stable_id, (SELECT stable_id FROM devices WHERE devices.id = device_commands.device_id)), target_android_id = COALESCE(target_android_id, (SELECT android_id FROM devices WHERE devices.id = device_commands.device_id)), target_agent_id = COALESCE(target_agent_id, (SELECT agent_id FROM devices WHERE devices.id = device_commands.device_id)) WHERE target_stable_id IS NULL OR target_android_id IS NULL OR target_agent_id IS NULL`);
  }
}
