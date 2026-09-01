import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createFakeAdbState } from "./helpers/fake-adb";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("Local Hub command dispatcher", () => {
  it("executes a safe command through the real dispatcher with fake ADB", async () => {
    const fake = createFakeAdbState({
      devices: [{ serial: "QUEST-DISPATCH", status: "device", stableId: "QUEST-DISPATCH", androidId: "ANDROID-DISPATCH" }],
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-hub-dispatch-"));
    const executable = path.join(directory, "fake-adb");
    const fixture = fileURLToPath(new URL("./fixtures/fake-adb.mjs", import.meta.url));
    fs.writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o700 });

    const previousEnvironment = {
      ADB_PATH: process.env.ADB_PATH,
      FAKE_ADB_STATE: process.env.FAKE_ADB_STATE,
      LOCAL_HUB_DISABLE_AUTOSTART: process.env.LOCAL_HUB_DISABLE_AUTOSTART,
      COMMAND_STATE_PATH: process.env.COMMAND_STATE_PATH,
      HUB_PORT: process.env.HUB_PORT,
      APK_CACHE_ROOT: process.env.APK_CACHE_ROOT,
    };
    process.env.ADB_PATH = executable;
    process.env.FAKE_ADB_STATE = fake.spawnOptions.env.FAKE_ADB_STATE;
    process.env.LOCAL_HUB_DISABLE_AUTOSTART = "1";
    process.env.COMMAND_STATE_PATH = path.join(directory, "command-state.sqlite");
    process.env.HUB_PORT = "0";
    const apkRoot = path.join(directory, "apks");
    process.env.APK_CACHE_ROOT = apkRoot;
    fs.mkdirSync(apkRoot, { recursive: true });
    const apkBytes = Buffer.from("fake quest agent apk");
    fs.writeFileSync(path.join(process.env.APK_CACHE_ROOT, "quest-agent.apk"), apkBytes);
    const apkChecksum = crypto.createHash("sha256").update(apkBytes).digest("hex");

    try {
      const hubModulePath = "../local-hub/hub.js";
      const { runCommandOnce } = await import(hubModulePath);
      const result = await runCommandOnce("QUEST-DISPATCH", "RUN_DIAGNOSTICS", "{}");
      assert.equal(result.success, true);
      assert.match(result.message, /connection_status/);

      const refreshed = await runCommandOnce("QUEST-DISPATCH", "REFRESH_STATUS", "{}");
      assert.equal(refreshed.success, true);

      const mismatched = await runCommandOnce("QUEST-DISPATCH", "OPEN_LAUNCHER", "{}", {
        id: 99,
        target_stable_id: "DIFFERENT-QUEST",
      });
      assert.equal(mismatched.success, false);
      assert.equal(mismatched.errorCode, "DEVICE_IDENTITY_MISMATCH");

      const provisioned = await runCommandOnce("QUEST-DISPATCH", "INSTALL_APK", JSON.stringify({
        artifact_id: "quest-agent",
        apk_checksum: apkChecksum,
        package_name: "com.bizonvr.spatialspike",
        target: "quest_agent",
        rotate_agent_credential: true,
        stable_id: "QUEST-DISPATCH",
      }));
      assert.equal(provisioned.success, true);
      assert.match(provisioned.agent_token_hash, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(provisioned).includes("AGENT_TOKEN"), false);
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fake.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
