import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createAgentAuthenticator } from "../local-hub/agent/auth.js";
import { createAgentCredentialStore } from "../local-hub/agent/credentials.js";
import { createHeartbeatStore } from "../local-hub/agent/heartbeat-store.js";
import { createAgentServer } from "../local-hub/agent/server.js";
import { createCommandWorker } from "../local-hub/commands/worker.js";
import { createLifecycle } from "../local-hub/lifecycle/shutdown.js";
import { createAgentCredential } from "../local-hub/agent-credentials.js";

function request(token: string, data: Record<string, unknown>) {
  return { headers: { authorization: `Bearer ${token}` } } as never;
}

describe("Local Hub extracted Agent modules", () => {
  it("keeps credential auth, freshness, replay protection, and persistence", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-agent-auth-"));
    const filename = path.join(directory, "agent-credentials.json");
    const credential = createAgentCredential();
    const store = createAgentCredentialStore(filename);
    store.activate("QUEST-AUTH", { pairing_id: "PAIR-AUTH", agent_id: "AGENT-AUTH", android_id: "ANDROID-AUTH" }, credential);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);

    const now = 1_000_000;
    const auth = createAgentAuthenticator({ credentials: store, heartbeatMaxAgeMs: 60_000, heartbeatStore: createHeartbeatStore(), clock: () => now } as any);
    const data = { pairing_id: "PAIR-AUTH", stable_id: "QUEST-AUTH", timestamp: now };
    assert.equal(auth.verify(request(credential.token, data), data).ok, true);
    assert.equal(auth.verify(request("wrong", { ...data, timestamp: now + 1 }), { ...data, timestamp: now + 1 }).status, 401);
    assert.equal(auth.verify(request(credential.token, { timestamp: now + 2 }), { timestamp: now + 2 }).status, 401);
    assert.equal(auth.verify(request(credential.token, { ...data, timestamp: now - 61_000 }), { ...data, timestamp: now - 61_000 }).status, 408);
    assert.equal(auth.verify(request(credential.token, data), data).status, 409);

    const reloaded = createAgentCredentialStore(filename);
    const reloadedAuth = createAgentAuthenticator({ credentials: reloaded, heartbeatMaxAgeMs: 60_000, heartbeatStore: createHeartbeatStore(), clock: () => now } as any);
    assert.equal(reloadedAuth.verify(request(credential.token, data), data).status, 409);
    assert.equal(reloadedAuth.verify(request(credential.token, { ...data, timestamp: now + 1 }), { ...data, timestamp: now + 1 }).ok, true);
    assert.equal(fs.readFileSync(filename, "utf8").includes("[REDACTED]"), false);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("preserves authenticated heartbeat HTTP statuses and body limits", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-agent-server-"));
    const store = createAgentCredentialStore(path.join(directory, "credentials.json"));
    const credential = createAgentCredential();
    store.activate("QUEST-HTTP", { pairing_id: "PAIR-HTTP", agent_id: "AGENT-HTTP" }, credential);
    const heartbeatStore = createHeartbeatStore();
    const now = Date.now();
    const server = createAgentServer({
      config: {
        AGENT_JSON_BODY_LIMIT: 1024,
        DEVICE_SERIAL_REGEX: /^[A-Za-z0-9._:-]+$/,
        STREAM_MODE: "fmp4",
        STREAM_PROFILE: "balanced",
        HUB_ID: 1,
      },
      auth: createAgentAuthenticator({ credentials: store, heartbeatMaxAgeMs: 60_000, heartbeatStore, clock: () => now } as any),
      heartbeatStore,
      routing: { isIgnoredDevice: () => false },
      cloud: { forwardOperatorCall: async () => {} },
      log: () => {},
    } as any).server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const send = (body: unknown, token = credential.token) => fetch(`http://127.0.0.1:${address.port}/api/agent/heartbeat`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const body = { pairing_id: "PAIR-HTTP", stable_id: "QUEST-HTTP", timestamp: now };
    assert.equal((await send(body)).status, 200);
    assert.equal((await send(body)).status, 409);
    assert.equal((await send({ ...body, timestamp: now + 1 }, "wrong")).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/agent/heartbeat`, { method: "POST", body: "{" })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/agent/heartbeat`, { method: "POST", body: "x".repeat(2048) })).status, 413);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("Local Hub command locking", () => {
  it("serializes same-device command execution without timing sleeps", async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const routing = {
      adbCommandMetricsByStableSerial: new Map(),
      resolveStableSerial: (serial: string) => serial,
      resolveRouteForCommand: async () => ({ selectedRoute: "QUEST-LOCK" }),
      isAdbRouteOnline: async () => true,
      supervisor: { forceReconnect: async () => ({ status: "online" }) },
      routes: {},
      findAgentHeartbeatForRoute: () => null,
      refreshDeviceRouting: async () => {},
    } as never;
    const dispatcher = {
      dispatch: async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (calls === 1) await firstGate;
        active -= 1;
        return { success: true };
      },
    } as never;
    const worker = createCommandWorker({ config: {}, routing, dispatcher, getCommandPolicy: () => ({ dangerous: false }), log: () => {} } as any);
    const first = worker.runCommand("QUEST-LOCK", "PING", "{}");
    const second = worker.runCommand("QUEST-LOCK", "PING", "{}");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(peak, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(peak, 1);
    assert.equal(calls, 2);
  });
});

describe("Local Hub lifecycle", () => {
  it("stops timers, casts, processes, server, and journal once", async () => {
    let timerCleared = 0;
    let castStops = 0;
    let serverCloses = 0;
    let journalCloses = 0;
    let processKills = 0;
    const fakeProcess = { exitCode: 0, kill: () => { processKills += 1; }, once: () => {} };
    const shutdown = createLifecycle({
      server: { close: (callback: () => void) => { serverCloses += 1; callback(); } },
      castManager: { getActiveCount: () => 1, stopAll: async () => { castStops += 1; } },
      scrcpyProcesses: new Map([["QUEST", { process: fakeProcess }]]),
      executionStore: { close: () => { journalCloses += 1; } },
      clearSyncTimer: () => { timerCleared += 1; },
      config: { CAST_KILL_GRACE_MS: 1, CAST_TERM_GRACE_MS: 1 },
      log: () => {},
    } as any).shutdown;
    const first = shutdown("test");
    const second = shutdown("test-again");
    await first;
    await second;
    assert.equal(timerCleared, 1);
    assert.equal(castStops, 1);
    assert.equal(serverCloses, 1);
    assert.equal(journalCloses, 1);
    assert.equal(processKills, 1);
  });
});
