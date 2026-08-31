import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createCastManager, terminateOwnedProcess } from "../local-hub/cast-manager.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 100000) + 1000;
  killed = false;
  exitCode: number | null = null;
  signals: string[] = [];
  ignoreTerm = false;

  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    this.killed = true;
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    queueMicrotask(() => this.emit("close", this.exitCode, signal));
    return true;
  }
}

function fakeResponse({ blocked = false } = {}) {
  const response = new EventEmitter() as any;
  response.headersSent = false;
  response.destroyed = false;
  response.writableEnded = false;
  response.writableLength = 0;
  response.writes = [] as Buffer[];
  response.writeHead = (_status: number, headers: Record<string, string>) => {
    response.headersSent = true;
    response.headers = headers;
  };
  response.write = (chunk: Buffer | string) => {
    response.writes.push(Buffer.from(chunk));
    return !blocked;
  };
  response.end = (chunk?: Buffer | string) => {
    if (chunk) response.writes.push(Buffer.from(chunk));
    response.writableEnded = true;
    response.emit("close");
  };
  response.destroy = () => {
    response.destroyed = true;
    response.emit("close");
  };
  return response;
}

function fakeRequest() {
  return new EventEmitter() as any;
}

function makeProducer(output = new EventEmitter(), child = new FakeChild()) {
  return { output, processes: [child], detach() {}, stop() {} };
}

function attach(manager: ReturnType<typeof createCastManager>, key: string, factory: any, overrides: any = {}) {
  return manager.attachViewer({
    key,
    route: overrides.route || `${key}:5555`,
    transport: overrides.transport || "fmp4",
    profile: overrides.profile || "low-latency",
    responseHeaders: { "Content-Type": "video/mp4" },
    fallbackResponseHeaders: { "Content-Type": "multipart/x-mixed-replace" },
    req: overrides.req || fakeRequest(),
    res: overrides.res || fakeResponse(),
    startProducer: factory,
    fallbackProducer: overrides.fallbackProducer,
  });
}

