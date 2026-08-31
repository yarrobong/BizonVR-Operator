import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createWebAuthToken } from "../src/backend/auth";
import { createSession, getPermissionActor, listCommands, updateCommandStatus } from "../src/backend/database";

process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "stage-2-test-secret";
process.env.HUB_TOKENS_JSON = JSON.stringify({ "1": "hub-a-secret", "2": "hub-b-secret" });
process.env.SEED_MOCK_DEVICE = "1";
delete process.env.ALLOW_DEV_AUTH_FALLBACK;
delete process.env.ALLOW_DEV_HUB_AUTH_FALLBACK;

const { app, db } = await import("../server");
let server: ReturnType<typeof app.listen>;
let baseUrl = "";

async function request(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { response, body: await response.json() };
}

describe("Web API authentication boundary", () => {
  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => server.close());

  it("rejects anonymous and invalid production-style API requests", async () => {
    assert.equal((await request("/api/devices")).response.status, 401);
    assert.equal((await request("/api/devices", { Authorization: "Bearer invalid" })).response.status, 401);
  });

  it("rejects an expired signed token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = createWebAuthToken(1, process.env.AUTH_SECRET, now - 120, 60);
    assert.equal((await request("/api/devices", { Authorization: `Bearer ${expired}` })).response.status, 401);
  });

  it("uses the signed token subject and rejects inactive users", async () => {
    const valid = await request("/api/devices", { Authorization: `Bearer ${createWebAuthToken(1)}` });
    assert.equal(valid.response.status, 200);

    const disabledUser = db.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: number };
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(disabledUser.id);
    const denied = await request("/api/devices", { Authorization: `Bearer ${createWebAuthToken(disabledUser.id)}` });
    assert.equal(denied.response.status, 401);
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(disabledUser.id);
  });

  it("does not let x-user-id override the authenticated subject", async () => {
    const result = await request("/api/devices", {
      Authorization: `Bearer ${createWebAuthToken(1)}`,
      "x-user-id": "999999",
    });
    assert.equal(result.response.status, 200);
  });

  it("stores Agent provisioning intent without a raw credential", async () => {
    const response = await fetch(`${baseUrl}/api/devices/1/install_agent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${createWebAuthToken(1)}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { command_id: number };
    const row = db.prepare(`SELECT payload FROM device_commands WHERE id = ?`).get(body.command_id) as { payload: string };
    assert.match(row.payload, /"rotate_agent_credential":true/);
    assert.doesNotMatch(row.payload, /agent_token/);
  });

  it("returns 413 for an oversized JSON control request", async () => {
    const response = await fetch(`${baseUrl}/api/commands`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createWebAuthToken(1)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(70 * 1024) }),
    });
    assert.equal(response.status, 413);
  });

  it("binds each Cloud Hub transport request to its Hub token", async () => {
    const sync = async (authorization?: string) => fetch(`${baseUrl}/api/hubs/1/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: "{}",
    });
    assert.equal((await sync()).status, 401);
    assert.equal((await sync("Bearer wrong")).status, 401);
    assert.equal((await sync("Bearer hub-b-secret")).status, 401);
    assert.equal((await sync("Bearer hub-a-secret")).status, 200);
  });

  it("forwards Idempotency-Key for switch-app session actions", async () => {
    const actor = getPermissionActor(db, 1);
    assert.ok(actor);
    const sessionId = createSession(db, {
      title: "API switch-app test",
      roomId: 1,
      deviceIds: [1],
      appPackage: "com.bizonvr.spatialspike",
      durationMinutes: 30,
      actor,
      createdByUserId: 1,
    });
    const start = (listCommands(db) as Array<any>).find((command) => command.session_id === sessionId && command.type === "START_SESSION");
    assert.ok(start);
    updateCommandStatus(db, start.id, "accepted_by_hub");
    updateCommandStatus(db, start.id, "running");
    updateCommandStatus(db, start.id, "succeeded");

    const headers = {
      Authorization: `Bearer ${createWebAuthToken(1)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "switch-api-regression-1",
    };
    const first = await fetch(`${baseUrl}/api/sessions/${sessionId}/switch-app`, {
      method: "POST",
      headers,
      body: JSON.stringify({ app_package: "com.bizonvr.spatialspike" }),
    });
    const second = await fetch(`${baseUrl}/api/sessions/${sessionId}/switch-app`, {
      method: "POST",
      headers,
      body: JSON.stringify({ app_package: "com.bizonvr.spatialspike" }),
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((listCommands(db) as Array<any>).filter((command) => command.session_id === sessionId && command.type === "SWITCH_SESSION_APP").length, 1);
  });
});
