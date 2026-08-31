import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdbProcessRunner } from "../local-hub/adb-process-runner.js";
import { executeWithAdbRecovery, isSafeAdbRetry } from "../local-hub/adb-command-executor.js";
import { createAdbSupervisor } from "../local-hub/adb-supervisor.js";
import { createFakeAdbState } from "./helpers/fake-adb.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ADB process runner", () => {
  it("runs argv without a shell and returns structured output", async () => {
    const fake = createFakeAdbState({ devices: [{ serial: "USB-01", status: "device" }], commands: { "shell echo probe": { stdout: "probe\n" } } });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 500 });
      const result = await runner.run(["-s", "USB-01", "shell", "echo", "probe"], { spawnOptions: fake.spawnOptions });
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "probe\n");
      assert.deepEqual(result.args, ["-s", "USB-01", "shell", "echo", "probe"]);
      assert.equal(runner.getActiveCount(), 0);
    } finally {
      fake.cleanup();
    }
  });

  it("kills a hung adb child and keeps the event loop responsive", async () => {
    const fake = createFakeAdbState({ hangs: ["hang"] });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 120, killGraceMs: 30 });
      let ticks = 0;
      const interval = setInterval(() => { ticks += 1; }, 10);
      const result = await runner.run(["hang"], { spawnOptions: fake.spawnOptions });
      clearInterval(interval);
      assert.equal(result.timedOut, true);
      assert.equal(result.ok, false);
      assert.ok(ticks >= 5, `event loop only ticked ${ticks} times`);
      assert.equal(runner.getActiveCount(), 0);
    } finally {
      fake.cleanup();
    }
  });

  it("distinguishes spawn failure from a command timeout", async () => {
    const runner = createAdbProcessRunner({ executable: "/definitely/missing/adb", defaultTimeoutMs: 100 });
    const result = await runner.run(["devices"]);
    assert.equal(result.timedOut, false);
    assert.ok(result.spawnError);
    assert.equal(result.ok, false);
  });

  it("supports cancellation without leaving an active child", async () => {
    const fake = createFakeAdbState({ hangs: ["hang"] });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 1000 });
      const controller = new AbortController();
      const pending = runner.run(["hang"], { signal: controller.signal, spawnOptions: fake.spawnOptions });
      await wait(20);
      controller.abort();
      const result = await pending;
      assert.equal(result.cancelled, true);
      assert.equal(runner.getActiveCount(), 0);
    } finally {
      fake.cleanup();
    }
  });

  it("times out a hung get-state probe without blocking later work", async () => {
    const fake = createFakeAdbState({ devices: [{ serial: "USB-01", status: "device" }], hangs: ["-s USB-01 get-state"] });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 100, killGraceMs: 30 });
      const result = await runner.run(["-s", "USB-01", "get-state"], { spawnOptions: fake.spawnOptions });
      assert.equal(result.timedOut, true);
      assert.equal(runner.getActiveCount(), 0);
    } finally {
      fake.cleanup();
    }
  });

  it("surfaces adb daemon failure without attempting a global kill-server", async () => {
    const fake = createFakeAdbState({ commands: { "devices -l": { code: 1, stderr: "cannot connect to daemon" } } });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 200 });
      const result = await runner.run(["devices", "-l"], { spawnOptions: fake.spawnOptions });
      assert.equal(result.ok, false);
      assert.match(result.stderr, /daemon/);
    } finally {
      fake.cleanup();
    }
  });

  it("fails safely when stdout exceeds the configured bound", async () => {
    const fake = createFakeAdbState({ commands: { "large": { stdout: "x".repeat(4096) } } });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 500 });
      const result = await runner.run(["large"], { maxStdoutBytes: 128, spawnOptions: fake.spawnOptions });
      assert.equal(result.ok, false);
      assert.equal(result.outputLimitExceeded, true);
      assert.equal(result.errorCode, "OUTPUT_LIMIT_EXCEEDED");
      assert.equal(runner.getActiveCount(), 0);
    } finally {
      fake.cleanup();
    }
  });

  it("preserves binary stdout for bounded screencap capture", async () => {
    const fake = createFakeAdbState({ commands: { "binary": { stdout: "\u0000\u0080\u00ff\u0001" } } });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 500 });
      const result = await runner.run(["binary"], { encoding: "buffer", spawnOptions: fake.spawnOptions });
      assert.equal(result.ok, true);
      assert.deepEqual(result.stdout, Buffer.from([0x00, 0xc2, 0x80, 0xc3, 0xbf, 0x01]));
    } finally {
      fake.cleanup();
    }
  });
});

