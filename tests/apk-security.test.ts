import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveApprovedApk } from "../local-hub/apk-security.js";

describe("Local Hub APK artifact safety", () => {
  it("rejects traversal, absolute paths, and checksum mismatches before ADB", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-apk-"));
    let adbCalls = 0;
    const resolve = (payload: Record<string, unknown>) => resolveApprovedApk(payload, { root, sha256File: (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    try {
      assert.equal(resolve({ artifact_id: "../../outside", apk_checksum: "a".repeat(64) }).error, "A valid APK artifact_id is required");
      assert.equal(resolve({ artifact_id: "/tmp/outside.apk", apk_checksum: "a".repeat(64) }).error, "A valid APK artifact_id is required");
      fs.writeFileSync(path.join(root, "valid.apk"), "not-an-apk-but-a-cached-test-artifact");
      assert.equal(resolve({ artifact_id: "valid", apk_checksum: "a".repeat(64) }).errorCode, "APK_CHECKSUM_MISMATCH");
      assert.equal(adbCalls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a regular cached artifact only with its computed SHA-256", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bizonvr-apk-"));
    try {
      const file = path.join(root, "quest-agent-1.apk");
      fs.writeFileSync(file, "cached artifact");
      const checksum = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const result = resolveApprovedApk({ artifact_id: "quest-agent-1", apk_checksum: checksum }, { root, sha256File: (item: string) => crypto.createHash("sha256").update(fs.readFileSync(item)).digest("hex") });
      assert.equal(result.path, file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
