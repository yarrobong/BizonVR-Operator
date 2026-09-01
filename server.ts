import express from "express";
import type { Request } from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { createDatabase, seedDemoData, reconcileExpiredSessions } from "./src/backend/database";
import { apiAuthenticationMiddleware, getRequestActor } from "./src/backend/http/middleware/authentication";
import { apiErrorMiddleware } from "./src/backend/http/errors";
import { createCatalogRouter } from "./src/backend/http/routes/catalog";
import { createDevicesRouter } from "./src/backend/http/routes/devices";
import { createCommandsRouter } from "./src/backend/http/routes/commands";
import { createSessionsRouter } from "./src/backend/http/routes/sessions";
import { createHubsRouter } from "./src/backend/http/routes/hubs";
import { createAuditRouter } from "./src/backend/http/routes/audit";

const app = express();
const PORT = 3000;
const SHOULD_SEED_MOCK_DEVICE = process.env.SEED_MOCK_DEVICE === "1";
const LOCAL_HUB_STREAM_PORT = Number(process.env.HUB_PORT ?? "3001");
const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || "com.bizonvr.spatialspike";

app.use(cors());
app.use(express.json({ limit: process.env.API_JSON_LIMIT || "64kb", strict: true }));

const db = createDatabase(process.env.DATABASE_PATH ?? ":memory:");
seedDemoData(db, { seedMockDevice: SHOULD_SEED_MOCK_DEVICE });
const sessionExpiryTimer = setInterval(() => {
  try {
    reconcileExpiredSessions(db);
  } catch (error) {
    console.error("[SessionEngine] expiry reconciliation failed", error);
  }
}, 5000);
sessionExpiryTimer.unref?.();

const routeContext = {
  db,
  getActor: (req: Request) => getRequestActor(req, db),
  localHubStreamPort: LOCAL_HUB_STREAM_PORT,
  questAgentPackage: QUEST_AGENT_PACKAGE,
};

app.use("/api", apiAuthenticationMiddleware(db));
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", database: "sqlite-dev", command_transport: "device_commands_via_local_hub" });
});
app.use("/api", createCatalogRouter(routeContext));
app.use("/api", createDevicesRouter(routeContext));
app.use("/api", createCommandsRouter(routeContext));
app.use("/api", createSessionsRouter(routeContext));
app.use("/api", createHubsRouter(routeContext));
app.use("/api", createAuditRouter(routeContext));
app.use(apiErrorMiddleware);

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

export { app, db };

if (process.env.NODE_ENV !== "test") startServer();
