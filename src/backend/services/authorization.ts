import type { PermissionActor, SqliteDatabase, SubscriptionState } from "../db/types";
import { parseJsonObject } from "../db/json";

export type { PermissionActor } from "../db/types";

export function getPermissionActor(db: SqliteDatabase, userId: number): PermissionActor | null {
  const user = db.prepare(`SELECT u.id, u.organization_id, u.role, u.status FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ? AND o.status = 'active'`).get(userId) as
    | { id: number; organization_id: number; role: PermissionActor["role"]; status: string } | undefined;
  if (!user || user.status !== "active") return null;
  const clubs = db.prepare(`SELECT id FROM clubs WHERE organization_id = ? AND status != 'archived'`).all(user.organization_id) as Array<{ id: number }>;
  return { userId: user.id, organizationId: user.organization_id, role: user.role, clubIds: clubs.map((club) => club.id) };
}
export function getDefaultPermissionActor(db: SqliteDatabase): PermissionActor | null {
  const user = db.prepare(`SELECT id FROM users WHERE status = 'active' ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
  return user ? getPermissionActor(db, user.id) : null;
}

export function getSubscriptionState(db: SqliteDatabase, organizationId: number): SubscriptionState | null {
  const row = db.prepare(`SELECT os.status, COALESCE(os.device_limit, sp.max_devices) AS device_limit, sp.features_json, os.features_override_json FROM organization_subscriptions os JOIN subscription_plans sp ON sp.id = os.plan_id WHERE os.organization_id = ? ORDER BY os.created_at DESC, os.id DESC LIMIT 1`).get(organizationId) as
    | { status: string; device_limit: number | null; features_json: string; features_override_json: string } | undefined;
  if (!row) return null;
  return { status: row.status, deviceLimit: row.device_limit, features: { ...parseJsonObject(row.features_json), ...parseJsonObject(row.features_override_json) } };
}

export function assertActorCanAccessClub(actor: PermissionActor | null | undefined, organizationId: number, clubId: number) {
  if (!actor) return;
  if (actor.organizationId !== organizationId) throw new Error("Permission denied: organization scope mismatch");
  if (actor.clubIds && !actor.clubIds.includes(clubId)) throw new Error("Permission denied: club scope mismatch");
}

export function assertRole(actor: PermissionActor | null | undefined, allowedRoles: PermissionActor["role"][], action: string) {
  if (!actor) return;
  if (!allowedRoles.includes(actor.role)) throw new Error(`Permission denied: ${action} requires ${allowedRoles.join(" or ")}`);
}

export function assertSubscriptionFeature(db: SqliteDatabase, organizationId: number, feature: string) {
  const subscription = getSubscriptionState(db, organizationId);
  if (!subscription || !["trialing", "active"].includes(subscription.status)) throw new Error("Subscription blocked: active subscription is required");
  if (subscription.features[feature] !== true) throw new Error(`Subscription blocked: ${feature} feature is not enabled`);
}

export function assertDeviceLimit(db: SqliteDatabase, organizationId: number) {
  const subscription = getSubscriptionState(db, organizationId);
  if (subscription?.deviceLimit === null || subscription?.deviceLimit === undefined) return;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM devices d JOIN clubs c ON c.id = d.club_id WHERE c.organization_id = ? AND d.status != 'disabled'`).get(organizationId) as { count: number };
  if (row.count > subscription.deviceLimit) throw new Error(`Subscription blocked: device limit exceeded (${row.count}/${subscription.deviceLimit})`);
}
