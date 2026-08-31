import express from "express";
import type { Request, Response } from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import {
  assignDeviceToRoom,
  createDatabase,
  createDeviceCommand,
  createSession,
  dismissHelpRequest,
  finishActiveSessionForDevice,
  getDefaultPermissionActor,
  getLatestAppVersionForPackage,
  getPermissionActor,
  listAuditLogs,
  listClubs,
  listCommands,
  listDevices,
  listLocalHubs,
  listRooms,
  listSessions,
  markOperatorCall,
  pauseSession,
  resumeSession,
  seedDemoData,
  switchSessionApp,
  syncHubState,
  updateCommandStatus,
} from "./src/backend/database";
import { buildCastResponse as buildCastResponsePayload } from "./src/backend/cast";

const app = express();
const PORT = 3000;
const SHOULD_SEED_MOCK_DEVICE = process.env.SEED_MOCK_DEVICE === "1";
const LOCAL_HUB_STREAM_PORT = Number(process.env.HUB_PORT ?? "3001");
const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || "com.bizonvr.spatialspike";

app.use(cors());
app.use(express.json());

const db = createDatabase(process.env.DATABASE_PATH ?? ":memory:");
seedDemoData(db, { seedMockDevice: SHOULD_SEED_MOCK_DEVICE });

function getRequestActor(req: Request) {
  const headerUserId = req.header("x-user-id");
  const actor = headerUserId
    ? getPermissionActor(db, Number(headerUserId))
    : (process.env.NODE_ENV === "production" ? null : getDefaultPermissionActor(db));
  if (!actor) {
    throw new HttpError(401, "Authentication required", "Sign in as an active club user before performing this action.");
  }
  return actor;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public nextStep?: string) {
    super(message);
  }
}

function statusFromError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: message, next_step: error.nextStep } };
  }
  if (message.startsWith("Permission denied")) {
    return { status: 403, body: { error: message, state: "permission_denied", next_step: "Ask an owner/admin to grant access for this club or action." } };
  }
  if (message.startsWith("Subscription blocked")) {
    return { status: 402, body: { error: message, state: "subscription_blocked", next_step: "Upgrade or reactivate the subscription before retrying." } };
  }
  if (message.startsWith("Preflight failed")) {
    return { status: 409, body: { error: message, state: "preflight_failed", next_step: "Fix the listed device readiness checks in Local Hub, then start again." } };
  }
  if (message.includes("not attached") || message.includes("offline") || message.includes("active session") || message.includes("transition")) {
    return { status: 409, body: { error: message, state: "command_failed", next_step: "Refresh device status and retry once Local Hub reports a healthy state." } };
  }
  return { status: 400, body: { error: message } };
}

function handleApiError(res: Response, error: unknown) {
  const result = statusFromError(error);
  return res.status(result.status).json(result.body);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", database: "sqlite-dev", command_transport: "device_commands_via_local_hub" });
});

app.get("/api/clubs", (_req, res) => {
  res.json(listClubs(db));
});

app.get("/api/branches", (_req, res) => {
  const clubs = listClubs(db).map((club: any) => ({
    id: club.id,
    club_id: club.id,
    name: club.name,
    organization_id: club.organization_id,
    status: club.status,
    timezone: club.timezone,
  }));
  res.json(clubs);
});

app.get("/api/rooms", (_req, res) => {
  res.json(listRooms(db));
});

app.get("/api/hubs", (_req, res) => {
  res.json(listLocalHubs(db));
});

app.get("/api/devices", (_req, res) => {
  res.json(listDevices(db));
});

function getCastResult(deviceId: number, options?: { transport?: string | null; profile?: string | null }) {
  const device = listDevices(db).find((item: any) => item.id === deviceId) as Record<string, unknown> | undefined;
  const hub = listLocalHubs(db).find((item: any) => item.id === Number(device?.local_hub_id)) as
    | { id: number; name: string; status: string; host: string | null }
    | undefined;
  return buildCastResponsePayload(device as any, hub, LOCAL_HUB_STREAM_PORT, options);
}

