import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExecutionStore, getCommandPolicy, hashPayload } from "../local-hub/command-reliability.js";
import {
  createClub,
  createClubRoom,
  cancelDeviceCommand,
  createDatabase,
  createDevice,
  createLocalHub,
  createOrganization,
  createDeviceCommand,
  listCommands,
  syncHubState,
  updateCommandStatus,
} from "../src/backend/database";

function backendFixture() {
  const db = createDatabase(":memory:");
  const organizationId = createOrganization(db, { name: "Reliability Org", slug: `reliability-${Math.random()}` });
  const clubId = createClub(db, { organizationId, name: "Club", slug: `club-${Math.random()}` });
  const roomId = createClubRoom(db, { clubId, name: "Room", slug: `room-${Math.random()}` });
  const hubId = createLocalHub(db, { clubId, name: "Hub" });
  const deviceId = createDevice(db, {
    clubId, roomId, localHubId: hubId, name: "Quest", serialNumber: "QUEST-RELIABLE",
    stableId: "QUEST-STABLE", androidId: "ANDROID-RELIABLE", agentId: "AGENT-RELIABLE",
  });
  return { db, hubId, deviceId };
}

describe("DeviceCommand reliability store", () => {
  it("deduplicates twenty deliveries and rejects payload mutation", () => {
    const store = createExecutionStore(":memory:");
    const command = { id: 123, type: "LAUNCH_APP", payload: { package: "com.example.game", b: 2, a: 1 }, target_stable_id: "QUEST-STABLE" };
    assert.equal(store.claim(command).kind, "claimed");
    for (let index = 0; index < 19; index += 1) assert.equal(store.claim(command).kind, "in_flight");
    assert.equal((store.markEffectApplied(123, { success: true, message: "started" }) as any).state, "effect_applied");
    store.complete(123, { success: true, message: "started" });
    assert.equal(store.claim(command).kind, "already_done");
    assert.equal(store.recordReceived({ ...command, payload: { package: "com.other.game" } }).kind, "integrity_violation");
    assert.equal(store.recordReceived({ ...command, id: 124, payload_hash: "deadbeef" }).kind, "integrity_violation");
    store.close();
  });

  it("keeps a terminal result in a durable outbox and permits timeout-to-reconciled success", () => {
    const store = createExecutionStore(":memory:");
    const command = { id: 7, type: "START_SESSION", payload: { package: "com.example.game" }, target_stable_id: "QUEST-STABLE" };
    assert.equal(store.claim(command).kind, "claimed");
    store.markUnknown(7, "hub crashed after the agent launch", { errorCode: "COMMAND_OUTCOME_UNKNOWN" });
    assert.equal(store.recoverAfterRestart(command).kind, "reconciliation_required");
    store.complete(7, { success: true, reconciled: true });
    const pending = store.pendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal((pending[0] as any).status, "succeeded");
    store.markOutboxDelivered(7);
    assert.equal(store.pendingOutbox().length, 0);
    store.close();
  });

  it("does not blindly replay a dangerous recovered command when the journal is absent", () => {
    const store = createExecutionStore(":memory:");
    const recovered = store.recoverAfterRestart({ id: 99, type: "REBOOT_DEVICE", payload: {}, target_stable_id: "QUEST-STABLE", recovery_required: true });
    assert.equal(recovered.kind, "unknown_outcome");
    assert.equal((store.get(99) as any).state, "unknown_outcome");
    store.close();
  });

  it("uses bounded, semantic retry policies", () => {
    assert.equal(getCommandPolicy("REFRESH_STATUS").retryable, true);
    assert.equal(getCommandPolicy("REFRESH_STATUS").dangerous, false);
    assert.equal(getCommandPolicy("INSTALL_APK").retryable, false);
    assert.equal(getCommandPolicy("REBOOT_DEVICE").maxAttempts, 1);
    assert.equal(hashPayload({ z: 1, a: 2 }), hashPayload({ a: 2, z: 1 }));
  });
});

