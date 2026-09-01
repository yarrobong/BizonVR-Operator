import { Router } from "express";
import { buildCastResponse as buildCastResponsePayload } from "../../cast";
import { markDevicePairing } from "../../repositories/devices";
import { assignDeviceToRoom, dismissHelpRequest, listDevices, listDevicesForHub } from "../../services/device-service";
import { createDeviceCommand } from "../../services/command-service";
import { getLatestAppVersionForPackage } from "../../repositories/apps";
import { listLocalHubs } from "../../repositories/hubs";
import { handleApiError } from "../errors";
import type { RouteContext } from "./types";

function buildHealthCheck(device: any) {
  const connectionStatus = String(device.connection_status || "unknown_error");
  const whatWorks: string[] = [];
  const whatFailed: string[] = [];
  if (device.adb_status === "online") whatWorks.push("ADB route is available");
  else whatFailed.push(`ADB is ${String(device.adb_status || "unavailable").replace(/_/g, " ")}`);
  if (device.agent_status === "online") whatWorks.push("Quest Agent heartbeat is arriving");
  else whatFailed.push("Quest Agent heartbeat is missing");
  if (device.wifi_ip) whatWorks.push(`Known Wi-Fi route: ${device.wifi_ip}`);
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
  return { connection_status: connectionStatus, what_works: whatWorks, what_failed: whatFailed, probable_cause: probableCause, next_step: nextStep, summary: `Quest ${device.name} is ${connectionStatus.replace(/_/g, " ")}.` };
}

