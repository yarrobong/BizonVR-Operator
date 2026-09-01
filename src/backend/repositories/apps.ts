import type { SqliteDatabase, CreateAppInput, CreateAppVersionInput, UpsertDeviceAppInput } from "../db/types";
import { writeAuditLog } from "./audit";
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
