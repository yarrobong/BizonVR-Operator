import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { SqliteDatabase } from "../db/types";
import { writeAuditLog } from "../repositories/audit";
import { createOrganization, createUser, createOrganizationSubscription, createSubscriptionPlan } from "../repositories/organizations";
import { createClub, createClubRoom, createClubZone } from "../repositories/clubs";
import { createLocalHub } from "../repositories/hubs";
import { createApp, createAppVersion, upsertDeviceApp } from "../repositories/apps";
import { createDevice } from "../repositories/devices";

const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || "com.bizonvr.spatialspike";

function resolveSeedQuestAgentChecksum() {
  const apkPath = process.env.QUEST_AGENT_APK_PATH
    ? path.resolve(process.env.QUEST_AGENT_APK_PATH)
    : path.join(process.cwd(), "quest-agent-spatial-spike", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex");
  } catch {
    return "dev-launcher-checksum";
  }
}

export function seedDemoData(db: SqliteDatabase, options?: { seedMockDevice?: boolean }) {
  const hasOrganizations = db.prepare(`SELECT COUNT(*) AS count FROM organizations`).get() as { count: number };
  if (hasOrganizations.count > 0) return;
  const questAgentChecksum = resolveSeedQuestAgentChecksum();
  const organizationId = createOrganization(db, { name: "BizonVR", slug: "bizonvr" });
  const userId = createUser(db, { organizationId, email: "operator@bizonvr.local", fullName: "Main Operator", role: "owner" });
  const clubId = createClub(db, { organizationId, name: "BizonVR Main", slug: "bizonvr-main", timezone: "Asia/Yekaterinburg" });
  const zoneId = createClubZone(db, { clubId, name: "Main Floor", slug: "main-floor", sortOrder: 1 });
  const roomA = createClubRoom(db, { clubId, zoneId, name: "Main Arena", slug: "main-arena", capacity: 6, sortOrder: 1, mapW: 2, mapH: 2 });
  createClubRoom(db, { clubId, zoneId, name: "Private Room A", slug: "private-room-a", capacity: 2, sortOrder: 2 });
  const hubId = createLocalHub(db, { clubId, name: "Hub 1", status: "online" });
  const planId = createSubscriptionPlan(db, { code: "start", name: "Start", maxClubs: 1, maxDevices: 12, features: { sessions: true, monitoring: true, scrcpy: true, technical_commands: true, apk_upload: true, device_assignment: true } });
  createOrganizationSubscription(db, { organizationId, planId, clubLimit: 1, deviceLimit: 12, status: "active" });
  const launcherAppId = createApp(db, { organizationId, name: "BizonVR Club Launcher", slug: "bizonvr-club-launcher", packageName: QUEST_AGENT_PACKAGE, visibility: "organization" });
  createAppVersion(db, { appId: launcherAppId, versionName: "0.1.0", versionCode: 1, apkChecksum: questAgentChecksum });
  if (options?.seedMockDevice) {
    const deviceId = createDevice(db, { clubId, roomId: roomA, localHubId: hubId, name: "Quest 3 - 01", serialNumber: "1G0YK01234", pairingId: "1234", batteryPercent: 90 });
    upsertDeviceApp(db, { deviceId, appId: launcherAppId, packageName: QUEST_AGENT_PACKAGE, versionName: "0.1.0", versionCode: 1 });
  }
  writeAuditLog(db, { action: "seed.completed", entityType: "organization", entityId: organizationId, organizationId, clubId, userId, details: { seedMockDevice: Boolean(options?.seedMockDevice) } });
}
