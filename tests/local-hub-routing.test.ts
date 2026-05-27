import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildHeartbeatIdentity,
  prefersUsbForCommand,
  selectPreferredExecutionRoute,
} from "../local-hub/route-selection.js";

describe("Local Hub route selection", () => {
  it("prefers Wi-Fi for normal control when both routes are online", () => {
    const selected = selectPreferredExecutionRoute({
      usbSerial: "USB-01",
      wirelessSerial: "192.168.0.3:5555",
      usbOnline: true,
      wirelessOnline: true,
    });

    assert.strictEqual(selected, "192.168.0.3:5555");
  });

  it("prefers USB for maintenance when both routes are online", () => {
    const selected = selectPreferredExecutionRoute({
      usbSerial: "USB-01",
      wirelessSerial: "192.168.0.3:5555",
      usbOnline: true,
      wirelessOnline: true,
    }, { purpose: "maintenance" });

    assert.strictEqual(selected, "USB-01");
  });

  it("does not choose a stale offline USB route for normal control", () => {
    const selected = selectPreferredExecutionRoute({
      usbSerial: "USB-01",
      wirelessSerial: "192.168.0.3:5555",
      usbOnline: false,
      wirelessOnline: true,
    });

    assert.strictEqual(selected, "192.168.0.3:5555");
  });

  it("prefers USB for repair/install commands", () => {
    assert.strictEqual(prefersUsbForCommand("INSTALL_APK"), true);
    assert.strictEqual(prefersUsbForCommand("REFRESH_STATUS", { repair_wireless: true }), true);
    assert.strictEqual(prefersUsbForCommand("START_SESSION"), false);
  });

  it("does not treat IP as a heartbeat identity key", () => {
    assert.strictEqual(
      buildHeartbeatIdentity({
        agent_id: "AGENT-001",
        stable_id: "QUEST-STABLE-01",
        android_id: "ANDROID-01",
        local_ip: "192.168.0.3",
      }),
      "AGENT-001",
    );

    assert.strictEqual(
      buildHeartbeatIdentity({
        local_ip: "192.168.0.3",
      }),
      null,
    );
  });
});