describe("ADB command recovery", () => {
  it("re-resolves the route after recovery and retries only safe commands", async () => {
    const routes = ["192.168.1.20:5555", "192.168.1.35:5555"];
    const executed: string[] = [];
    let calls = 0;
    const result = await (executeWithAdbRecovery as any)({
      stableSerial: "QUEST-01",
      commandType: "OPEN_LAUNCHER",
      resolveRoute: async () => routes[Math.min(calls++, 1)],
      healthCheck: async () => true,
      execute: async (route) => {
        executed.push(route);
        if (executed.length === 1) return { success: false, error: "device offline", transportFailure: true };
        return { success: true, message: "ok" };
      },
      recover: async () => true,
    });
    assert.equal(result.success, true);
    assert.deepEqual(executed, routes);
    assert.equal(isSafeAdbRetry("INSTALL_APK"), false);
    assert.equal(isSafeAdbRetry("START_SESSION"), false);
    assert.equal(isSafeAdbRetry("PAUSE_SESSION"), false);
    assert.equal(isSafeAdbRetry("REBOOT_DEVICE"), false);
    assert.equal(isSafeAdbRetry("OPEN_LAUNCHER"), true);
  });
});

describe("ADB supervisor reliability", () => {
  function makeSupervisor(overrides: Record<string, unknown> = {}) {
    return (createAdbSupervisor as any)({
      baseBackoffMs: 10,
      maxBackoffMs: 80,
      jitterRatio: 0,
      getKnownState: () => ({ ip: "192.168.1.20", previousIps: ["192.168.1.10"], androidId: "ANDROID-01" }),
      rememberRoute: () => undefined,
      checkRoutePortOpen: async () => true,
      adbDisconnect: async () => ({ success: true }),
      adbConnect: async () => ({ success: true, message: "connected" }),
      verifyRouteIdentity: async () => ({ matched: true, stableId: "QUEST-01", androidId: "ANDROID-01" }),
      checkAdbRecoveryPermission: () => ({ allowed: false, status: "permission_missing", message: "missing" }),
      ...overrides,
    });
  }

  it("coalesces concurrent tick/forceReconnect calls into one flight", async () => {
    let connectCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = makeSupervisor({
      adbConnect: async () => { connectCalls += 1; await gate; return { success: true, message: "connected" }; },
    });
    const route = { stableSerial: "QUEST-01", ip: "192.168.1.20", agentOnline: true, adbState: "offline" };
    const flights = Array.from({ length: 20 }, () => supervisor.tick(route));
    await wait(10);
    assert.equal(supervisor.getInFlightCount(), 1);
    release();
    await Promise.all(flights);
    assert.equal(connectCalls, 1);
    assert.equal(supervisor.getState("QUEST-01")?.status, "online");
  });

  it("resets backoff after confirmed recovery", async () => {
    let connectCalls = 0;
    const supervisor = makeSupervisor({
      getKnownState: () => ({ ip: "192.168.1.20", previousIps: [], androidId: "ANDROID-01" }),
      adbConnect: async () => {
        connectCalls += 1;
        return connectCalls === 1 ? { success: false, message: "connection refused" } : { success: true, message: "connected" };
      },
    });
    const route = { stableSerial: "QUEST-01", ip: "192.168.1.20", agentOnline: true, adbState: "offline" };
    const failed = await supervisor.forceReconnect("QUEST-01", { route });
    assert.ok(failed?.backoffMs > 0);
    const recovered = await supervisor.forceReconnect("QUEST-01", { route });
    assert.equal(recovered?.status, "online");
    assert.equal(recovered?.attemptCount, 0);
    assert.equal(recovered?.backoffMs, 0);
  });

  it("rejects stale old-IP results when heartbeat updates to a new IP", async () => {
    const remembered: Array<Record<string, unknown>> = [];
    let firstConnect!: () => void;
    const firstGate = new Promise<void>((resolve) => { firstConnect = resolve; });
    let connects = 0;
    const supervisor = makeSupervisor({
      getKnownState: () => ({ ip: "192.168.1.20", previousIps: [], androidId: "ANDROID-01" }),
      rememberRoute: (_serial: string, update: Record<string, unknown>) => remembered.push(update),
      adbConnect: async (serial: string) => {
        connects += 1;
        if (serial === "192.168.1.20:5555") await firstGate;
        return { success: true, message: "connected" };
      },
    });
    const oldRoute = { stableSerial: "QUEST-01", ip: "192.168.1.20", agentOnline: true, adbState: "offline" };
    const flight = supervisor.forceReconnect("QUEST-01", { route: oldRoute, heartbeatIp: "192.168.1.20" });
    await wait(10);
    const updated = supervisor.forceReconnect("QUEST-01", { route: { ...oldRoute, ip: "192.168.1.35" }, heartbeatIp: "192.168.1.35" });
    firstConnect();
    const result = await updated;
    await flight;
    assert.equal(result?.status, "online");
    assert.equal(remembered.at(-1)?.ip, "192.168.1.35");
    assert.equal(connects >= 2, true);
  });

  it("keeps five Quest recovery flights independent", async () => {
    const active = new Set<string>();
    let maxActive = 0;
    const supervisor = (createAdbSupervisor as any)({
      baseBackoffMs: 1,
      jitterRatio: 0,
      getKnownState: (serial) => ({ ip: `192.168.1.${serial.slice(-1)}`, previousIps: [] }),
      checkRoutePortOpen: async () => true,
      adbDisconnect: async () => ({ success: true }),
      adbConnect: async (serial) => {
        active.add(serial); maxActive = Math.max(maxActive, active.size);
        await wait(5);
        active.delete(serial);
        return { success: true, message: "connected" };
      },
      verifyRouteIdentity: async ({ stableSerial }) => ({ matched: true, stableId: stableSerial }),
      checkAdbRecoveryPermission: () => ({ allowed: false, status: "permission_missing" }),
    });
    await Promise.all(Array.from({ length: 5 }, (_, index) => supervisor.forceReconnect(`QUEST-${index + 1}`, { route: { stableSerial: `QUEST-${index + 1}`, ip: `192.168.1.${index + 1}`, agentOnline: true } })));
    assert.equal(maxActive, 5);
    assert.equal(supervisor.getInFlightCount(), 0);
  });

  it("does not reconnect during 100 stable health checks", async () => {
    let connectCalls = 0;
    const supervisor = makeSupervisor({ adbConnect: async () => { connectCalls += 1; return { success: true }; } });
    for (let index = 0; index < 100; index += 1) {
      await supervisor.tick({ stableSerial: "QUEST-STABLE", adbState: "online", agentOnline: true, ip: "192.168.1.20" });
    }
    assert.equal(connectCalls, 0);
    assert.equal(supervisor.getState("QUEST-STABLE")?.status, "online");
  });

  it("handles rapid offline/online flaps without accumulating flights or state", async () => {
    const supervisor = makeSupervisor({ adbConnect: async () => ({ success: true, message: "connected" }) });
    for (let index = 0; index < 100; index += 1) {
      await supervisor.tick({ stableSerial: "QUEST-FLAP", adbState: "offline", agentOnline: true, ip: "192.168.1.20" }, { force: true });
      await supervisor.tick({ stableSerial: "QUEST-FLAP", adbState: "online", agentOnline: true, ip: "192.168.1.20" });
    }
    assert.equal(supervisor.getInFlightCount(), 0);
    assert.equal(supervisor.getStateCount(), 1);
    assert.equal(supervisor.getState("QUEST-FLAP")?.status, "online");
    assert.equal(supervisor.getState("QUEST-FLAP")?.attemptCount, 0);
  });

  it("stress: keeps five Quest identities independent across 1000 mixed iterations", async () => {
    const supervisor = makeSupervisor({
      getKnownState: (stableSerial: string) => ({ ip: `10.0.0.${stableSerial.slice(-1)}`, previousIps: [], androidId: `ANDROID-${stableSerial.slice(-1)}` }),
      verifyRouteIdentity: async ({ stableSerial }: { stableSerial: string }) => ({ matched: true, stableId: stableSerial, androidId: `ANDROID-${stableSerial.slice(-1)}` }),
    });
    const quests = Array.from({ length: 5 }, (_, index) => `QUEST-STRESS-${index + 1}`);
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      await Promise.all(quests.map((stableSerial, index) => {
        const ip = `10.0.${iteration % 3}.${index + 1}`;
        if (iteration % 11 === index) {
          return supervisor.forceReconnect(stableSerial, { route: { stableSerial, ip, agentOnline: true, adbState: "offline" }, heartbeatIp: ip });
        }
        return supervisor.tick({ stableSerial, ip, agentOnline: true, adbState: "online" });
      }));
    }
    assert.equal(supervisor.getInFlightCount(), 0);
    assert.equal(supervisor.getStateCount(), quests.length);
    for (const stableSerial of quests) {
      const state = supervisor.getState(stableSerial);
      assert.equal(state?.status, "online");
      assert.equal(state?.inFlight, false);
      assert.equal(state?.attemptCount, 0);
    }
  });
});