describe("Cloud command claims and state transitions", () => {
  it("atomically claims one head-of-line command and keeps a stable token on duplicate polls", () => {
    const { db, hubId, deviceId } = backendFixture();
    const commandId = createDeviceCommand(db, { deviceId, localHubId: hubId, type: "REFRESH_STATUS", payload: { reason: "test" } });
    const first = syncHubState(db, hubId, { hub_instance_id: "hub-instance-a", device_details: [] });
    const second = syncHubState(db, hubId, { hub_instance_id: "hub-instance-a", device_details: [] });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal((first[0] as any).claim_token, (second[0] as any).claim_token);
    assert.equal((listCommands(db).find((item: any) => item.id === commandId) as any).status, "accepted_by_hub");
  });

  it("preserves per-device ordering while allowing another device to claim", () => {
    const { db, hubId, deviceId } = backendFixture();
    const otherDeviceId = createDevice(db, { clubId: 1, roomId: 1, localHubId: hubId, name: "Quest 2", serialNumber: "QUEST-RELIABLE-2", stableId: "QUEST-STABLE-2" });
    createDeviceCommand(db, { deviceId, localHubId: hubId, type: "REFRESH_STATUS", payload: { n: 1 } });
    createDeviceCommand(db, { deviceId, localHubId: hubId, type: "REFRESH_STATUS", payload: { n: 2 } });
    createDeviceCommand(db, { deviceId: otherDeviceId, localHubId: hubId, type: "REFRESH_STATUS", payload: { n: 3 } });
    const claimed = syncHubState(db, hubId, { hub_instance_id: "parallel-hub", device_details: [] }) as any[];
    assert.deepEqual(claimed.map((command) => command.device_id), [deviceId, otherDeviceId]);
    assert.equal(claimed.some((command) => command.payload.includes('"n":2')), false);
  });

  it("rejects stale claims and accepts an idempotent identical terminal result", () => {
    const { db, hubId, deviceId } = backendFixture();
    const id = createDeviceCommand(db, { deviceId, localHubId: hubId, type: "REFRESH_STATUS" });
    const [claimed] = syncHubState(db, hubId, { hub_instance_id: "old", device_details: [] }) as any[];
    updateCommandStatus(db, id, "running", null, { hubId, claimToken: claimed.claim_token, hubInstanceId: "old" });
    assert.throws(() => updateCommandStatus(db, id, "succeeded", null, { hubId, claimToken: "stale", result: { success: true } }));
    updateCommandStatus(db, id, "succeeded", null, { hubId, claimToken: claimed.claim_token, hubInstanceId: "old", result: { success: true, message: "ok" } });
    assert.equal((updateCommandStatus(db, id, "succeeded", null, { hubId, claimToken: claimed.claim_token, result: { success: true, message: "ok" } }) as any).idempotent, true);
    assert.throws(() => updateCommandStatus(db, id, "succeeded", null, { hubId, result: { success: true, message: "different" } }));
  });

  it("cancels before claim and leaves no executable delivery", () => {
    const { db, hubId, deviceId } = backendFixture();
    const id = createDeviceCommand(db, { deviceId, localHubId: hubId, type: "REFRESH_STATUS" });
    assert.deepEqual(cancelDeviceCommand(db, id), { status: "cancelled", cancel_requested: false });
    assert.equal((syncHubState(db, hubId, { hub_instance_id: "cancel-hub", device_details: [] }) as any[]).length, 0);
    assert.equal((listCommands(db).find((command: any) => command.id === id) as any).status, "cancelled");
  });

  it("reclaims an expired lease with a new token and blocks the stale owner", () => {
    const { db, hubId, deviceId } = backendFixture();
    const id = createDeviceCommand(db, { deviceId, localHubId: hubId, type: "REFRESH_STATUS" });
    const [first] = syncHubState(db, hubId, { hub_instance_id: "old-hub", device_details: [] }) as any[];
    db.prepare(`UPDATE device_commands SET status = 'running', lease_until = '2000-01-01 00:00:00' WHERE id = ?`).run(id);
    const [reclaimed] = syncHubState(db, hubId, { hub_instance_id: "new-hub", device_details: [] }) as any[];
    assert.equal(reclaimed.recovery_required, true);
    assert.notEqual(reclaimed.claim_token, first.claim_token);
    assert.throws(() => updateCommandStatus(db, id, "succeeded", null, { hubId, claimToken: first.claim_token, result: { success: true } }));
  });

  it("stress: drains 10 Quest queues x 100 commands without cross-device blocking", () => {
    const { db, hubId, deviceId } = backendFixture();
    const devices = [deviceId, ...Array.from({ length: 9 }, (_, index) => createDevice(db, {
      clubId: 1, roomId: 1, localHubId: hubId, name: `Quest ${index + 2}`,
      serialNumber: `QUEST-STRESS-${index + 2}`, stableId: `QUEST-STRESS-STABLE-${index + 2}`,
    }))];
    for (const id of devices) {
      for (let sequence = 0; sequence < 100; sequence += 1) {
        createDeviceCommand(db, { deviceId: id, localHubId: hubId, type: "REFRESH_STATUS", payload: { sequence } });
      }
    }

    const observed: number[] = [];
    for (let round = 0; round < 100; round += 1) {
      const claimed = syncHubState(db, hubId, { hub_instance_id: "stress-hub", device_details: [] }) as any[];
      assert.equal(claimed.length, 10);
      for (const command of claimed) {
        observed.push(command.id);
        updateCommandStatus(db, command.id, "running", null, { hubId, claimToken: command.claim_token, hubInstanceId: "stress-hub" });
        updateCommandStatus(db, command.id, "succeeded", null, { hubId, claimToken: command.claim_token, hubInstanceId: "stress-hub", result: { success: true, sequence: JSON.parse(command.payload).sequence } });
      }
    }
    assert.equal(observed.length, 1000);
    assert.equal(new Set(observed).size, 1000);
    assert.equal((listCommands(db) as any[]).filter((command) => command.status !== "succeeded").length, 0);
  });
});
