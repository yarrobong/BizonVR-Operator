import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    };
    process.env.ADB_PATH = executable;
    process.env.FAKE_ADB_STATE = fake.spawnOptions.env.FAKE_ADB_STATE;
    process.env.LOCAL_HUB_DISABLE_AUTOSTART = "1";
    process.env.COMMAND_STATE_PATH = path.join(directory, "command-state.sqlite");
    process.env.HUB_PORT = "0";

    try {
      const hubModulePath = "../local-hub/hub.js";
      const { runCommandOnce } = await import(hubModulePath);
      const result = await runCommandOnce("QUEST-DISPATCH", "RUN_DIAGNOSTICS", "{}");
      assert.equal(result.success, true);
      assert.match(result.message, /connection_status/);
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
