import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createApp,
  createAppVersion,
  createClub,
  createClubRoom,
  createClubZone,
  createDatabase,
  createDevice,
  createDeviceCommand,
  createLocalHub,
  createOrganization,
  createOrganizationSubscription,
  createSubscriptionPlan,
  createUser,
  createSession,
  assignDeviceToRoom,
  finishActiveSessionForDevice,
  getActiveSessionForDevice,
  getPermissionActor,
  listAuditLogs,
  listCommands,
  listDevices,
  listSessions,
  markOperatorCall,
  pauseSession,
  resumeSession,
  syncHubState,
  switchSessionApp,
  dismissHelpRequest,
  updateCommandStatus,
  upsertDeviceApp,
  verifyAgentCredential,
  listClubs,
  listLocalHubs,
  listRooms,
} from "../src/backend/database";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

function createReadyFixture(options?: {
  role?: "owner" | "admin" | "operator" | "technician" | "viewer";
  features?: Record<string, unknown>;
  deviceLimit?: number | null;
  appVersionCode?: number | null;
  installedVersionCode?: number | null;
}) {
  const db = createDatabase(":memory:");
  const organizationId = createOrganization(db, { name: "Test Org", slug: `test-org-${Math.random()}` });
  const userId = createUser(db, {
    organizationId,
    email: `operator-${Math.random()}@bizonvr.local`,
    fullName: "Operator",
    role: options?.role ?? "operator",
  });
  const planId = createSubscriptionPlan(db, {
    code: `pro-${Math.random()}`,
    name: "Pro",
    maxDevices: 5,
    features: options?.features ?? { sessions: true, scrcpy: true, technical_commands: true, apk_upload: true, device_assignment: true },
  });
  createOrganizationSubscription(db, { organizationId, planId, deviceLimit: options?.deviceLimit ?? 5 });
  const clubId = createClub(db, { organizationId, name: "Downtown Club", slug: `club-${Math.random()}` });
  const roomId = createClubRoom(db, { clubId, name: "Room A", slug: `room-${Math.random()}` });
  const hubId = createLocalHub(db, { clubId, name: "Hub A", status: "online" });
  const appId = createApp(db, {
    organizationId,
    name: "Example Game",
    slug: `example-game-${Math.random()}`,
    packageName: "com.example.game",
    visibility: "organization",
  });
  const appVersionId = createAppVersion(db, {
    appId,
    versionName: "1.0.0",
    versionCode: options?.appVersionCode ?? 1,
    apkChecksum: "game-checksum",
  });
  const deviceId = createDevice(db, {
    clubId,
    roomId,
    localHubId: hubId,
    name: "Quest 3 - 01",
    serialNumber: `TEST-QUEST-${Math.random()}`,
    pairingId: `PAIRING-${Math.random()}`,
    batteryPercent: 82,
  });
  upsertDeviceApp(db, {
    deviceId,
    appId,
    appVersionId,
    packageName: "com.example.game",
    versionName: "1.0.0",
    versionCode: options?.installedVersionCode ?? 1,
  });
  const actor = getPermissionActor(db, userId);
  assert.ok(actor);
  return { db, organizationId, clubId, roomId, hubId, deviceId, userId, actor, appId, appVersionId };
}

