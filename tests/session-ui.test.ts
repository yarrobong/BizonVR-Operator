import { describe, it } from "node:test";
import assert from "node:assert";
import { formatRemainingTime, getSessionUiState } from "../src/lib/sessionUi";

describe("session UI helpers", () => {
  it("formats remaining time as mm:ss", () => {
    assert.strictEqual(formatRemainingTime(1782), "29:42");
    assert.strictEqual(formatRemainingTime(0), "00:00");
  });

  it("returns running controls for active sessions", () => {
    const state = getSessionUiState({
      session_id: 10,
      status: "running",
      remaining_seconds: 900,
      current_app_package: "com.example.game",
    });

    assert.deepStrictEqual(
      {
        canPause: state.canPause,
        canResume: state.canResume,
        canStop: state.canStop,
        canSwitch: state.canSwitch,
      },
      { canPause: true, canResume: false, canStop: true, canSwitch: true },
    );
  });

  it("returns paused controls for paused sessions", () => {
    const state = getSessionUiState({
      session_id: 11,
      status: "paused",
      remaining_seconds: 420,
      current_app_package: "com.example.game",
    });

    assert.deepStrictEqual(
      {
        canPause: state.canPause,
        canResume: state.canResume,
        canStop: state.canStop,
        canSwitch: state.canSwitch,
      },
      { canPause: false, canResume: true, canStop: true, canSwitch: true },
    );
  });
});
