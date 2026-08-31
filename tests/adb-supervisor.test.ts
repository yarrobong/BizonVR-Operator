import { describe, it } from "node:test";
import assert from "node:assert";
import { buildReconnectCandidates, createAdbSupervisor } from "../local-hub/adb-supervisor.js";

describe("ADB Supervisor", () => {
  it("tries heartbeat, last known and previous IPs in order", () => {
    assert.deepStrictEqual(
      buildReconnectCandidates({
        heartbeatIp: "192.168.0.50",
        lastKnownIp: "192.168.0.20",
        previousIps: ["192.168.0.10", "192.168.0.20"],
      }),
      ["192.168.0.50", "192.168.0.20", "192.168.0.10"],
    );
  });

  it("reconnects using remembered routes and verifies android_id", async () => {
    const attempted: string[] = [];
    const remembered: Array<Record<string, unknown>> = [];
    const supervisor = createAdbSupervisor({
      port: 5555,
      getKnownState: () => ({ ip: "192.168.0.20", previousIps: ["192.168.0.10"], androidId: "ANDROID-01" }),
      rememberRoute: (_stableSerial, updates) => remembered.push(updates),
      checkRoutePortOpen: async (ip) => ip === "192.168.0.20",
      adbDisconnect: async () => ({ success: true }),
      adbConnect: async (serial) => {
        attempted.push(serial);
        return serial === "192.168.0.20:5555"
          ? { success: true, message: "connected to 192.168.0.20:5555" }
          : { success: false, message: "failed" };
      },
      verifyRouteIdentity: async () => ({ matched: true, stableId: "QUEST-01", androidId: "ANDROID-01" }),
      checkAdbRecoveryPermission: () => ({ allowed: false, status: "permission_missing", message: "missing" }),
      tryEnableWirelessAdb: async () => ({ success: false, status: "permission_missing", message: "missing" }),
    });

    const result = await supervisor.forceReconnect("QUEST-01", {
      route: { stableSerial: "QUEST-01", ip: "192.168.0.20", androidId: "ANDROID-01", agentOnline: true },
      heartbeatIp: "192.168.0.20",
    });

    assert.strictEqual(result?.status, "online");
    assert.deepStrictEqual(attempted, ["192.168.0.20:5555"]);
    assert.strictEqual(remembered[0]?.wirelessSerial, "192.168.0.20:5555");
  });

  it("marks connection refused as tcpip_unavailable", async () => {
    const supervisor = createAdbSupervisor({
      port: 5555,
      getKnownState: () => ({ ip: "192.168.0.20", previousIps: [] }),
      rememberRoute: () => undefined,
      checkRoutePortOpen: async () => true,
      adbDisconnect: async () => ({ success: true }),
      adbConnect: async () => ({ success: false, message: "Connection refused" }),
      verifyRouteIdentity: async () => ({ matched: false }),
      checkAdbRecoveryPermission: () => ({ allowed: false, status: "permission_missing", message: "missing" }),
      tryEnableWirelessAdb: async () => ({ success: false, status: "permission_missing", message: "missing" }),
    });

    const result = await supervisor.forceReconnect("QUEST-02", {
      route: { stableSerial: "QUEST-02", ip: "192.168.0.20", agentOnline: true },
    });

    assert.strictEqual(result?.status, "tcpip_unavailable");
  });

  it("keeps unauthorized separate from offline", async () => {
    const supervisor = createAdbSupervisor({
      getKnownState: () => ({}),
      rememberRoute: () => undefined,
      checkRoutePortOpen: async () => false,
      adbDisconnect: async () => ({ success: true }),
      adbConnect: async () => ({ success: false, message: "unauthorized" }),
      verifyRouteIdentity: async () => ({ matched: false }),
      checkAdbRecoveryPermission: () => ({ allowed: false, status: "permission_missing", message: "missing" }),
      tryEnableWirelessAdb: async () => ({ success: false, status: "permission_missing", message: "missing" }),
    });

    const state = await supervisor.tick({
      stableSerial: "QUEST-03",
      adbState: "unauthorized",
      agentOnline: false,
    });

    assert.strictEqual(state?.status, "unauthorized");
  });

  it("marks mismatched identity as different_device", async () => {
    const supervisor = createAdbSupervisor({
      port: 5555,
      getKnownState: () => ({ ip: "192.168.0.20", previousIps: [] }),
      rememberRoute: () => undefined,
      checkRoutePortOpen: async () => true,
      adbDisconnect: async () => ({ success: true }),
      adbConnect: async () => ({ success: true, message: "connected to 192.168.0.20:5555" }),
      verifyRouteIdentity: async () => ({ matched: false, message: "android_id mismatch" }),
      checkAdbRecoveryPermission: () => ({ allowed: false, status: "permission_missing", message: "missing" }),
      tryEnableWirelessAdb: async () => ({ success: false, status: "permission_missing", message: "missing" }),
    });

    const result = await supervisor.forceReconnect("QUEST-04", {
      route: { stableSerial: "QUEST-04", ip: "192.168.0.20", androidId: "ANDROID-04", agentOnline: true },
    });

    assert.strictEqual(result?.status, "different_device");
  });
});
