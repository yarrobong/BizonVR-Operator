import type { SqliteDatabase } from "../db/types";
import { redactSecrets } from "../db/json";

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
  db.prepare(`INSERT INTO audit_logs (organization_id, club_id, user_id, local_hub_id, device_id, session_id, command_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    params.organizationId ?? null, params.clubId ?? null, params.userId ?? null, params.localHubId ?? null,
    params.deviceId ?? null, params.sessionId ?? null, params.commandId ?? null, params.action, params.entityType,
    String(params.entityId), JSON.stringify(redactSecrets(params.details ?? {})),
  );
}
export function listAuditLogs(db: SqliteDatabase, actor?: { organizationId: number; clubIds?: number[] } | null) {
  if (!actor) return db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 50`).all();
  return db.prepare(`SELECT * FROM audit_logs WHERE organization_id = ? AND (club_id IS NULL OR club_id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"})) ORDER BY created_at DESC, id DESC LIMIT 50`)
    .all(actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1]));
}
