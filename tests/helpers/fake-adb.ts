import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FakeAdbDevice = {
  serial: string;
  status?: string;
  state?: string;
  stableId?: string;
  androidId?: string;
  ip?: string;
  wifiSsid?: string;
  transportId?: string;
};

export type FakeAdbState = {
  devices?: FakeAdbDevice[];
  connect?: Record<string, { status?: string; message?: string }>;
  hangs?: string[];
  delays?: Record<string, number>;
  commands?: Record<string, { code?: number; stdout?: string; stderr?: string }>;
};

export function createFakeAdbState(initial: FakeAdbState = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-fake-adb-"));
  const statePath = path.join(directory, "state.json");
  const scriptPath = fileURLToPath(new URL("../fixtures/fake-adb.mjs", import.meta.url));
  const write = (next: FakeAdbState) => fs.writeFileSync(statePath, JSON.stringify(next));
  write(initial);
  return {
    executable: process.execPath,
    prefixArgs: [scriptPath],
    spawnOptions: { env: { ...process.env, FAKE_ADB_STATE: statePath } },
    update(next: FakeAdbState) { write(next); },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
