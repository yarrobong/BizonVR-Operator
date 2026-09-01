import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCatalogRouter } from "../src/backend/http/routes/catalog";
import { createDevicesRouter } from "../src/backend/http/routes/devices";
import { createCommandsRouter } from "../src/backend/http/routes/commands";
import { createSessionsRouter } from "../src/backend/http/routes/sessions";
import { createHubsRouter } from "../src/backend/http/routes/hubs";
import { createAuditRouter } from "../src/backend/http/routes/audit";

const context = { db: {} as any, getActor: (() => ({ userId: 1, organizationId: 1, role: "owner" as const, clubIds: [1] })) as any };

function inventory(router: any) {
  return router.stack
    .filter((layer: any) => layer.route)
    .flatMap((layer: any) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

describe("HTTP route contract", () => {
  it("keeps the Stage 2 API method/path inventory", () => {
    const actual = [
      "GET /api/health",
      ...[
        ...inventory(createCatalogRouter(context)),
        ...inventory(createDevicesRouter(context)),
        ...inventory(createCommandsRouter(context)),
        ...inventory(createSessionsRouter(context)),
        ...inventory(createHubsRouter(context)),
        ...inventory(createAuditRouter(context)),
      ].map((route) => route.replace(" /", " /api/")),
    ].sort();
    const expected = [
      "GET /api/health",
      "GET /clubs", "GET /branches", "GET /rooms", "GET /hubs",
      "GET /devices", "GET /devices/:id/cast", "GET /devices/:id/apps",
      "POST /devices/:id/assign", "POST /devices/:id/pair", "POST /devices/:id/repair",
      "POST /devices/:id/health-check", "DELETE /devices/:id", "POST /devices/:id/scrcpy",
      "POST /devices/:id/install_agent", "POST /devices/:id/wake", "POST /devices/:id/dismiss_help",
      "GET /commands", "POST /commands", "POST /commands/:id/status", "POST /commands/:id/cancel",
      "GET /sessions", "POST /sessions/start", "POST /sessions/:device_id/stop", "POST /sessions/:id/pause",
      "POST /sessions/:id/resume", "POST /sessions/:id/extend", "POST /sessions/:id/switch-app",
      "POST /hub/call_operator", "POST /agent/heartbeat", "POST /hubs/:id/sync", "GET /audit-logs",
    ].map((route) => route === "GET /api/health" ? route : route.replace(" /", " /api/")).sort();
    assert.deepEqual(actual, expected);
  });
});
