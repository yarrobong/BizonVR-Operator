import { Router } from "express";
import { markOperatorCall } from "../../repositories/hubs";
import { syncHubState } from "../../services/hub-sync-service";
import { assertHubRequest } from "../middleware/authentication";
import { handleApiError, statusFromError } from "../errors";
import type { RouteContext } from "./types";

export function createHubsRouter({ db }: RouteContext) {
  const router = Router();
  router.post("/hub/call_operator", (req, res) => {
    const { pairing_id, hub_id } = req.body;
    if (!pairing_id || !hub_id) return res.status(400).json({ error: "Missing pairing_id or hub_id" });
    try {
      const hubId = Number(hub_id);
      assertHubRequest(req, hubId);
      markOperatorCall(db, String(pairing_id), hubId);
    } catch (error) { return handleApiError(res, error); }
    return res.json({ success: true });
  });
  router.post("/agent/heartbeat", (_req, res) => res.status(401).json({ error: "Agent heartbeat must be sent to the authenticated Local Hub" }));
  router.post("/hubs/:id/sync", (req, res) => {
    try {
      const hubId = Number(req.params.id);
      assertHubRequest(req, hubId);
      return res.json({ commands: syncHubState(db, hubId, req.body ?? {}) });
    } catch (error) {
      const resolved = statusFromError(error);
      return res.status(resolved.status).json(resolved.body);
    }
  });
  return router;
}
