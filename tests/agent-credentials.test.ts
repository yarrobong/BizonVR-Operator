import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentCredential, buildAgentCredentialRecord, buildAgentProvisioningResult } from "../local-hub/agent-credentials.js";
import { createAdbProcessRunner } from "../local-hub/adb-process-runner.js";
import { createFakeAdbState } from "./helpers/fake-adb.js";

describe("Local Hub Agent credential provisioning", () => {
  it("generates a high-entropy credential, provisions it through fake ADB, and reports only its hash", async () => {
    const first = createAgentCredential();
    const second = createAgentCredential();
    assert.equal(first.token.length, 43);
    assert.equal(first.tokenHash.length, 64);
    assert.notEqual(first.token, second.token);

    const record = buildAgentCredentialRecord("QUEST-01", { pairing_id: "PAIR-01" }, first);
    assert.equal(record.token, first.token);
    assert.equal(record.tokenHash, first.tokenHash);
    const result = buildAgentProvisioningResult(first);
    assert.deepEqual(result, { success: true, agent_token_hash: first.tokenHash });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(first.token));

    const fake = createFakeAdbState({ devices: [{ serial: "QUEST-01", status: "device" }] });
    try {
      const runner = createAdbProcessRunner({ executable: fake.executable, prefixArgs: fake.prefixArgs, defaultTimeoutMs: 500 });
      const install = await runner.run(["-s", "QUEST-01", "install", "-r", "cached-agent.apk"], { spawnOptions: fake.spawnOptions });
      const launch = await runner.run(["-s", "QUEST-01", "shell", "am", "start", "--es", "AGENT_TOKEN", first.token], { spawnOptions: fake.spawnOptions });
      assert.equal(install.ok, true);
      assert.equal(launch.ok, true);
      assert.match(JSON.stringify(record), /QUEST-01/);
    } finally {
      fake.cleanup();
    }
  });
});
