import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createApp,
  createAppVersion,
  createClub,
  createClubRoom,
  createDatabase,
  createDevice,
  createSession,
  createLocalHub,
  createOrganization,
  createOrganizationSubscription,
  createSubscriptionPlan,
  createUser,
  extendSession,
  finishActiveSessionForDevice,
  getActiveSessionForDevice,
  getPermissionActor,
  listCommands,
  listDevices,
  listSessions,
  reconcileExpiredSessions,
  syncHubState,
  updateCommandStatus,
  upsertDeviceApp,
} from "../src/backend/database";

function fixture(deviceCount = 1) {
  const db = createDatabase(":memory:");
  const organizationId = createOrganization(db, { name: "Reliability Org", slug: `reliability-${Math.random()}` });
  const userId = createUser(db, {
    organizationId,
    email: `reliability-${Math.random()}@bizonvr.local`,
    fullName: "Reliability Operator",
    role: "operator",
  });
  const planId = createSubscriptionPlan(db, {
    code: `reliability-${Math.random()}`,
    name: "Reliability",
    maxDevices: 20,
    features: { sessions: true, scrcpy: true, technical_commands: true, apk_upload: true, device_assignment: true },
  });
  createOrganizationSubscription(db, { organizationId, planId, deviceLimit: 20 });
  const clubId = createClub(db, { organizationId, name: "Reliability Club", slug: `club-${Math.random()}` });
  const roomId = createClubRoom(db, { clubId, name: "Room", slug: `room-${Math.random()}` });
  const hubId = createLocalHub(db, { clubId, name: "Hub", status: "online" });
  const appId = createApp(db, { organizationId, name: "Game", slug: `game-${Math.random()}`, packageName: "com.example.game", visibility: "organization" });
  const versionId = createAppVersion(db, { appId, versionName: "1.0.0", versionCode: 1, apkChecksum: "game" });
  const deviceIds: number[] = [];
  for (let index = 0; index < deviceCount; index += 1) {
    const deviceId = createDevice(db, {
      clubId,
      roomId,
      localHubId: hubId,
      name: `Quest ${index + 1}`,
      serialNumber: `RELIABILITY-${Math.random()}-${index}`,
      stableId: `STABLE-${Math.random()}-${index}`,
      agentId: `AGENT-${Math.random()}-${index}`,
      batteryPercent: 80,
    });
    upsertDeviceApp(db, { deviceId, appId, appVersionId: versionId, packageName: "com.example.game", versionName: "1.0.0", versionCode: 1 });
    deviceIds.push(deviceId);
  }
  const actor = getPermissionActor(db, userId);
  assert.ok(actor);
  return { db, roomId, hubId, deviceIds, actor };
}

function startCommand(db: ReturnType<typeof createDatabase>, sessionId: number) {
  const command = (listCommands(db) as Array<any>).find((item) => item.session_id === sessionId && item.type === "START_SESSION");
  assert.ok(command);
  updateCommandStatus(db, command.id, "accepted_by_hub");
  updateCommandStatus(db, command.id, "running");
  return command;
}

function succeed(db: ReturnType<typeof createDatabase>, commandId: number) {
  const command = (listCommands(db) as Array<any>).find((item) => item.id === commandId);
  if (command?.status === "created") updateCommandStatus(db, commandId, "accepted_by_hub");
  if (command?.status === "created" || command?.status === "accepted_by_hub") updateCommandStatus(db, commandId, "running");
  updateCommandStatus(db, commandId, "succeeded", null, { result: { success: true } });
}