function buildHealthCheck(device: any) {
  const connectionStatus = String(device.connection_status || "unknown_error");
  const whatWorks = [];
  const whatFailed = [];

  if (device.adb_status === "online") {
    whatWorks.push("ADB route is available");
  } else {
    whatFailed.push(`ADB is ${String(device.adb_status || "unavailable").replace(/_/g, " ")}`);
  }

  if (device.agent_status === "online") {
    whatWorks.push("Quest Agent heartbeat is arriving");
  } else {
    whatFailed.push("Quest Agent heartbeat is missing");
  }

  if (device.wifi_ip) {
    whatWorks.push(`Known Wi-Fi route: ${device.wifi_ip}`);
  }

  let probableCause = String(device.status_reason || "Local Hub has not reported a detailed diagnosis yet.");
  let nextStep = String(device.next_operator_step || "Refresh diagnostics or connect the headset over USB.");

  if (connectionStatus === "vpn_or_lan_blocked") {
    probableCause = "Quest is known to the system, but its saved Wi-Fi ADB route is unreachable. VPN, LAN isolation, changed IP, or Wi-Fi ADB reset are likely causes.";
    nextStep = "Disconnect VPN or allow local LAN traffic. If it still does not recover, connect USB and run USB Repair.";
  } else if (connectionStatus === "agent_online_adb_offline") {
    probableCause = "Quest Agent is alive, but ADB transport is down.";
    nextStep = String(device.next_operator_step || "Use USB Repair to restore Wi-Fi ADB without adding the headset again.");
  } else if (connectionStatus === "adb_online_agent_offline" || connectionStatus === "wifi_ready") {
    probableCause = "ADB works, but Quest Agent is not reporting heartbeats.";
    nextStep = "Start or reinstall Quest Agent from the panel, then run the check again.";
  } else if (connectionStatus === "usb_unauthorized") {
    probableCause = "The headset is connected by USB, but USB debugging has not been authorized.";
    nextStep = "Put on the headset, accept the USB debugging prompt, and continue pairing.";
  }

  return {
    connection_status: connectionStatus,
    what_works: whatWorks,
    what_failed: whatFailed,
    probable_cause: probableCause,
    next_step: nextStep,
    summary: `Quest ${device.name} is ${connectionStatus.replace(/_/g, " ")}.`,
  };
}

app.get("/api/devices/:id/cast", (req, res) => {
  const result = getCastResult(Number(req.params.id), {
    transport: typeof req.query.transport === "string" ? req.query.transport : null,
    profile: typeof req.query.profile === "string" ? req.query.profile : null,
  });
  return res.status(result.status).json(result.body);
});

app.get("/api/devices/:id/apps", (req, res) => {
  const device = listDevices(db).find((item: any) => item.id === Number(req.params.id));
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  try {
    return res.json(JSON.parse(String(device.installed_apps ?? "[]")));
  } catch {
    return res.json([]);
  }
});

