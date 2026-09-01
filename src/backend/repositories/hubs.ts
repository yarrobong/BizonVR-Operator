import type { SqliteDatabase, PermissionActor, CreateHubInput } from "../db/types";
import { writeAuditLog } from "./audit";
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


export function listLocalHubs(db: SqliteDatabase, actor?: PermissionActor | null) {
  if (!actor) return db.prepare(`SELECT * FROM local_hubs ORDER BY id`).all();
  return db.prepare(`SELECT h.* FROM local_hubs h JOIN clubs c ON c.id = h.club_id WHERE c.organization_id = ? AND h.club_id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"}) ORDER BY h.id`)
    .all(actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1]));
}

export function markOperatorCall(db: SqliteDatabase, pairingId: string, localHubId?: number) {
  return db.prepare(`
    UPDATE devices
    SET needs_operator_help = 1, updated_at = CURRENT_TIMESTAMP
    WHERE pairing_id = ? ${localHubId ? "AND local_hub_id = ?" : ""}
  `).run(...(localHubId ? [pairingId, localHubId] : [pairingId]));
}