export function createDevicesRouter({ db, getActor, localHubStreamPort = 3001, questAgentPackage = "com.bizonvr.spatialspike" }: RouteContext) {
  const router = Router();
  const findDevice = (req: any) => listDevices(db, getActor(req)).find((item: any) => item.id === Number(req.params.id)) as any;
  const castResult = (deviceId: number, actor: ReturnType<typeof getActor>, options?: { transport?: string | null; profile?: string | null }) => {
    const device = listDevices(db, actor).find((item: any) => item.id === deviceId) as Record<string, unknown> | undefined;
    const hub = listLocalHubs(db, actor).find((item: any) => item.id === Number(device?.local_hub_id)) as { id: number; name: string; status: string; host: string | null } | undefined;
    return buildCastResponsePayload(device as any, hub, localHubStreamPort, options);
  };

  router.get("/devices", (req, res) => {
    if (req.header("x-hub-id")) return res.json(listDevicesForHub(db, Number(req.header("x-hub-id"))));
    return res.json(listDevices(db, getActor(req)));
  });
  router.get("/devices/:id/cast", (req, res) => {
    const result = castResult(Number(req.params.id), getActor(req), { transport: typeof req.query.transport === "string" ? req.query.transport : null, profile: typeof req.query.profile === "string" ? req.query.profile : null });
    return res.status(result.status).json(result.body);
  });
  router.get("/devices/:id/apps", (req, res) => {
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    try { return res.json(JSON.parse(String(device.installed_apps ?? "[]"))); } catch { return res.json([]); }
  });
  router.post("/devices/:id/assign", (req, res) => {
    const roomId = Number(req.body.room_id);
    if (!roomId) return res.status(400).json({ error: "room_id is required" });
    try { assignDeviceToRoom(db, Number(req.params.id), roomId, getActor(req)); return res.json({ success: true }); } catch (error) { return handleApiError(res, error); }
  });
  router.post("/devices/:id/pair", (req, res) => {
    const deviceId = Number(req.params.id);
    const roomId = Number(req.body.room_id);
    const requestedName = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.local_hub_id) return res.status(409).json({ error: "No Local Hub assigned to this device" });
    if (!roomId) return res.status(400).json({ error: "room_id is required" });
    try {
      const actor = getActor(req);
      assignDeviceToRoom(db, deviceId, roomId, actor);
      markDevicePairing(db, deviceId, requestedName);
      const appVersion = getLatestAppVersionForPackage(db, questAgentPackage);
      const commandIds: number[] = [];
      if (appVersion?.apk_checksum) commandIds.push(createDeviceCommand(db, { localHubId: Number(device.local_hub_id), deviceId, type: "INSTALL_APK", actor, payload: { target: "quest_agent", package_name: questAgentPackage, app_version_id: appVersion.id, artifact_id: `quest-agent-${appVersion.id}`, version_name: appVersion.version_name, version_code: appVersion.version_code, apk_checksum: appVersion.apk_checksum, download_url: appVersion.download_url, pairing_id: device.pairing_id || null, rotate_agent_credential: true } }));
      commandIds.push(createDeviceCommand(db, { localHubId: Number(device.local_hub_id), deviceId, type: "REFRESH_STATUS", actor, payload: { reason: "first_pairing", repair_wireless: true, stable_serial: device.stable_id || device.serial_number, usb_serial: device.serial_number, pairing_id: device.pairing_id || null } }));
      return res.json({ success: true, command_ids: commandIds });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/devices/:id/repair", (req, res) => {
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.local_hub_id) return res.status(409).json({ error: "No Local Hub assigned to this device" });
    try {
      const commandId = createDeviceCommand(db, { localHubId: Number(device.local_hub_id), deviceId: Number(req.params.id), type: "REFRESH_STATUS", actor: getActor(req), payload: { reason: "usb_repair", repair_wireless: true, stable_serial: device.stable_id || device.serial_number, usb_serial: device.serial_number } });
      return res.json({ success: true, command_id: commandId });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/devices/:id/health-check", (req, res) => {
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    return res.json(buildHealthCheck(device));
  });
  router.delete("/devices/:id", (req, res) => {
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.local_hub_id) return res.status(409).json({ error: "No Local Hub assigned to this device", next_step: "Reconnect the Local Hub before removing this Quest from remembered devices." });
    const hub = listLocalHubs(db, getActor(req)).find((item: any) => item.id === Number(device.local_hub_id)) as { status?: string } | undefined;
    if (!hub || hub.status !== "online") return res.status(409).json({ error: "Local Hub is offline", state: "command_failed", next_step: "Bring the Local Hub online first. Forget Quest is confirmed by Local Hub because it must clear remembered routes before the database entry is removed." });
    try {
      const commandId = createDeviceCommand(db, { localHubId: Number(device.local_hub_id), deviceId: Number(req.params.id), type: "FORGET_DEVICE", actor: getActor(req), payload: { stable_serial: device.stable_id || device.serial_number, serial_number: device.serial_number, agent_id: device.agent_id || null } });
      return res.json({ success: true, command_id: commandId, message: "Quest removal queued. Local Hub will forget saved routes, then the device will be removed from inventory." });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/devices/:id/scrcpy", (req, res) => {
    const result = castResult(Number(req.params.id), getActor(req));
    return res.status(result.status).json({ ...result.body, legacy_endpoint: true, next_step: result.status === 200 ? "Use stream_url in the web panel. Separate scrcpy windows are disabled for this endpoint." : (result.body as { next_step?: string }).next_step });
  });
  router.post("/devices/:id/install_agent", (req, res) => {
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.local_hub_id) return res.status(409).json({ error: "No Local Hub assigned to this device" });
    const appVersion = getLatestAppVersionForPackage(db, questAgentPackage);
    if (!appVersion?.apk_checksum) return res.status(409).json({ error: "Quest Agent APK artifact is missing checksum metadata", state: "command_failed", next_step: "Upload/register the Quest Agent APK version with checksum before installing." });
    try {
      const commandId = createDeviceCommand(db, { localHubId: Number(device.local_hub_id), deviceId: Number(req.params.id), type: "INSTALL_APK", actor: getActor(req), payload: { target: "quest_agent", package_name: questAgentPackage, app_version_id: appVersion.id, artifact_id: `quest-agent-${appVersion.id}`, version_name: appVersion.version_name, version_code: appVersion.version_code, apk_checksum: appVersion.apk_checksum, download_url: appVersion.download_url, pairing_id: device.pairing_id || null, rotate_agent_credential: true } });
      return res.json({ success: true, command_id: commandId });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/devices/:id/wake", (req, res) => {
    const device = findDevice(req);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.local_hub_id) return res.status(409).json({ error: "No Local Hub assigned to this device", next_step: "Assign the headset to an online Local Hub before waking it over Wi-Fi." });
    try { const commandId = createDeviceCommand(db, { localHubId: Number(device.local_hub_id), deviceId: Number(req.params.id), type: "REFRESH_STATUS", actor: getActor(req), payload: { reason: "wake_device", wake_device: true } }); return res.json({ success: true, command_id: commandId }); } catch (error) { return handleApiError(res, error); }
  });
  router.post("/devices/:id/dismiss_help", (req, res) => {
    try { dismissHelpRequest(db, Number(req.params.id), getActor(req)); return res.json({ success: true }); } catch (error) { return handleApiError(res, error); }
  });
  return router;
}
