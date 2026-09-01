import { Router } from "express";
import { listSessions, createSession, finishActiveSessionForDevice, pauseSession, resumeSession, extendSession, switchSessionApp } from "../../services/session-service";
import { handleApiError } from "../errors";
import type { RouteContext } from "./types";

export function createSessionsRouter({ db, getActor }: RouteContext) {
  const router = Router();
  router.get("/sessions", (req, res) => res.json(listSessions(db, getActor(req))));
  router.post("/sessions/start", (req, res) => {
    const { device_id, device_ids, app_package, app_activity, duration_minutes, require_scrcpy, room_id, note } = req.body;
    const normalizedDeviceIds = Array.isArray(device_ids) ? device_ids.map((value: unknown) => Number(value)).filter(Boolean) : [Number(device_id)].filter(Boolean);
    if (!app_package || !duration_minutes || normalizedDeviceIds.length === 0) return res.status(400).json({ error: "device_id/device_ids, app_package and duration_minutes are required" });
    try {
      const actor = getActor(req);
      const sessionId = createSession(db, { title: `Session ${new Date().toISOString()}`, roomId: room_id ? Number(room_id) : null, deviceIds: normalizedDeviceIds, appPackage: String(app_package), appActivity: app_activity ? String(app_activity) : undefined, durationMinutes: Number(duration_minutes), requireScrcpy: Boolean(require_scrcpy), operatorNotes: note ? String(note) : undefined, createdByUserId: actor.userId, actor });
      return res.json({ success: true, session_id: sessionId });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/sessions/:device_id/stop", (req, res) => {
    try { const sessionId = finishActiveSessionForDevice(db, Number(req.params.device_id), getActor(req), { idempotencyKey: req.header("idempotency-key") }); return res.json({ success: Boolean(sessionId), session_id: sessionId }); } catch (error) { return handleApiError(res, error); }
  });
  router.post("/sessions/:id/pause", (req, res) => {
    try { return res.json({ success: true, session: pauseSession(db, Number(req.params.id), getActor(req), { idempotencyKey: req.header("idempotency-key") }) }); } catch (error) { return handleApiError(res, error); }
  });
  router.post("/sessions/:id/resume", (req, res) => {
    try { return res.json({ success: true, session: resumeSession(db, Number(req.params.id), getActor(req), { idempotencyKey: req.header("idempotency-key") }) }); } catch (error) { return handleApiError(res, error); }
  });
  router.post("/sessions/:id/extend", (req, res) => {
    const minutes = Number(req.body?.minutes ?? req.body?.extension_minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) return res.status(400).json({ error: "minutes must be a positive whole number" });
    try { return res.json({ success: true, session: extendSession(db, Number(req.params.id), minutes, getActor(req), { idempotencyKey: req.header("idempotency-key") }) }); } catch (error) { return handleApiError(res, error); }
  });
  router.post("/sessions/:id/switch-app", (req, res) => {
    const { app_package, app_activity } = req.body ?? {};
    if (!app_package) return res.status(400).json({ error: "app_package is required" });
    try { return res.json({ success: true, session: switchSessionApp(db, Number(req.params.id), { appPackage: String(app_package), appActivity: app_activity ? String(app_activity) : undefined, actor: getActor(req), idempotencyKey: req.header("idempotency-key") }) }); } catch (error) { return handleApiError(res, error); }
  });
  return router;
}
