import type { SqliteDatabase, CreateOrganizationInput } from "../db/types";
import { writeAuditLog } from "./audit";
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
