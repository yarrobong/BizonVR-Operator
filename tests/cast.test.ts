import assert from "node:assert";
import { describe, it } from "node:test";
import { buildCastResponse } from "../src/backend/cast";
import {
  createStreamStopper,
  getFallbackResponseStrategy,
  resolveStreamRequest,
  safeEnd,
  safeWrite,
  safeWriteHead,
} from "../local-hub/streaming.js";

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "Quest 3 - Arena",
    status: "online",
    serial_number: "QUEST-CAST-01",
    adb_status: "online",
    local_hub_id: 3,
    wake_supported: true,
    wifi_ip: "192.168.1.50",
    next_operator_step: "Reconnect ADB if the cast does not start.",
    ...overrides,
  };
}

function makeHub(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    name: "Hub A",
    status: "online",
    host: "192.168.1.10",
    ...overrides,
  };
}

describe("cast response", () => {
  it("uses fmp4 as the default browser transport", () => {
    const result = buildCastResponse(makeDevice(), makeHub(), 3001, { now: 12345 });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.transport, "fmp4");
    assert.strictEqual(result.body.profile, "low-latency");
    assert.match(String(result.body.stream_url), /transport=fmp4/);
    assert.match(String(result.body.stream_url), /profile=low-latency/);
    assert.match(String(result.body.preview_url), /transport=mpjpeg/);
  });

  it("rejects browser cast when ADB is offline", () => {
    const result = buildCastResponse(makeDevice({ adb_status: "offline" }), makeHub(), 3001);
    assert.strictEqual(result.status, 409);
    assert.match(String(result.body.error), /ADB is offline/);
  });

  it("rejects browser cast when ADB route is port_closed", () => {
    const result = buildCastResponse(makeDevice({ adb_status: "port_closed" }), makeHub(), 3001);
    assert.strictEqual(result.status, 409);
    assert.match(String(result.body.error), /ADB is port closed/);
  });

  it("keeps MJPEG fallback available when requested explicitly", () => {
    const result = buildCastResponse(makeDevice(), makeHub(), 3001, {
      transport: "mpjpeg",
      profile: "performance",
      now: 555,
    });
    assert.strictEqual(result.status, 200);
    assert.match(String(result.body.stream_url), /transport=mpjpeg/);
    assert.match(String(result.body.stream_url), /profile=performance/);
  });

  it("returns a clear error for unknown transport requests", () => {
    const result = buildCastResponse(makeDevice(), makeHub(), 3001, { transport: "mystery" });
    assert.strictEqual(result.status, 400);
    assert.match(String(result.body.error), /Unknown cast transport/);
  });
});

describe("local hub cast helpers", () => {
  it("rejects unknown stream transports before spawning adb", () => {
    const result = resolveStreamRequest("mystery", "low-latency");
    assert.strictEqual(result.ok, false);
    if (result.ok) {
      throw new Error("expected a rejected request");
    }
    assert.strictEqual(result.status, 400);
    assert.match(String(result.body.message), /Unknown cast transport/);
  });

  it("stops adb and ffmpeg exactly once on stream cleanup", () => {
    const signals: string[] = [];
    const proc = () => ({
      killed: false,
      kill(signal: string) {
        signals.push(signal);
        this.killed = true;
      },
    });

    let clearCalls = 0;
    let stopCalls = 0;
    const stopper = createStreamStopper({
      adbProc: proc(),
      ffmpegProc: proc(),
      clearBootTimer: () => {
        clearCalls += 1;
      },
      onStop: () => {
        stopCalls += 1;
      },
    });

    assert.strictEqual(stopper.stop("client_disconnect"), true);
    assert.strictEqual(stopper.stop("client_disconnect"), false);
    assert.deepStrictEqual(signals, ["SIGTERM", "SIGTERM"]);
    assert.strictEqual(clearCalls, 1);
    assert.strictEqual(stopCalls, 1);
  });

  it("allows inline fallback before headers are sent", () => {
    assert.strictEqual(
      getFallbackResponseStrategy({
        headersSent: false,
        destroyed: false,
        writableEnded: false,
      }),
      "inline",
    );
  });

  it("does not try to restart headers after headers were sent", () => {
    assert.strictEqual(
      getFallbackResponseStrategy({
        headersSent: true,
        destroyed: false,
        writableEnded: false,
      }),
      "close",
    );
  });

  it("avoids writes when the response is already closed", () => {
    const res = {
      headersSent: false,
      destroyed: true,
      writableEnded: true,
      writeHeadCalled: false,
      writeCalled: false,
      endCalled: false,
      writeHead() {
        this.writeHeadCalled = true;
      },
      write() {
        this.writeCalled = true;
      },
      end() {
        this.endCalled = true;
      },
    };

    assert.strictEqual(safeWriteHead(res, 200, {}), false);
    assert.strictEqual(safeWrite(res, "hello"), false);
    assert.strictEqual(safeEnd(res), false);
    assert.strictEqual(res.writeHeadCalled, false);
    assert.strictEqual(res.writeCalled, false);
    assert.strictEqual(res.endCalled, false);
  });
});