describe("BizonVR Backend Logic Tests", () => {
  it("creates organization, club, room, device, command and session", () => {
    const { db, organizationId, clubId, roomId, hubId, deviceId, actor } = createReadyFixture();
    const zoneId = createClubZone(db, {
      clubId,
      name: "Arena Zone",
      slug: "arena-zone",
      sortOrder: 1,
    });

    const commandId = createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "REFRESH_STATUS",
      payload: { reason: "test" },
      actor,
    });
    const sessionId = createSession(db, {
      title: "Birthday Session",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      requireScrcpy: true,
      actor,
    });

    const devices = listDevices(db) as Array<any>;
    const commands = listCommands(db) as Array<any>;
    const sessions = listSessions(db) as Array<any>;

    assert.strictEqual(organizationId > 0, true);
    assert.strictEqual(clubId > 0, true);
    assert.strictEqual(zoneId > 0, true);
    assert.strictEqual(roomId > 0, true);
    assert.strictEqual(deviceId > 0, true);
    assert.strictEqual(commandId > 0, true);
    assert.strictEqual(sessionId > 0, true);
    assert.strictEqual(devices[0].status, "busy");
    assert.strictEqual(commands.some((command) => command.type === "START_SESSION"), true);
    assert.strictEqual(sessions[0].status, "preparing");

    const startCommand = commands.find((command) => command.type === "START_SESSION") as any;
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");

    assert.strictEqual((listDevices(db) as Array<any>)[0].status, "in_session");
    assert.strictEqual((listSessions(db) as Array<any>)[0].status, "running");
  });

  it("transitions command status to accepted_by_hub", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, {
      name: "Command Org",
      slug: "command-org",
    });
    const clubId = createClub(db, {
      organizationId,
      name: "Command Club",
      slug: "command-club",
    });
    const roomId = createClubRoom(db, {
      clubId,
      name: "Command Room",
      slug: "command-room",
    });
    const hubId = createLocalHub(db, {
      clubId,
      name: "Command Hub",
    });
    const deviceId = createDevice(db, {
      clubId,
      roomId,
      localHubId: hubId,
      name: "Quest Command",
      serialNumber: "TEST-QUEST-CMD",
    });

    const commandId = createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "REFRESH_STATUS",
    });

    updateCommandStatus(db, commandId, "accepted_by_hub");

    const command = listCommands(db).find((item: any) => item.id === commandId) as any;
    assert.strictEqual(command.status, "accepted_by_hub");
    assert.ok(command.accepted_at);
  });

  it("marks and dismisses operator help requests by pairing id", () => {
    const { db, deviceId, actor } = createReadyFixture();
    const deviceBefore = (listDevices(db) as Array<any>).find((item) => item.id === deviceId);
    assert.ok(deviceBefore?.pairing_id);
    assert.strictEqual(deviceBefore?.needs_help, 0);

    markOperatorCall(db, String(deviceBefore?.pairing_id));

    const afterCall = (listDevices(db) as Array<any>).find((item) => item.id === deviceId);
    assert.strictEqual(afterCall?.needs_help, 1);

    dismissHelpRequest(db, deviceId, actor);

    const afterDismiss = (listDevices(db) as Array<any>).find((item) => item.id === deviceId);
    assert.strictEqual(afterDismiss?.needs_help, 0);
  });

  it("returns pending commands with stable device serial for Local Hub routing", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, {
      name: "Wireless Org",
      slug: "wireless-org",
    });
    const clubId = createClub(db, {
      organizationId,
      name: "Wireless Club",
      slug: "wireless-club",
    });
    const roomId = createClubRoom(db, {
      clubId,
      name: "Wireless Room",
      slug: "wireless-room",
    });
    const hubId = createLocalHub(db, {
      clubId,
      name: "Wireless Hub",
    });
    const deviceId = createDevice(db, {
      clubId,
      roomId,
      localHubId: hubId,
      name: "Quest WiFi",
      serialNumber: "QUEST-USB-01",
    });

    createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "REFRESH_STATUS",
      payload: { wake_device: true },
    });

    const commands = syncHubState(db, hubId, {
      active_serials: ["QUEST-USB-01"],
      hub_host: "192.168.1.10",
    }) as Array<any>;
    const updatedCommand = listCommands(db)[0] as any;

    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].device_serial_number, "QUEST-USB-01");
    assert.strictEqual(updatedCommand.status, "accepted_by_hub");
  });

  it("exposes Wi-Fi readiness diagnostics from latest telemetry", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, {
      name: "Telemetry Org",
      slug: "telemetry-org",
    });
    const clubId = createClub(db, {
      organizationId,
      name: "Telemetry Club",
      slug: "telemetry-club",
    });
    const roomId = createClubRoom(db, {
      clubId,
      name: "Telemetry Room",
      slug: "telemetry-room",
    });
    const hubId = createLocalHub(db, {
      clubId,
      name: "Telemetry Hub",
    });
    createDevice(db, {
      clubId,
      roomId,
      localHubId: hubId,
      name: "Quest Telemetry",
      serialNumber: "QUEST-TLM-01",
    });

    syncHubState(db, hubId, {
      hub_host: "192.168.1.20",
      device_details: [{
        serial: "QUEST-TLM-01",
        battery: 77,
        wifi_ssid: "ClubNet",
        ip_address: "192.168.1.55",
        adb_status: "offline",
        wifi_ready: false,
        usb_repair_required: true,
        status_reason: "Remembered Wi-Fi route is not reachable. Reconnect over USB to repair wireless debugging.",
        transport: "disconnected",
        wake_supported: false,
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices[0].wifi_ready, false);
    assert.strictEqual(devices[0].usb_repair_required, true);
    assert.match(String(devices[0].status_reason), /Reconnect over USB/);
    assert.strictEqual(devices[0].wifi_ip, "192.168.1.55");
  });

  it("does not create a duplicate Quest when the IP changes for the same stable identity", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, { name: "Identity Org", slug: "identity-org" });
    const clubId = createClub(db, { organizationId, name: "Identity Club", slug: "identity-club" });
    const roomId = createClubRoom(db, { clubId, name: "Identity Room", slug: "identity-room" });
    const hubId = createLocalHub(db, { clubId, name: "Identity Hub" });
    createDevice(db, {
      clubId,
      roomId,
      localHubId: hubId,
      name: "Quest Stable",
      serialNumber: "QUEST-STABLE-01",
      stableId: "QUEST-STABLE-01",
      agentId: "AGENT-001",
      batteryPercent: 88,
    });

    syncHubState(db, hubId, {
      device_details: [{
        serial: "QUEST-STABLE-01",
        stable_id: "QUEST-STABLE-01",
        agent_id: "AGENT-001",
        ip_address: "192.168.0.21",
        previous_ips: ["192.168.0.10"],
        adb_status: "online",
        agent_status: "online",
        connection_status: "online",
      }],
    });

    syncHubState(db, hubId, {
      device_details: [{
        serial: "QUEST-STABLE-01",
        stable_id: "QUEST-STABLE-01",
        agent_id: "AGENT-001",
        ip_address: "192.168.0.55",
        previous_ips: ["192.168.0.21", "192.168.0.10"],
        adb_status: "online",
        agent_status: "online",
        connection_status: "online",
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].wifi_ip, "192.168.0.55");
    assert.ok(Array.isArray(devices[0].previous_ips));
    assert.ok(devices[0].previous_ips.includes("192.168.0.21"));
  });

  it("matches a known Quest by agent_id even if the transport serial differs", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, { name: "Agent Org", slug: "agent-org" });
    const clubId = createClub(db, { organizationId, name: "Agent Club", slug: "agent-club" });
    const roomId = createClubRoom(db, { clubId, name: "Agent Room", slug: "agent-room" });
    const hubId = createLocalHub(db, { clubId, name: "Agent Hub" });
    createDevice(db, {
      clubId,
      roomId,
      localHubId: hubId,
      name: "Quest Agent",
      serialNumber: "QUEST-USB-ORIGINAL",
      stableId: "QUEST-STABLE-AGENT",
      agentId: "AGENT-XYZ",
      batteryPercent: 79,
    });

    syncHubState(db, hubId, {
      device_details: [{
        serial: "192.168.1.77:5555",
        stable_id: "QUEST-STABLE-AGENT",
        agent_id: "AGENT-XYZ",
        ip_address: "192.168.1.77",
        adb_status: "online",
        agent_status: "online",
        connection_status: "online",
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].agent_id, "AGENT-XYZ");
    assert.strictEqual(devices[0].stable_id, "QUEST-STABLE-AGENT");
    assert.strictEqual(devices[0].wifi_ip, "192.168.1.77");
  });

  it("keeps device online when Quest Agent heartbeat is online but ADB is degraded", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, { name: "Degraded Org", slug: "degraded-org" });
    const clubId = createClub(db, { organizationId, name: "Degraded Club", slug: "degraded-club" });
    const hubId = createLocalHub(db, { clubId, name: "Degraded Hub" });

    syncHubState(db, hubId, {
      device_details: [{
        serial: "QUEST-DEGRADED-01",
        stable_id: "QUEST-DEGRADED-01",
        agent_id: "AGENT-DEGRADED",
        ip_address: "192.168.10.44",
        active_route: "192.168.10.44:5555",
        adb_status: "offline",
        agent_status: "online",
        connection_status: "agent_online_adb_offline",
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].status, "online");
    assert.strictEqual(devices[0].device_status, "online");
    assert.strictEqual(devices[0].connection_status, "agent_online_adb_offline");
    assert.strictEqual(devices[0].adb_status, "offline");
    assert.strictEqual(devices[0].agent_status, "online");
    assert.strictEqual(devices[0].active_route, "192.168.10.44:5555");
  });

  it("updates the same Quest from heartbeat when IP changes and does not use IP as identity", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, { name: "Heartbeat Org", slug: "heartbeat-org" });
    const clubId = createClub(db, { organizationId, name: "Heartbeat Club", slug: "heartbeat-club" });
    const hubId = createLocalHub(db, { clubId, name: "Heartbeat Hub" });
    createDevice(db, {
      clubId,
      localHubId: hubId,
      name: "Quest Heartbeat",
      serialNumber: "QUEST-HB-USB",
      stableId: "QUEST-HB-STABLE",
      agentId: "AGENT-HB",
      androidId: "ANDROID-HB",
    });

    syncHubState(db, hubId, {
      agent_heartbeats: [{
        agent_id: "AGENT-HB",
        stable_id: "QUEST-HB-STABLE",
        android_id: "ANDROID-HB",
        local_ip: "192.168.20.10",
        app_version: "1.0",
        in_session: false,
      }],
    });

    syncHubState(db, hubId, {
      agent_heartbeats: [{
        agent_id: "AGENT-HB",
        stable_id: "QUEST-HB-STABLE",
        android_id: "ANDROID-HB",
        local_ip: "192.168.20.77",
        app_version: "1.1",
        in_session: false,
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].last_known_ip, "192.168.20.77");
    assert.strictEqual(devices[0].agent_version, "1.1");
    assert.ok(devices[0].previous_ips.includes("192.168.20.10"));
  });

  it("removes stale alias devices when the same Quest is later identified by stable identity", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, { name: "Alias Org", slug: "alias-org" });
    const clubId = createClub(db, { organizationId, name: "Alias Club", slug: "alias-club" });
    const hubId = createLocalHub(db, { clubId, name: "Alias Hub" });

    createDevice(db, {
      clubId,
      localHubId: hubId,
      name: "Quest Alias",
      serialNumber: "192.168.0.3:5555",
      stableId: "192.168.0.3:5555",
      batteryPercent: 50,
    });

    syncHubState(db, hubId, {
      device_details: [{
        serial: "2G0YC1ZF7S0CFX",
        stable_id: "2G0YC1ZF7S0CFX",
        usb_serial: "2G0YC1ZF7S0CFX",
        agent_id: "AGENT-REAL",
        android_id: "ANDROID-REAL",
        ip_address: "192.168.0.3",
        active_route: "192.168.0.3:5555",
        adb_status: "online",
        agent_status: "online",
        connection_status: "online",
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].stable_id, "2G0YC1ZF7S0CFX");
  });

  it("does not overwrite adb-verified android_id when heartbeat reports a conflicting value", () => {
    const db = createDatabase(":memory:");
    const organizationId = createOrganization(db, { name: "Identity Conflict Org", slug: "identity-conflict-org" });
    const clubId = createClub(db, { organizationId, name: "Identity Conflict Club", slug: "identity-conflict-club" });
    const hubId = createLocalHub(db, { clubId, name: "Identity Conflict Hub" });
    createDevice(db, {
      clubId,
      localHubId: hubId,
      name: "Quest Identity",
      serialNumber: "2G0YC1ZF7S0CFX",
      stableId: "2G0YC1ZF7S0CFX",
      agentId: "AGENT-CONFLICT",
      androidId: "ANDROID-ADB",
    });

    syncHubState(db, hubId, {
      agent_heartbeats: [{
        agent_id: "AGENT-CONFLICT",
        stable_id: "2G0YC1ZF7S0CFX",
        android_id: "ANDROID-HEARTBEAT",
        local_ip: "192.168.0.3",
        app_version: "1.0",
      }],
    });

    const devices = listDevices(db) as Array<any>;
    assert.strictEqual(devices[0].android_id, "ANDROID-ADB");
  });

  it("applies 0002 migration to an existing database created before the new route columns", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-migrate-"));
    const dbPath = path.join(tempDir, "legacy.sqlite");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE clubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER,
        name TEXT,
        slug TEXT
      );
      CREATE TABLE club_rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER,
        name TEXT,
        slug TEXT
      );
      CREATE TABLE local_hubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER,
        name TEXT
      );
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL DEFAULT 1,
        room_id INTEGER,
        local_hub_id INTEGER,
        name TEXT NOT NULL DEFAULT 'Legacy Quest',
        serial_number TEXT NOT NULL UNIQUE,
        stable_id TEXT UNIQUE,
        agent_id TEXT UNIQUE,
        android_id TEXT UNIQUE,
        pairing_id TEXT UNIQUE,
        model TEXT NOT NULL DEFAULT 'Meta Quest',
        status TEXT NOT NULL DEFAULT 'online',
        connection_status TEXT NOT NULL DEFAULT 'online',
        adb_status TEXT NOT NULL DEFAULT 'offline',
        agent_status TEXT NOT NULL DEFAULT 'offline',
        battery_percent INTEGER NOT NULL DEFAULT 100,
        is_charging INTEGER NOT NULL DEFAULT 0,
        wifi_ssid TEXT,
        ip_address TEXT,
        last_known_ip TEXT,
        previous_ips TEXT NOT NULL DEFAULT '[]',
        storage_free_mb INTEGER,
        storage_total_mb INTEGER,
        current_app_package TEXT,
        firmware_version TEXT,
        agent_version TEXT,
        needs_operator_help INTEGER NOT NULL DEFAULT 0,
        maintenance_state TEXT NOT NULL DEFAULT 'ok',
        status_reason TEXT,
        next_operator_step TEXT,
        last_diagnostics_at TEXT,
        identity_last_verified_at TEXT,
        last_heartbeat_at TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacyDb.close();

    const migratedDb = createDatabase(dbPath);
    const columns = migratedDb.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    assert.strictEqual(names.has("active_route"), true);
    assert.strictEqual(names.has("last_adb_seen_at"), true);
    migratedDb.close();
  });

  it("forgets a Quest after Local Hub confirms FORGET_DEVICE", () => {
    const { db, hubId, deviceId, actor } = createReadyFixture({ role: "owner" });

    const commandId = createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "FORGET_DEVICE",
      actor,
      payload: { stable_serial: "TEST" },
    });

    updateCommandStatus(db, commandId, "accepted_by_hub");
    updateCommandStatus(db, commandId, "running");
    updateCommandStatus(db, commandId, "succeeded");

    assert.strictEqual((listDevices(db) as Array<any>).length, 0);
    assert.strictEqual((updateCommandStatus(db, commandId, "succeeded") as any).idempotent, true);
  });

  it("blocks forgetting a Quest while it has an active session", () => {
    const { db, roomId, hubId, deviceId, actor } = createReadyFixture({ role: "owner" });
    createSession(db, {
      title: "Active Session",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });

    assert.throws(() => createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "FORGET_DEVICE",
      actor,
      payload: { stable_serial: "TEST" },
    }), /active session/);
  });

  it("blocks session start when preflight detects a missing app", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();

    assert.throws(() => createSession(db, {
      title: "Missing App",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.missing",
      durationMinutes: 30,
      actor,
    }), /Preflight failed: App com\.example\.missing is not installed/);
  });

  it("blocks session start when installed app version is not compatible with active library version", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture({ appVersionCode: 2, installedVersionCode: 1 });

    assert.throws(() => createSession(db, {
      title: "Wrong Version",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    }), /version is not compatible/);
  });

  it("blocks active session conflicts before creating a second START_SESSION command", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();

    createSession(db, {
      title: "First Session",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });

    assert.throws(() => createSession(db, {
      title: "Second Session",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    }), /already has active session/);
  });

  it("blocks session start when Agent is online but ADB is still offline", () => {
    const { db, roomId, hubId, deviceId, actor } = createReadyFixture();

    syncHubState(db, hubId, {
      hub_host: "192.168.1.30",
      device_details: [{
        serial: (listDevices(db) as Array<any>)[0].serial_number,
        battery: 76,
        wifi_ssid: "ClubNet",
        ip_address: "192.168.1.55",
        adb_status: "offline",
        agent_status: "online",
        connection_status: "agent_online_adb_offline",
        wifi_ready: false,
        usb_repair_required: false,
        status_reason: "Quest Agent heartbeat is arriving, but ADB is offline.",
        transport: "agent_only",
        wake_supported: false,
      }],
    });

    assert.throws(() => createSession(db, {
      title: "Wake From Sleep",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      appActivity: "com.example.game/.MainActivity",
      durationMinutes: 45,
      actor,
    }), /ADB is not available/);
  });

  it("stores reconnecting and recovery diagnostics from Local Hub sync", () => {
    const { db, hubId, deviceId } = createReadyFixture();
    const serial = (listDevices(db) as Array<any>).find((device) => device.id === deviceId)?.serial_number;

    syncHubState(db, hubId, {
      device_details: [{
        serial,
        stable_id: serial,
        ip_address: "192.168.1.55",
        adb_status: "reconnecting",
        agent_status: "online",
        connection_status: "agent_online_adb_offline",
        adb_recovery_status: "permission_missing",
        adb_recovery_permission: "missing",
        status_reason: "Local Hub is retrying last known IPs.",
      }],
    });

    const device = (listDevices(db) as Array<any>).find((item) => item.id === deviceId);
    assert.strictEqual(device.adb_status, "reconnecting");
    assert.strictEqual(device.adb_recovery_status, "permission_missing");
    assert.strictEqual(device.adb_recovery_permission, "missing");
  });

  it("finishes session only after Local Hub confirms END_SESSION", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Finish Later",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");

    finishActiveSessionForDevice(db, deviceId, actor);
    assert.strictEqual((listSessions(db) as Array<any>).find((session) => session.id === sessionId).status, "finishing");
    assert.strictEqual((listDevices(db) as Array<any>)[0].status, "in_session");

    const endCommand = (listCommands(db) as Array<any>).find((command) => command.type === "END_SESSION");
    updateCommandStatus(db, endCommand.id, "accepted_by_hub");
    updateCommandStatus(db, endCommand.id, "running");
    updateCommandStatus(db, endCommand.id, "succeeded");

    assert.strictEqual((listSessions(db) as Array<any>).find((session) => session.id === sessionId).status, "completed");
    assert.strictEqual((listDevices(db) as Array<any>)[0].status, "online");
  });

  it("keeps finish failure visible when Local Hub reports END_SESSION failed", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Finish Failure",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");

    finishActiveSessionForDevice(db, deviceId, actor);
    const endCommand = (listCommands(db) as Array<any>).find((command) => command.type === "END_SESSION");
    updateCommandStatus(db, endCommand.id, "accepted_by_hub");
    updateCommandStatus(db, endCommand.id, "running");
    updateCommandStatus(db, endCommand.id, "failed", "force-stop failed");

    assert.strictEqual((listSessions(db) as Array<any>).find((session) => session.id === sessionId).status, "failed");
    assert.strictEqual((listDevices(db) as Array<any>)[0].status, "error");
  });

  it("does not convert an unknown START_SESSION outcome into a false session failure", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Unknown Start",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "timeout", "Hub restarted after Agent may have launched", { errorCode: "COMMAND_OUTCOME_UNKNOWN", outcomeState: "unknown" });

    assert.equal((listSessions(db) as Array<any>).find((session) => session.id === sessionId).status, "starting");
    assert.equal((listCommands(db) as Array<any>).find((command) => command.id === startCommand.id).operator_state, "result_unknown");
  });

  it("computes remaining time for a running session and restores it after refresh", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Running Timer",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");

    db.prepare(`
      UPDATE session_devices
      SET started_at = datetime(CURRENT_TIMESTAMP, '-17 minutes', '-12 seconds')
      WHERE session_id = ? AND device_id = ?
    `).run(sessionId, deviceId);

    const activeSession = getActiveSessionForDevice(db, deviceId);
    assert.ok(activeSession);
    assert.ok(activeSession.remaining_seconds <= (13 * 60));
    assert.ok(activeSession.remaining_seconds >= (12 * 60 + 40));

    const device = (listDevices(db) as Array<any>).find((item) => item.id === deviceId);
    assert.strictEqual(device.active_session.session_id, sessionId);
    assert.strictEqual(device.active_session.status, "running");
    assert.strictEqual(device.active_session.remaining_seconds, activeSession.remaining_seconds);
  });

  it("pauses and resumes a session without resetting the timer", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Pause Resume",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");
    db.prepare(`
      UPDATE session_devices
      SET started_at = datetime(CURRENT_TIMESTAMP, '-5 minutes', '-10 seconds')
      WHERE session_id = ? AND device_id = ?
    `).run(sessionId, deviceId);

    const paused = pauseSession(db, sessionId, actor);
    assert.ok(paused);
    assert.strictEqual(paused?.status, "paused");
    const pausedRemaining = paused?.remaining_seconds ?? 0;
    assert.ok(pausedRemaining <= (25 * 60));
    assert.ok((listCommands(db) as Array<any>).some((command) => command.type === "PAUSE_SESSION"));

    const resumed = resumeSession(db, sessionId, actor);
    assert.ok(resumed);
    assert.strictEqual(resumed?.status, "running");
    assert.strictEqual(resumed?.remaining_seconds, pausedRemaining);
    assert.ok((listCommands(db) as Array<any>).some((command) => command.type === "RESUME_SESSION"));
  });

  it("switches app inside the same active session without resetting started_at or remaining", () => {
    const { db, organizationId, roomId, deviceId, actor } = createReadyFixture();
    createApp(db, {
      organizationId,
      name: "Second Game",
      slug: `second-game-${Math.random()}`,
      packageName: "com.example.second",
      visibility: "organization",
    });
    upsertDeviceApp(db, {
      deviceId,
      packageName: "com.example.second",
      versionName: "1.0.0",
      versionCode: 1,
    });

    const sessionId = createSession(db, {
      title: "Switch App",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");
    db.prepare(`
      UPDATE session_devices
      SET started_at = datetime(CURRENT_TIMESTAMP, '-8 minutes')
      WHERE session_id = ? AND device_id = ?
    `).run(sessionId, deviceId);

    const beforeSwitch = getActiveSessionForDevice(db, deviceId);
    const switched = switchSessionApp(db, sessionId, {
      appPackage: "com.example.second",
      actor,
    });
    assert.ok(switched);
    assert.strictEqual(switched?.session_id, sessionId);
    assert.strictEqual(switched?.current_app_package, "com.example.second");
    assert.strictEqual(switched?.started_at, beforeSwitch?.started_at);
    assert.strictEqual(switched?.remaining_seconds, beforeSwitch?.remaining_seconds);
    assert.ok((listCommands(db) as Array<any>).some((command) => command.type === "SWITCH_SESSION_APP"));
  });

  it("rejects invalid pause/resume transitions and blocks new start during active session", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Transition Guards",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });
    const startCommand = (listCommands(db) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(db, startCommand.id, "accepted_by_hub");
    updateCommandStatus(db, startCommand.id, "running");
    updateCommandStatus(db, startCommand.id, "succeeded");

    assert.throws(() => resumeSession(db, sessionId, actor), /paused session/);
    pauseSession(db, sessionId, actor);
    assert.throws(() => pauseSession(db, sessionId, actor), /running session/);
    assert.throws(() => createSession(db, {
      title: "Blocked Start",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 15,
      actor,
    }), /already has active session/);
  });

  it("rejects invalid command transitions", () => {
    const { db, hubId, deviceId, actor } = createReadyFixture();
    const commandId = createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "REFRESH_STATUS",
      actor,
    });

    assert.throws(() => updateCommandStatus(db, commandId, "succeeded"), /Invalid command status transition/);
  });

  it("rejects commands for a hub that is not attached to the device", () => {
    const { db, clubId, deviceId, actor } = createReadyFixture();
    const anotherHubId = createLocalHub(db, { clubId, name: "Hub B", status: "online" });

    assert.throws(() => createDeviceCommand(db, {
      deviceId,
      localHubId: anotherHubId,
      type: "REFRESH_STATUS",
      actor,
    }), /Device is not attached to the requested Local Hub/);
  });

  it("rejects session start for viewer role", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture({ role: "viewer" });

    assert.throws(() => createSession(db, {
      title: "Viewer Session",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    }), /Permission denied: start session/);
  });

  it("rejects technical commands for operator role", () => {
    const { db, hubId, deviceId, actor } = createReadyFixture({ role: "operator" });

    assert.throws(() => createDeviceCommand(db, {
      deviceId,
      localHubId: hubId,
      type: "INSTALL_APK",
      actor,
      payload: { package_name: "com.bizonvr.spatialspike" },
    }), /Permission denied: device command/);
  });

  it("blocks protected actions when subscription feature or device limit is unavailable", () => {
    const missingFeature = createReadyFixture({ features: { sessions: false, scrcpy: true, technical_commands: true, apk_upload: true, device_assignment: true } });
    assert.throws(() => createSession(missingFeature.db, {
      title: "No Feature",
      roomId: missingFeature.roomId,
      deviceIds: [missingFeature.deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor: missingFeature.actor,
    }), /Subscription blocked: sessions feature is not enabled/);

    const overLimit = createReadyFixture({ deviceLimit: 0 });
    assert.throws(() => createSession(overLimit.db, {
      title: "Over Limit",
      roomId: overLimit.roomId,
      deviceIds: [overLimit.deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor: overLimit.actor,
    }), /device limit exceeded/);
  });

  it("writes audit logs for protected session creation", () => {
    const { db, roomId, deviceId, actor } = createReadyFixture();
    const sessionId = createSession(db, {
      title: "Audited Session",
      roomId,
      deviceIds: [deviceId],
      appPackage: "com.example.game",
      durationMinutes: 30,
      actor,
    });

    const logs = listAuditLogs(db) as Array<any>;
    assert.ok(logs.some((log) => log.action === "session.created" && log.entity_id === String(sessionId)));
    assert.ok(logs.some((log) => log.action === "device_command.created"));
  });

  it("binds Agent credentials to one Quest and never exposes the stored credential", () => {
    const { db, deviceId, actor } = createReadyFixture();
    const token = "test-agent-credential-only-in-memory";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    db.prepare(`UPDATE devices SET agent_token_hash = ? WHERE id = ?`).run(tokenHash, deviceId);
    const device = (listDevices(db, actor) as Array<any>)[0];
    assert.equal(verifyAgentCredential(db, { pairingId: device.pairing_id, stableId: device.stable_id }, token)?.id, deviceId);
    assert.equal(verifyAgentCredential(db, { pairingId: device.pairing_id, stableId: device.stable_id }, "wrong-token"), null);
    assert.equal(verifyAgentCredential(db, { pairingId: device.pairing_id, stableId: "OTHER-QUEST" }, token), null);
    assert.equal(Object.prototype.hasOwnProperty.call(device, "agent_token_hash"), false);
  });

  it("keeps Agent provisioning credentials out of Cloud command and result storage", () => {
    const rawToken = "test-agent-credential-never-persisted";
    const validHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const createProvisioningCommand = () => {
      const fixture = createReadyFixture({ role: "technician" });
      const commandId = createDeviceCommand(fixture.db, {
        deviceId: fixture.deviceId,
        localHubId: fixture.hubId,
        type: "INSTALL_APK",
        actor: fixture.actor,
        payload: {
          target: "quest_agent",
          artifact_id: "quest-agent-1",
          apk_checksum: "a".repeat(64),
          rotate_agent_credential: true,
          pairing_id: "PAIRING-1",
        },
      });
      const row = fixture.db.prepare(`SELECT payload FROM device_commands WHERE id = ?`).get(commandId) as { payload: string };
      assert.match(row.payload, /rotate_agent_credential/);
      assert.match(row.payload, /artifact_id/);
      assert.doesNotMatch(row.payload, /agent_token/);
      return { ...fixture, commandId };
    };
    const advanceToRunning = (db: any, commandId: number) => {
      updateCommandStatus(db, commandId, "accepted_by_hub");
      updateCommandStatus(db, commandId, "running");
    };

    const successful = createProvisioningCommand();
    advanceToRunning(successful.db, successful.commandId);
    updateCommandStatus(successful.db, successful.commandId, "succeeded", null, { result: { success: true, agent_token_hash: validHash } });
    assert.equal((successful.db.prepare(`SELECT agent_token_hash FROM devices WHERE id = ?`).get(successful.deviceId) as { agent_token_hash: string }).agent_token_hash, validHash);

    const failed = createProvisioningCommand();
    const oldHash = "b".repeat(64);
    failed.db.prepare(`UPDATE devices SET agent_token_hash = ? WHERE id = ?`).run(oldHash, failed.deviceId);
    advanceToRunning(failed.db, failed.commandId);
    updateCommandStatus(failed.db, failed.commandId, "failed", "install failed", { result: { success: false } });
    assert.equal((failed.db.prepare(`SELECT agent_token_hash FROM devices WHERE id = ?`).get(failed.deviceId) as { agent_token_hash: string }).agent_token_hash, oldHash);

    const invalidHash = createProvisioningCommand();
    advanceToRunning(invalidHash.db, invalidHash.commandId);
    assert.throws(() => updateCommandStatus(invalidHash.db, invalidHash.commandId, "succeeded", null, { result: { success: true, agent_token_hash: "not-a-sha256" } }), /valid SHA-256/);
    assert.equal((invalidHash.db.prepare(`SELECT result_json, agent_token_hash FROM device_commands JOIN devices ON devices.id = device_commands.device_id WHERE device_commands.id = ?`).get(invalidHash.commandId) as { result_json: string | null; agent_token_hash: string | null }).result_json, null);

    const arbitrary = createReadyFixture();
    const arbitraryCommandId = createDeviceCommand(arbitrary.db, { deviceId: arbitrary.deviceId, localHubId: arbitrary.hubId, type: "REFRESH_STATUS", actor: arbitrary.actor, payload: { reason: "status" } });
    advanceToRunning(arbitrary.db, arbitraryCommandId);
    updateCommandStatus(arbitrary.db, arbitraryCommandId, "succeeded", null, { result: { success: true, agent_token_hash: validHash } });
    assert.equal((arbitrary.db.prepare(`SELECT agent_token_hash FROM devices WHERE id = ?`).get(arbitrary.deviceId) as { agent_token_hash: string | null }).agent_token_hash, null);

    const rawResult = createProvisioningCommand();
    advanceToRunning(rawResult.db, rawResult.commandId);
    assert.throws(() => updateCommandStatus(rawResult.db, rawResult.commandId, "failed", "rejected", { result: { success: false, agent_token: rawToken } }), /Raw credential field/);
    const persisted = JSON.stringify(rawResult.db.prepare(`SELECT payload, result_json FROM device_commands`).all()) + JSON.stringify(rawResult.db.prepare(`SELECT details FROM audit_logs`).all());
    assert.doesNotMatch(persisted, new RegExp(rawToken));
  });

  it("filters every operator collection by authenticated organization and club scope", () => {
    const { db, actor } = createReadyFixture();
    const otherOrganizationId = createOrganization(db, { name: "Other Org", slug: `other-${Math.random()}` });
    const otherClubId = createClub(db, { organizationId: otherOrganizationId, name: "Other Club", slug: `other-club-${Math.random()}` });
    const otherRoomId = createClubRoom(db, { clubId: otherClubId, name: "Other Room", slug: `other-room-${Math.random()}` });
    const otherHubId = createLocalHub(db, { clubId: otherClubId, name: "Other Hub" });
    const otherDeviceId = createDevice(db, { clubId: otherClubId, roomId: otherRoomId, localHubId: otherHubId, name: "Other Quest", serialNumber: `OTHER-${Math.random()}` });
    createDeviceCommand(db, { deviceId: otherDeviceId, localHubId: otherHubId, type: "REFRESH_STATUS" });
    assert.equal((listClubs(db, actor) as Array<any>).some((row) => row.id === otherClubId), false);
    assert.equal((listRooms(db, actor) as Array<any>).some((row) => row.id === otherRoomId), false);
    assert.equal((listLocalHubs(db, actor) as Array<any>).some((row) => row.id === otherHubId), false);
    assert.equal((listDevices(db, actor) as Array<any>).some((row) => row.id === otherDeviceId), false);
    assert.equal((listCommands(db, actor) as Array<any>).some((row) => row.device_id === otherDeviceId), false);
    assert.equal((listAuditLogs(db, actor) as Array<any>).some((row) => row.club_id === otherClubId), false);
    assert.throws(() => createDeviceCommand(db, { deviceId: otherDeviceId, localHubId: otherHubId, type: "REFRESH_STATUS", actor }), /organization scope mismatch/);
    assert.throws(() => assignDeviceToRoom(db, otherDeviceId, otherRoomId, actor), /organization scope mismatch/);
  });

  it("does not refresh Agent state from an old heartbeat", () => {
    const { db, hubId, deviceId } = createReadyFixture();
    const device = (listDevices(db) as Array<any>).find((row) => row.id === deviceId) as any;
    db.prepare(`UPDATE devices SET agent_status = 'offline', last_heartbeat_at = NULL WHERE id = ?`).run(deviceId);
    syncHubState(db, hubId, {
      agent_heartbeats: [{
        stable_id: device.stable_id,
        pairing_id: device.pairing_id,
        timestamp: Date.now() - 120_000,
        in_session: false,
      }],
    });
    const after = (listDevices(db) as Array<any>).find((row) => row.id === deviceId) as any;
    assert.equal(after.agent_status, "offline");
    assert.equal(after.last_heartbeat_at, null);
  });
});
