import type { SqliteDatabase, PermissionActor, CreateClubInput, CreateZoneInput, CreateRoomInput } from "../db/types";
import { writeAuditLog } from "./audit";
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


export function listRooms(db: SqliteDatabase, actor?: PermissionActor | null) {
  const scope = actor ? `WHERE c.organization_id = ? AND r.club_id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"})` : "";
  return db.prepare(`
    SELECT
      r.*,
      z.name AS zone_name,
      c.name AS club_name
    FROM club_rooms r
    LEFT JOIN club_zones z ON z.id = r.zone_id
    JOIN clubs c ON c.id = r.club_id
    ${scope}
    ORDER BY c.id, r.sort_order, r.id
  `).all(...(actor ? [actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1])] : []));
}

export function listClubs(db: SqliteDatabase, actor?: PermissionActor | null) {
  if (!actor) return db.prepare(`SELECT * FROM clubs ORDER BY id`).all();
  return db.prepare(`SELECT * FROM clubs WHERE organization_id = ? AND id IN (${actor.clubIds?.map(() => "?").join(",") || "-1"}) ORDER BY id`)
    .all(actor.organizationId, ...(actor.clubIds?.length ? actor.clubIds : [-1]));
}
