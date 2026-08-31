import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeAdbState } from "./helpers/fake-adb.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const soakScript = path.join(repositoryRoot, "scripts", "adb-hardware-soak.js");

function runSoak(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [soakScript, ...args], { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ADB hardware soak harness", () => {
  it("runs a short fake-ADB soak and writes a non-hardware artifact", async () => {
    const fake = createFakeAdbState({ devices: [{ serial: "USB-01", status: "device", stableId: "QUEST-SOAK-01", androidId: "ANDROID-SOAK-01", ip: "192.168.0.50" }] });
    const outputDirectory = path.join(os.tmpdir(), `bizonvr-soak-test-${Date.now()}`);
    const outputPath = path.join(outputDirectory, "soak.json");
    try {
      const result = await runSoak([
        "--device", "QUEST-SOAK-01",
        "--duration", "80ms",
        "--interval", "20ms",
        "--json-output", outputPath,
      ], {
        ...process.env,
        ADB_PATH: fake.executable,
        ADB_PREFIX_ARGS: JSON.stringify(fake.prefixArgs),
        FAKE_ADB_STATE: fake.spawnOptions.env?.FAKE_ADB_STATE,
        ADB_SOAK_SKIP_PORT_CHECK: "1",
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const artifact = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(artifact.result, "not_run");
      assert.equal(artifact.automatedResult, "pass");
      assert.equal(artifact.hardwareValidation, "not_run_fake_adb");
      assert.equal(artifact.run.hardwareObserved, true);
      assert.ok(artifact.counters.probes >= 1);
      assert.ok(artifact.latency.getState.p50Ms !== null);
      assert.equal(artifact.samples[0].healthCommand, "ok");
      assert.match(result.stdout, /ADB hardware soak: NOT RUN \(fake\/test ADB\)/);
    } finally {
      fake.cleanup();
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("marks an empty fake environment NOT RUN instead of manufacturing a pass", async () => {
    const fake = createFakeAdbState({ devices: [] });
    const outputDirectory = path.join(os.tmpdir(), `bizonvr-soak-no-device-${Date.now()}`);
    const outputPath = path.join(outputDirectory, "soak.json");
    try {
      const result = await runSoak([
        "--device", "QUEST-MISSING",
        "--duration", "1h",
        "--json-output", outputPath,
      ], {
        ...process.env,
        ADB_PATH: fake.executable,
        ADB_PREFIX_ARGS: JSON.stringify(fake.prefixArgs),
        FAKE_ADB_STATE: fake.spawnOptions.env?.FAKE_ADB_STATE,
        ADB_SOAK_SKIP_PORT_CHECK: "1",
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const artifact = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(artifact.result, "not_run");
      assert.equal(artifact.run.hardwareObserved, false);
      assert.match(result.stdout, /ADB hardware soak: NOT RUN/);
    } finally {
      fake.cleanup();
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