describe("cast manager reliability", () => {
  it("coalesces twenty concurrent starts into one producer and fans out data", () => {
    const manager = createCastManager({ maxConcurrentCasts: 10, maxViewersPerCast: 20 });
    const output = new EventEmitter();
    let starts = 0;
    const results = Array.from({ length: 20 }, () => attach(manager, "QUEST-01", () => {
      starts += 1;
      return makeProducer(output);
    }));
    assert.equal(results.filter((result) => result.ok).length, 20);
    assert.equal(starts, 1);
    output.emit("data", Buffer.from("frame-1"));
    assert.equal(manager.get("QUEST-01")?.state, "streaming");
    assert.equal(manager.get("QUEST-01")?.viewerCount, 20);
  });

  it("keeps a second viewer alive when the first viewer disconnects", () => {
    const manager = createCastManager({ noViewerStopMs: 1 });
    const output = new EventEmitter();
    const first = attach(manager, "QUEST-02", () => makeProducer(output));
    const second = attach(manager, "QUEST-02", () => makeProducer(output));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    output.emit("data", Buffer.from("init"));
    first.viewer!.res.emit("close");
    output.emit("data", Buffer.from("next"));
    assert.equal(manager.get("QUEST-02")?.viewerCount, 1);
    assert.equal(second.viewer!.res.writes.length >= 2, true);
  });

  it("uses bounded backpressure and disconnects a dead slow viewer", async () => {
    const manager = createCastManager({ slowViewerTimeoutMs: 10, maxPendingBytes: 32 });
    const output = new EventEmitter();
    const result = attach(manager, "QUEST-03", () => makeProducer(output), { res: fakeResponse({ blocked: true }) });
    output.emit("data", Buffer.from("first"));
    await wait(15);
    output.emit("data", Buffer.from("second"));
    assert.equal(manager.get("QUEST-03")?.viewerCount, 0);
    assert.equal(manager.getMetrics().slow_viewer_disconnect, 1);
    assert.equal(result.ok, true);
  });

  it("falls back after a primary startup failure and reaches streaming", async () => {
    const manager = createCastManager({ bootTimeoutMs: 10, termGraceMs: 1, killGraceMs: 1 });
    const primaryChild = new FakeChild();
    const primaryOutput = new EventEmitter();
    const fallbackOutput = new EventEmitter();
    let fallbackStarts = 0;
    const result = attach(manager, "QUEST-04", () => ({ output: primaryOutput, processes: [primaryChild] }), {
      fallbackProducer: () => {
        fallbackStarts += 1;
        return { output: fallbackOutput, processes: [] };
      },
    });
    primaryChild.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await wait(5);
    fallbackOutput.emit("data", Buffer.from("png-frame"));
    await wait(5);
    assert.equal(fallbackStarts, 1);
    assert.equal(manager.get("QUEST-04")?.state, "streaming");
    assert.match(result.viewer!.res.headers["Content-Type"], /multipart/);
  });

  it("returns an actionable failure when both primary and fallback fail", async () => {
    const manager = createCastManager({ recoveryAttempts: 0, termGraceMs: 1, killGraceMs: 1 });
    const primary = new EventEmitter();
    const fallback = new EventEmitter();
    const response = fakeResponse();
    const result = attach(manager, "QUEST-FALLBACK-FAIL", () => ({ output: primary, processes: [] }), { res: response, fallbackProducer: () => ({ output: fallback, processes: [] }) });
    primary.emit("error", Object.assign(new Error("ffmpeg ENOENT"), { code: "ENOENT" }));
    await wait(3);
    fallback.emit("error", Object.assign(new Error("screencap unavailable"), { code: "STREAM_CAPTURE_FAILED" }));
    await wait(3);
    assert.equal(response.writableEnded, true);
    assert.match(Buffer.concat(response.writes).toString(), /STREAM_CAPTURE_FAILED/);
    assert.equal(result.ok, true);
  });

  it("cleans up on request abort and response ECONNRESET", async () => {
    const manager = createCastManager({ noViewerStopMs: 1, termGraceMs: 1, killGraceMs: 1 });
    const output = new EventEmitter();
    const request = fakeRequest();
    const response = fakeResponse();
    attach(manager, "QUEST-DISCONNECT", () => makeProducer(output), { req: request, res: response });
    output.emit("data", Buffer.from("frame"));
    request.emit("aborted");
    await wait(3);
    assert.equal(manager.getActiveCount(), 0);
    const second = attach(manager, "QUEST-ECONNRESET", () => makeProducer(new EventEmitter()), { res: fakeResponse() });
    second.viewer!.res.emit("error", Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
    await wait(3);
    assert.equal(manager.getActiveCount(), 0);
  });

  it("recovers on a new route and ignores stale generation output", async () => {
    const manager = createCastManager({ recoveryBaseDelayMs: 1, recoveryAttempts: 1, termGraceMs: 1, killGraceMs: 1, resolveRoute: async () => "QUEST-05:5556" });
    const outputs: EventEmitter[] = [];
    const children: FakeChild[] = [];
    let starts = 0;
    const result = attach(manager, "QUEST-05", () => {
      const output = new EventEmitter();
      const child = new FakeChild();
      outputs.push(output);
      children.push(child);
      starts += 1;
      return { output, processes: [child] };
    });
    outputs[0].emit("data", Buffer.from("old"));
    children[0].emit("close", 1, null);
    await wait(8);
    assert.equal(starts, 2);
    assert.equal(manager.get("QUEST-05")?.route, "QUEST-05:5556");
    outputs[0].emit("data", Buffer.from("stale"));
    outputs[1].emit("data", Buffer.from("new"));
    assert.equal(result.viewer!.res.writes.at(-1)?.toString(), "new");
  });

  it("terminates an uncooperative process with SIGKILL", async () => {
    const child = new FakeChild();
    child.ignoreTerm = true;
    const result = await terminateOwnedProcess(child, { termGraceMs: 2, killGraceMs: 5 });
    assert.equal(result.forced, true);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  });

  it("makes twenty concurrent stop calls idempotent", async () => {
    const manager = createCastManager({ termGraceMs: 1, killGraceMs: 1 });
    const child = new FakeChild();
    const result = attach(manager, "QUEST-STOP", () => makeProducer(new EventEmitter(), child));
    await Promise.all(Array.from({ length: 20 }, () => manager.stop(result.record!, "operator_stop")));
    assert.deepEqual(child.signals, ["SIGTERM"]);
    assert.equal(manager.getActiveCount(), 0);
  });

  it("rejects a cast when the concurrent-cast limit is reached", () => {
    const manager = createCastManager({ maxConcurrentCasts: 1 });
    attach(manager, "QUEST-LIMIT-1", () => makeProducer());
    const rejected = attach(manager, "QUEST-LIMIT-2", () => makeProducer());
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("expected limit rejection");
    assert.equal(rejected.status, 429);
    assert.equal(rejected.body.error, "CAST_LIMIT_REACHED");
  });

  it("does not retry a failed stream on an unverified replacement route", async () => {
    const manager = createCastManager({ recoveryAttempts: 2, recoveryBaseDelayMs: 1, resolveRoute: async () => null, termGraceMs: 1, killGraceMs: 1 });
    const output = new EventEmitter();
    const child = new FakeChild();
    attach(manager, "QUEST-WRONG", () => ({ output, processes: [child] }));
    output.emit("error", new Error("ADB route lost"));
    await wait(5);
    assert.equal(manager.get("QUEST-WRONG"), null);
    assert.equal(manager.getMetrics().cast_restart_total, 1);
  });

  it("survives one failed Quest while ten other Quest casts remain isolated", async () => {
    const manager = createCastManager({ maxConcurrentCasts: 10, maxViewersPerCast: 1, recoveryAttempts: 0, termGraceMs: 1, killGraceMs: 1 });
    const outputs = Array.from({ length: 10 }, () => new EventEmitter());
    outputs.forEach((output, index) => attach(manager, `QUEST-ISO-${index}`, () => ({ output, processes: [new FakeChild()] })));
    outputs[0].emit("error", new Error("ffmpeg crash"));
    await wait(3);
    assert.equal(manager.getActiveCount(), 9);
    for (let index = 1; index < 10; index += 1) outputs[index].emit("data", Buffer.from("ok"));
    assert.equal([...Array(9)].every((_, index) => manager.get(`QUEST-ISO-${index + 1}`)?.state === "streaming"), true);
    await manager.stopAll("test_cleanup");
  });

  it("runs one thousand start/stop iterations without retaining registry entries", async () => {
    const manager = createCastManager({ recoveryAttempts: 0, noViewerStopMs: 1, termGraceMs: 1, killGraceMs: 1 });
    for (let index = 0; index < 1000; index += 1) {
      const output = new EventEmitter();
      const result = attach(manager, `QUEST-ITER-${index % 3}`, () => ({ output, processes: [new FakeChild()] }));
      output.emit("data", Buffer.from("frame"));
      await manager.stop(result.record!, "iteration_cleanup");
    }
    assert.equal(manager.getActiveCount(), 0);
  });

  it("isolates ten Quest producers and cleans every stream", async () => {
    const manager = createCastManager({ maxConcurrentCasts: 10, maxViewersPerCast: 2, noViewerStopMs: 1, termGraceMs: 1, killGraceMs: 1 });
    const outputs = new Map<string, EventEmitter>();
    const children = new Map<string, FakeChild>();
    for (let index = 0; index < 10; index += 1) {
      const key = `QUEST-${index}`;
      outputs.set(key, new EventEmitter());
      children.set(key, new FakeChild());
      attach(manager, key, () => ({ output: outputs.get(key), processes: [children.get(key)] }));
    }
    assert.equal(manager.getActiveCount(), 10);
    outputs.get("QUEST-0")!.emit("error", new Error("one Quest crashed"));
    await manager.stopAll("test_cleanup");
    assert.equal(manager.getActiveCount(), 0);
    assert.equal([...children.values()].every((child) => child.signals.includes("SIGTERM")), true);
  });
});
