import { Router } from "express";
import { listCommands, createDeviceCommand, updateCommandStatus, cancelDeviceCommand, getCommandHubId } from "../../services/command-service";
import { assertHubRequest } from "../middleware/authentication";
import { handleApiError, statusFromError } from "../errors";
import type { RouteContext } from "./types";

export function createCommandsRouter({ db, getActor }: RouteContext) {
  const router = Router();
  router.get("/commands", (req, res) => res.json(listCommands(db, getActor(req))));
  router.post("/commands", (req, res) => {
    const { local_hub_id, device_id, type, payload } = req.body;
    if (!local_hub_id || !device_id || !type) return res.status(400).json({ error: "Missing required fields" });
    try {
      const commandId = createDeviceCommand(db, { localHubId: Number(local_hub_id), deviceId: Number(device_id), type, payload, actor: getActor(req) });
      return res.json({ id: commandId, status: "created" });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/commands/:id/status", (req, res) => {
    const commandId = Number(req.params.id);
    const { status, error_message } = req.body;
    if (!status) return res.status(400).json({ error: "status is required" });
    try {
      const requestedHubId = Number(req.body.hub_id);
      if (!Number.isInteger(requestedHubId) || requestedHubId <= 0) return res.status(400).json({ error: "hub_id is required" });
      assertHubRequest(req, requestedHubId);
      const command = getCommandHubId(db, commandId);
      if (!command) return res.status(404).json({ error: "Command not found" });
      if (requestedHubId !== command.local_hub_id) return res.status(403).json({ error: "Command belongs to another Local Hub" });
      const result = req.body.result && typeof req.body.result === "object" ? req.body.result : undefined;
      const updated = updateCommandStatus(db, commandId, String(status), error_message ? String(error_message) : null, {
        hubId: command.local_hub_id,
        hubInstanceId: req.body.hub_instance_id ? String(req.body.hub_instance_id) : null,
        claimToken: req.body.claim_token ? String(req.body.claim_token) : null,
        errorCode: req.body.error_code ? String(req.body.error_code) : null,
        outcomeState: req.body.outcome_state,
        result,
        route: req.body.route ? String(req.body.route) : null,
        reconciled: Boolean(req.body.reconciled),
        resultDeliveryAttempt: req.body.result_delivery_attempt ? Number(req.body.result_delivery_attempt) : null,
      });
      return res.json({ success: true, idempotent: Boolean((updated as any)?.idempotent) });
    } catch (error) { return handleApiError(res, error); }
  });
  router.post("/commands/:id/cancel", (req, res) => {
    try { return res.json(cancelDeviceCommand(db, Number(req.params.id), getActor(req))); } catch (error) { return handleApiError(res, error); }
  });
  return router;
}