app.post("/api/devices/:id/assign", (req, res) => {
  const deviceId = Number(req.params.id);
  const roomId = Number(req.body.room_id);
  if (!roomId) {
    return res.status(400).json({ error: "room_id is required" });
  }

  try {
    assignDeviceToRoom(db, deviceId, roomId, getRequestActor(req));
    return res.json({ success: true });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/devices/:id/pair", (req, res) => {
  const deviceId = Number(req.params.id);
  const roomId = Number(req.body.room_id);
  const requestedName = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const device = listDevices(db).find((item: any) => item.id === deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }
  if (!device.local_hub_id) {
    return res.status(409).json({ error: "No Local Hub assigned to this device" });
  }
  if (!roomId) {
    return res.status(400).json({ error: "room_id is required" });
  }

  try {
    assignDeviceToRoom(db, deviceId, roomId, getRequestActor(req));
    db.prepare(`
      UPDATE devices
      SET
        name = COALESCE(NULLIF(?, ''), name),
        status = 'pairing_required',
        connection_status = CASE WHEN connection_status = 'new' THEN 'pairing_in_progress' ELSE connection_status END,
        next_operator_step = 'Wait for Local Hub to install Agent and enable Wi-Fi ADB.',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(requestedName || null, deviceId);

    const appVersion = getLatestAppVersionForPackage(db, QUEST_AGENT_PACKAGE);
    const commandIds: number[] = [];
    if (appVersion?.apk_checksum) {
      commandIds.push(createDeviceCommand(db, {
        localHubId: Number(device.local_hub_id),
        deviceId,
        type: "INSTALL_APK",
        actor: getRequestActor(req),
        payload: {
          target: "quest_agent",
          package_name: QUEST_AGENT_PACKAGE,
          app_version_id: appVersion.id,
          version_name: appVersion.version_name,
          version_code: appVersion.version_code,
          apk_checksum: appVersion.apk_checksum,
          download_url: appVersion.download_url,
        },
      }));
    }
    commandIds.push(createDeviceCommand(db, {
      localHubId: Number(device.local_hub_id),
      deviceId,
      type: "REFRESH_STATUS",
      actor: getRequestActor(req),
      payload: {
        reason: "first_pairing",
        repair_wireless: true,
        stable_serial: device.stable_id || device.serial_number,
        usb_serial: device.serial_number,
      },
    }));

    return res.json({ success: true, command_ids: commandIds });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/devices/:id/repair", (req, res) => {
  const deviceId = Number(req.params.id);
  const device = listDevices(db).find((item: any) => item.id === deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }
  if (!device.local_hub_id) {
    return res.status(409).json({ error: "No Local Hub assigned to this device" });
  }

  try {
    const commandId = createDeviceCommand(db, {
      localHubId: Number(device.local_hub_id),
      deviceId,
      type: "REFRESH_STATUS",
      actor: getRequestActor(req),
      payload: {
        reason: "usb_repair",
        repair_wireless: true,
        stable_serial: device.stable_id || device.serial_number,
        usb_serial: device.serial_number,
      },
    });
    return res.json({ success: true, command_id: commandId });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/devices/:id/health-check", (req, res) => {
  const deviceId = Number(req.params.id);
  const device = listDevices(db).find((item: any) => item.id === deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  return res.json(buildHealthCheck(device));
});

app.delete("/api/devices/:id", (req, res) => {
  const deviceId = Number(req.params.id);
  const device = listDevices(db).find((item: any) => item.id === deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }
  if (!device.local_hub_id) {
    return res.status(409).json({
      error: "No Local Hub assigned to this device",
      next_step: "Reconnect the Local Hub before removing this Quest from remembered devices.",
    });
  }
  const hub = listLocalHubs(db).find((item: any) => item.id === Number(device.local_hub_id)) as { status?: string } | undefined;
  if (!hub || hub.status !== "online") {
    return res.status(409).json({
      error: "Local Hub is offline",
      state: "command_failed",
      next_step: "Bring the Local Hub online first. Forget Quest is confirmed by Local Hub because it must clear remembered routes before the database entry is removed.",
    });
  }

  try {
    const commandId = createDeviceCommand(db, {
      localHubId: Number(device.local_hub_id),
      deviceId,
      type: "FORGET_DEVICE",
      actor: getRequestActor(req),
      payload: {
        stable_serial: device.stable_id || device.serial_number,
        serial_number: device.serial_number,
        agent_id: device.agent_id || null,
      },
    });

    return res.json({
      success: true,
      command_id: commandId,
      message: "Quest removal queued. Local Hub will forget saved routes, then the device will be removed from inventory.",
    });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/devices/:id/scrcpy", (req, res) => {
  const result = getCastResult(Number(req.params.id));
  return res.status(result.status).json({
    ...result.body,
    legacy_endpoint: true,
    next_step: result.status === 200
      ? "Use stream_url in the web panel. Separate scrcpy windows are disabled for this endpoint."
      : (result.body as { next_step?: string }).next_step,
  });
});

app.post("/api/devices/:id/install_agent", (req, res) => {
  const deviceId = Number(req.params.id);
  const device = listDevices(db).find((item: any) => item.id === deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }
  if (!device.local_hub_id) {
    return res.status(409).json({ error: "No Local Hub assigned to this device" });
  }
  const appVersion = getLatestAppVersionForPackage(db, QUEST_AGENT_PACKAGE);
  if (!appVersion?.apk_checksum) {
    return res.status(409).json({
      error: "Quest Agent APK artifact is missing checksum metadata",
      state: "command_failed",
      next_step: "Upload/register the Quest Agent APK version with checksum before installing.",
    });
  }

  try {
    const commandId = createDeviceCommand(db, {
      localHubId: Number(device.local_hub_id),
      deviceId,
      type: "INSTALL_APK",
      actor: getRequestActor(req),
      payload: {
        target: "quest_agent",
        package_name: QUEST_AGENT_PACKAGE,
        app_version_id: appVersion.id,
        version_name: appVersion.version_name,
        version_code: appVersion.version_code,
        apk_checksum: appVersion.apk_checksum,
        download_url: appVersion.download_url,
      },
    });

    return res.json({ success: true, command_id: commandId });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/devices/:id/wake", (req, res) => {
  const deviceId = Number(req.params.id);
  const device = listDevices(db).find((item: any) => item.id === deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }
  if (!device.local_hub_id) {
    return res.status(409).json({
      error: "No Local Hub assigned to this device",
      next_step: "Assign the headset to an online Local Hub before waking it over Wi-Fi.",
    });
  }

  try {
    const commandId = createDeviceCommand(db, {
      localHubId: Number(device.local_hub_id),
      deviceId,
      type: "REFRESH_STATUS",
      actor: getRequestActor(req),
      payload: {
        reason: "wake_device",
        wake_device: true,
      },
    });

    return res.json({ success: true, command_id: commandId });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.get("/api/commands", (_req, res) => {
  res.json(listCommands(db));
});

app.post("/api/commands", (req, res) => {
  const { local_hub_id, device_id, type, payload } = req.body;
  if (!local_hub_id || !device_id || !type) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const commandId = createDeviceCommand(db, {
      localHubId: Number(local_hub_id),
      deviceId: Number(device_id),
      type,
      payload,
      actor: getRequestActor(req),
    });
    return res.json({ id: commandId, status: "created" });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions(db));
});

app.post("/api/sessions/start", (req, res) => {
  const { device_id, device_ids, app_package, app_activity, duration_minutes, require_scrcpy, room_id, note } = req.body;
  const normalizedDeviceIds = Array.isArray(device_ids)
    ? device_ids.map((value: unknown) => Number(value)).filter(Boolean)
    : [Number(device_id)].filter(Boolean);

  if (!app_package || !duration_minutes || normalizedDeviceIds.length === 0) {
    return res.status(400).json({ error: "device_id/device_ids, app_package and duration_minutes are required" });
  }

  try {
    const sessionId = createSession(db, {
      title: `Session ${new Date().toISOString()}`,
      roomId: room_id ? Number(room_id) : null,
      deviceIds: normalizedDeviceIds,
      appPackage: String(app_package),
      appActivity: app_activity ? String(app_activity) : undefined,
      durationMinutes: Number(duration_minutes),
      requireScrcpy: Boolean(require_scrcpy),
      operatorNotes: note ? String(note) : undefined,
      createdByUserId: getRequestActor(req).userId,
      actor: getRequestActor(req),
    });

    return res.json({ success: true, session_id: sessionId });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/sessions/:device_id/stop", (req, res) => {
  try {
    const deviceId = Number(req.params.device_id);
    const sessionId = finishActiveSessionForDevice(db, deviceId, getRequestActor(req));
    return res.json({ success: Boolean(sessionId), session_id: sessionId });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/sessions/:id/pause", (req, res) => {
  try {
    const summary = pauseSession(db, Number(req.params.id), getRequestActor(req));
    return res.json({ success: true, session: summary });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/sessions/:id/resume", (req, res) => {
  try {
    const summary = resumeSession(db, Number(req.params.id), getRequestActor(req));
    return res.json({ success: true, session: summary });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/sessions/:id/switch-app", (req, res) => {
  const { app_package, app_activity } = req.body ?? {};
  if (!app_package) {
    return res.status(400).json({ error: "app_package is required" });
  }

  try {
    const summary = switchSessionApp(db, Number(req.params.id), {
      appPackage: String(app_package),
      appActivity: app_activity ? String(app_activity) : undefined,
      actor: getRequestActor(req),
    });
    return res.json({ success: true, session: summary });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/hub/call_operator", (req, res) => {
  const { pairing_id } = req.body;
  if (!pairing_id) {
    return res.status(400).json({ error: "Missing pairing_id" });
  }

  markOperatorCall(db, String(pairing_id));
  return res.json({ success: true });
});

app.post("/api/devices/:id/dismiss_help", (req, res) => {
  try {
    dismissHelpRequest(db, Number(req.params.id), getRequestActor(req));
    return res.json({ success: true });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.post("/api/agent/heartbeat", (_req, res) => {
  res.json({ success: true });
});

app.post("/api/hubs/:id/sync", (req, res) => {
  try {
    const commands = syncHubState(db, Number(req.params.id), req.body ?? {});
    return res.json({ commands });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Hub sync failed" });
  }
});

app.post("/api/commands/:id/status", (req, res) => {
  const commandId = Number(req.params.id);
  const { status, error_message } = req.body;
  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }

  try {
    updateCommandStatus(db, commandId, String(status), error_message ? String(error_message) : null);
    return res.json({ success: true });
  } catch (error) {
    return handleApiError(res, error);
  }
});

app.get("/api/audit-logs", (_req, res) => {
  res.json(listAuditLogs(db));
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