describe("Session Engine reliability", () => {
  it("enforces one active session per Quest even after repeated starts", () => {
    const { db, roomId, deviceIds, actor } = fixture();
    createSession(db, { title: "First", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    for (let index = 0; index < 20; index += 1) {
      assert.throws(() => createSession(db, { title: `Duplicate ${index}`, roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor }), /active session/);
    }
    assert.equal((listSessions(db) as Array<any>).length, 1);
    assert.equal((listCommands(db) as Array<any>).filter((command) => command.type === "START_SESSION").length, 1);
  });

  it("reconciles a launched app when the START result was lost", () => {
    const { db, roomId, hubId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Lost result", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const command = startCommand(db, sessionId);
    updateCommandStatus(db, command.id, "timeout", "hub restart", { errorCode: "COMMAND_OUTCOME_UNKNOWN", outcomeState: "unknown" });
    assert.equal((listSessions(db) as Array<any>)[0].status, "starting");
    syncHubState(db, hubId, { agent_heartbeats: [{ stable_id: (listDevices(db) as Array<any>)[0].stable_id, agent_id: (listDevices(db) as Array<any>)[0].agent_id, android_id: (listDevices(db) as Array<any>)[0].android_id, session_id: sessionId, session_revision: 1, in_session: true, session_status: "running", current_app_package: "com.example.game", remaining_seconds: 1700, timestamp: Date.now() }] });
    assert.equal((listSessions(db) as Array<any>)[0].status, "running");
  });

  it("does not accept a mismatched foreground app as a running session", () => {
    const { db, roomId, hubId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Wrong app", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const command = startCommand(db, sessionId);
    updateCommandStatus(db, command.id, "timeout", "unknown", { errorCode: "COMMAND_OUTCOME_UNKNOWN", outcomeState: "unknown" });
    const device = (listDevices(db) as Array<any>)[0];
    syncHubState(db, hubId, { agent_heartbeats: [{ stable_id: device.stable_id, agent_id: device.agent_id, android_id: device.android_id, session_id: sessionId, session_revision: 1, in_session: true, session_status: "running", current_app_package: "com.other.game", timestamp: Date.now() }] });
    assert.equal((listSessions(db) as Array<any>)[0].status, "starting");
  });

  it("makes extension requests idempotent and sends one Agent sync command", () => {
    const { db, roomId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Extend", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const start = startCommand(db, sessionId);
    succeed(db, start.id);
    extendSession(db, sessionId, 10, actor, { idempotencyKey: "extend-10-once" });
    extendSession(db, sessionId, 10, actor, { idempotencyKey: "extend-10-once" });
    const commands = (listCommands(db) as Array<any>).filter((command) => command.type === "EXTEND_SESSION");
    assert.equal(commands.length, 1);
    assert.equal((listSessions(db) as Array<any>)[0].extension_minutes, 10);
  });

  it("keeps end in finishing until cleanup is confirmed and deduplicates it", () => {
    const { db, roomId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Finish", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const start = startCommand(db, sessionId);
    succeed(db, start.id);
    finishActiveSessionForDevice(db, deviceIds[0], actor, { idempotencyKey: "finish-once" });
    finishActiveSessionForDevice(db, deviceIds[0], actor, { idempotencyKey: "finish-once" });
    assert.equal((listSessions(db) as Array<any>)[0].status, "finishing");
    const ends = (listCommands(db) as Array<any>).filter((command) => command.type === "END_SESSION");
    assert.equal(ends.length, 1);
    succeed(db, ends[0].id);
    assert.equal((listSessions(db) as Array<any>)[0].status, "completed");
  });

  it("owns expiry in Cloud and never marks offline cleanup completed", () => {
    const { db, roomId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Expired", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 1, actor });
    const start = startCommand(db, sessionId);
    succeed(db, start.id);
    db.prepare(`UPDATE session_devices SET started_at = datetime(CURRENT_TIMESTAMP, '-5 minutes') WHERE session_id = ?`).run(sessionId);
    const created = reconcileExpiredSessions(db);
    assert.equal(created.length, 1);
    assert.equal((listSessions(db) as Array<any>)[0].status, "finishing");
    assert.equal((listCommands(db) as Array<any>).filter((command) => command.type === "END_SESSION").length, 1);
    assert.equal(reconcileExpiredSessions(db).length, 0);
  });

  it("does not resurrect a completed session from a stale heartbeat", () => {
    const { db, roomId, hubId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Stale heartbeat", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const start = startCommand(db, sessionId);
    succeed(db, start.id);
    finishActiveSessionForDevice(db, deviceIds[0], actor);
    const end = (listCommands(db) as Array<any>).find((command) => command.type === "END_SESSION");
    succeed(db, end.id);
    const device = (listDevices(db) as Array<any>)[0];
    syncHubState(db, hubId, { agent_heartbeats: [{ stable_id: device.stable_id, agent_id: device.agent_id, android_id: device.android_id, session_id: sessionId, session_revision: 1, in_session: true, session_status: "running", current_app_package: "com.example.game", timestamp: 1 }] });
    assert.equal((listSessions(db) as Array<any>)[0].status, "completed");
    assert.equal(getActiveSessionForDevice(db, deviceIds[0]), null);
  });

  it("isolates per-device outcomes in a multi-device session", () => {
    const { db, roomId, deviceIds, actor } = fixture(2);
    const sessionId = createSession(db, { title: "Two Quest", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const starts = (listCommands(db) as Array<any>).filter((command) => command.type === "START_SESSION");
    assert.equal(starts.length, 2);
    succeed(db, starts[0].id);
    updateCommandStatus(db, starts[1].id, "accepted_by_hub");
    updateCommandStatus(db, starts[1].id, "running");
    updateCommandStatus(db, starts[1].id, "failed", "launch failed");
    const rows = db.prepare(`SELECT status FROM session_devices WHERE session_id = ? ORDER BY device_id`).all(sessionId) as Array<{ status: string }>;
    assert.deepEqual(rows.map((row) => row.status).sort(), ["failed", "running"]);
    assert.equal((listSessions(db) as Array<any>)[0].status, "running");
  });

  it("does not fail a multi-device session before the remaining Quest resolves", () => {
    const { db, roomId, deviceIds, actor } = fixture(2);
    const sessionId = createSession(db, { title: "Partial start", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 30, actor });
    const starts = (listCommands(db) as Array<any>).filter((command) => command.type === "START_SESSION");
    updateCommandStatus(db, starts[0].id, "accepted_by_hub");
    updateCommandStatus(db, starts[0].id, "running");
    updateCommandStatus(db, starts[0].id, "failed", "one Quest failed");
    assert.equal((listSessions(db) as Array<any>)[0].status, "starting");
    succeed(db, starts[1].id);
    assert.equal((listSessions(db) as Array<any>)[0].status, "running");
    const deviceStatuses = (db.prepare(`SELECT status FROM session_devices WHERE session_id = ?`).all(sessionId) as Array<{ status: string }>).map((row) => row.status).sort();
    assert.deepEqual(deviceStatuses, ["failed", "running"]);
  });

  it("survives a durable database close/reopen while running", () => {
    const path = `/tmp/bizonvr-session-${process.pid}-${Date.now()}.sqlite`;
    const first = createDatabase(path);
    const organizationId = createOrganization(first, { name: "Persist", slug: `persist-${Math.random()}` });
    const userId = createUser(first, { organizationId, email: `persist-${Math.random()}@local`, fullName: "Persist", role: "operator" });
    const planId = createSubscriptionPlan(first, { code: `persist-${Math.random()}`, name: "Persist", features: { sessions: true } });
    createOrganizationSubscription(first, { organizationId, planId, deviceLimit: 5 });
    const clubId = createClub(first, { organizationId, name: "Club", slug: `persist-club-${Math.random()}` });
    const roomId = createClubRoom(first, { clubId, name: "Room", slug: `persist-room-${Math.random()}` });
    const hubId = createLocalHub(first, { clubId, name: "Hub", status: "online" });
    const appId = createApp(first, { organizationId, name: "Game", slug: `persist-game-${Math.random()}`, packageName: "com.persist.game", visibility: "organization" });
    const appVersionId = createAppVersion(first, { appId, versionName: "1", versionCode: 1, apkChecksum: "x" });
    const deviceId = createDevice(first, { clubId, roomId, localHubId: hubId, name: "Quest", serialNumber: `PERSIST-${Math.random()}`, batteryPercent: 80 });
    upsertDeviceApp(first, { deviceId, appId, appVersionId, packageName: "com.persist.game", versionName: "1", versionCode: 1 });
    const actor = getPermissionActor(first, userId);
    assert.ok(actor);
    const sessionId = createSession(first, { title: "Persistent", roomId, deviceIds: [deviceId], appPackage: "com.persist.game", durationMinutes: 30, actor });
    const start = (listCommands(first) as Array<any>).find((command) => command.type === "START_SESSION");
    updateCommandStatus(first, start.id, "accepted_by_hub");
    updateCommandStatus(first, start.id, "running");
    succeed(first, start.id);
    first.close();
    const reopened = createDatabase(path);
    assert.equal((listSessions(reopened) as Array<any>).find((session) => session.id === sessionId).status, "running");
    reopened.close();
  });

  it("keeps timer arithmetic durable for long fake-clock intervals", () => {
    const { db, roomId, deviceIds, actor } = fixture();
    const sessionId = createSession(db, { title: "Timer", roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 480, actor });
    const start = startCommand(db, sessionId);
    succeed(db, start.id);
    db.prepare(`UPDATE session_devices SET started_at = datetime(CURRENT_TIMESTAMP, '-2 hours') WHERE session_id = ?`).run(sessionId);
    const running = getActiveSessionForDevice(db, deviceIds[0]);
    assert.ok(running);
    assert.ok(running.remaining_seconds <= 6 * 60 * 60 + 2);
    assert.ok(running.remaining_seconds >= 6 * 60 * 60 - 2);
  });

  it("runs 1000 lifecycle mutations without illegal states or duplicate active rows", () => {
    const { db, roomId, deviceIds, actor } = fixture();
    for (let index = 0; index < 1000; index += 1) {
      const sessionId = createSession(db, { title: `Soak ${index}`, roomId, deviceIds, appPackage: "com.example.game", durationMinutes: 1, actor });
      const start = startCommand(db, sessionId);
      succeed(db, start.id);
      if (index % 2 === 0) {
        extendSession(db, sessionId, 5, actor, { idempotencyKey: `soak-${index}-extend` });
        extendSession(db, sessionId, 5, actor, { idempotencyKey: `soak-${index}-extend` });
      }
      finishActiveSessionForDevice(db, deviceIds[0], actor, { idempotencyKey: `soak-${index}-end` });
      const end = (listCommands(db) as Array<any>).find((command) => command.session_id === sessionId && command.type === "END_SESSION");
      succeed(db, end.id);
      assert.equal(getActiveSessionForDevice(db, deviceIds[0]), null);
    }
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM session_devices WHERE device_id = ? AND status IN ('preparing', 'ready', 'running', 'paused')`).get(deviceIds[0]) as { count: number }).count, 0);
  });
});
